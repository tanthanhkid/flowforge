/**
 * SPEC-step32.md B1 — attachments (server side): `MessagesRepo`'s new
 * `attachments` column round-trip, `POST /api/conversations/:id/messages`'s
 * additive `attachments` body field + validation, and `runChatTurn`
 * appending the "[Đính kèm...]" note to the LLM-facing content (current turn
 * AND prior history) while persisting `content` verbatim in the DB.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { runChatTurn, type ChatTurnDeps } from '../src/agent/chatTurn.js';
import { ChangesRepo } from '../src/db/changes.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { MessagesRepo, type MessageAttachment } from '../src/db/messages.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import { emptyWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

function chatResponse(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { content } }] });
}

function requestBodyOf(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex: number,
): { messages: Array<{ role: string; content: string }> } {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) throw new Error(`fetch was not called (call #${callIndex})`);
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('MessagesRepo attachments (SPEC-step32.md B1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(emptyWorkflow('wf-1', ''));
    new ConversationsRepo(db).create({ id: 'c1', workflowId: 'wf-1' });
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips attachments through create()/get()/listByConversation()', () => {
    const repo = new MessagesRepo(db);
    const attachments: MessageAttachment[] = [
      { path: 'uploads/a1.png', filename: 'photo.png', mime: 'image/png' },
      { path: 'uploads/a2.jpg' },
    ];
    const created = repo.create({ id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', attachments });
    expect(created.attachments).toEqual(attachments);
    expect(repo.get('m1')?.attachments).toEqual(attachments);
    expect(repo.listByConversation('c1')[0]?.attachments).toEqual(attachments);
  });

  it('attachments is undefined (not an empty array) when omitted', () => {
    const repo = new MessagesRepo(db);
    const created = repo.create({ id: 'm1', conversationId: 'c1', role: 'user', content: 'hi' });
    expect(created.attachments).toBeUndefined();
    expect(repo.get('m1')?.attachments).toBeUndefined();
  });

  it('persists content verbatim — never the LLM-facing "[Đính kèm...]" note', () => {
    const repo = new MessagesRepo(db);
    const created = repo.create({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'vẽ giúp mình theo ảnh này',
      attachments: [{ path: 'uploads/ref.png' }],
    });
    expect(created.content).toBe('vẽ giúp mình theo ảnh này');
    expect(repo.get('m1')?.content).toBe('vẽ giúp mình theo ảnh này');
  });
});

describe('POST /api/conversations/:id/messages attachments validation (SPEC-step32.md B1)', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step32-attach-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp });
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] }))) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function createConversation(): Promise<{ id: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    return (res.json() as { conversation: { id: string } }).conversation;
  }

  it('202 + round-trips through GET :id when attachments are valid upload paths (<=3)', async () => {
    const conv = await createConversation();
    const attachments = [{ path: 'uploads/abc-123.png', filename: 'x.png', mime: 'image/png' }, { path: 'uploads/def.jpeg' }];
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'ghép ảnh này vào workflow', attachments },
    });
    expect(res.statusCode).toBe(202);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
    const messages = (detail.json() as { messages: Array<{ role: string; attachments?: unknown }> }).messages;
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.attachments).toEqual(attachments);
  });

  it('omitting attachments entirely behaves exactly as before (no field, no 400)', async () => {
    const conv = await createConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'chỉ text thôi' },
    });
    expect(res.statusCode).toBe(202);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
    const messages = (detail.json() as { messages: Array<{ role: string; attachments?: unknown }> }).messages;
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.attachments).toBeUndefined();
  });

  it('400 when attachments has more than 3 elements', async () => {
    const conv = await createConversation();
    const attachments = Array.from({ length: 4 }, (_, i) => ({ path: `uploads/img-${i}.png` }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'hi', attachments },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when an attachment path has a disallowed extension', async () => {
    const conv = await createConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'hi', attachments: [{ path: 'uploads/doc.pdf' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when an attachment path attempts traversal outside uploads/', async () => {
    const conv = await createConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'hi', attachments: [{ path: 'uploads/../../etc/passwd.png' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when an attachment path is missing the uploads/ prefix', async () => {
    const conv = await createConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'hi', attachments: [{ path: 'artifacts/img.png' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('runChatTurn — attachments note appended for the LLM only (SPEC-step32.md B1)', () => {
  let db: Database.Database;
  let workflows: WorkflowsRepo;
  let conversations: ConversationsRepo;
  let messages: MessagesRepo;
  let changes: ChangesRepo;
  let deps: ChatTurnDeps;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_DEFAULT_MODEL = 'test/dummy-model';

    db = openDb(':memory:');
    workflows = new WorkflowsRepo(db);
    conversations = new ConversationsRepo(db);
    messages = new MessagesRepo(db);
    changes = new ChangesRepo(db);
    deps = { registry: createDefaultRegistry(), workflows, conversations, messages, changes };

    workflows.create(emptyWorkflow('wf-1', ''));
    conversations.create({ id: 'c1', workflowId: 'wf-1' });
  });

  afterEach(() => {
    db.close();
  });

  it('appends the note to the current turn user content sent to the LLM, but persists content verbatim', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const attachments: MessageAttachment[] = [{ path: 'uploads/ref1.png' }, { path: 'uploads/ref2.jpg' }];
    await runChatTurn('c1', 'ghép giúp mình 2 ảnh này', deps, attachments);

    const body = requestBodyOf(fetchMock, 0);
    const lastUserMsg = body.messages[body.messages.length - 1]!;
    expect(lastUserMsg.role).toBe('user');
    expect(lastUserMsg.content).toBe(
      'ghép giúp mình 2 ảnh này\n\n[Đính kèm 2 ảnh đã upload sẵn: uploads/ref1.png, uploads/ref2.jpg. Khi cần đưa ảnh vào workflow, tạo node input.image với params.path = path tương ứng.]',
    );

    const stored = messages.listByConversation('c1').find((m) => m.role === 'user')!;
    expect(stored.content).toBe('ghép giúp mình 2 ảnh này');
    expect(stored.attachments).toEqual(attachments);
  });

  it('no attachments -> no note appended (byte-identical to the plain content)', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runChatTurn('c1', 'chỉ hỏi thôi', deps);

    const body = requestBodyOf(fetchMock, 0);
    const lastUserMsg = body.messages[body.messages.length - 1]!;
    expect(lastUserMsg.content).toBe('chỉ hỏi thôi');
  });

  it('a PRIOR message with attachments still carries the note in history on a later turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ reply: 'đã nhận ảnh', ops: [] })))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ reply: 'ok tiếp', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runChatTurn('c1', 'đây là ảnh mẫu', deps, [{ path: 'uploads/ref1.png' }]);
    await runChatTurn('c1', 'giờ tạo workflow đi', deps);

    const secondBody = requestBodyOf(fetchMock, 1);
    const historyEntry = secondBody.messages.find((m) => m.role === 'user' && m.content.startsWith('đây là ảnh mẫu'));
    expect(historyEntry?.content).toContain('[Đính kèm 1 ảnh đã upload sẵn: uploads/ref1.png');
  });

  it('the note is also present on the 2nd (rebuilt) prompt after a version conflict', async () => {
    const aiOps = [{ op: 'add-node', node: { id: 'ai-node', type: 'input.text', params: {} } }];
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        const { applyPatch } = await import('../src/agent/patch.js');
        const manual = applyPatch(workflows.get('wf-1')!, [
          { op: 'add-node', node: { id: 'manual-node', type: 'input.text', params: {} } },
        ]);
        workflows.saveVersioned(manual, workflows.getVersion('wf-1'));
      }
      return chatResponse(JSON.stringify({ reply: 'ok', ops: aiOps }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runChatTurn('c1', 'thêm 1 node input.text theo ảnh này', deps, [{ path: 'uploads/x.gif' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = requestBodyOf(fetchMock, 1);
    const lastUserMsg = secondBody.messages[secondBody.messages.length - 1]!;
    expect(lastUserMsg.content).toContain('[Đính kèm 1 ảnh đã upload sẵn: uploads/x.gif');
  });
});
