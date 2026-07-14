/**
 * SPEC-step32.md B4 — AI-suggested conversation titles: `ConversationsRepo.rename`'s
 * new required `source` argument + `conversations.title_source` column,
 * `ChatTurnResponseSchema`'s optional `title` field, `buildChatSystemPrompt`'s
 * additive `titleHint` param (byte-identical when absent — same pattern as
 * `runSummary`, SPEC-step30.md §3), `runChatTurn` applying the title exactly
 * while `title_source !== 'user'`, and the SSE `message` event's additive
 * `title` field.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatTurn, type ChatTurnDeps } from '../src/agent/chatTurn.js';
import { buildChatSystemPrompt } from '../src/agent/promptBuilder.js';
import { applyPatch } from '../src/agent/patch.js';
import { ChangesRepo } from '../src/db/changes.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { MessagesRepo } from '../src/db/messages.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import { emptyWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';
import { buildServer } from '../src/server.js';

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

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String(input);
}

/** Same shape as api-conversations-sse.test.ts's own helper: only intercepts
 * the OpenRouter URL, letting everything else (in particular our own
 * loopback server) fall through to whatever `globalThis.fetch` already was
 * — test/setup.ts's beforeEach has already installed its loopback-aware
 * guard by the time this runs. */
function mockOpenRouter(handler: () => Response | Promise<Response>): void {
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (urlOf(input) === 'https://openrouter.ai/api/v1/chat/completions') {
      return handler();
    }
    return fallback(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
}

describe('ConversationsRepo.rename() — title_source (SPEC-step32.md B4)', () => {
  let db: Database.Database;
  let repo: ConversationsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(emptyWorkflow('wf-1', ''));
    repo = new ConversationsRepo(db);
    repo.create({ id: 'c1', workflowId: 'wf-1', title: 'Old' });
  });

  afterEach(() => {
    db.close();
  });

  it('a fresh conversation defaults to title_source "auto"', () => {
    expect(repo.get('c1')?.titleSource).toBe('auto');
  });

  it("rename(..., 'ai') sets both title and title_source", () => {
    repo.rename('c1', 'Tên do AI đặt', 'ai');
    const conv = repo.get('c1')!;
    expect(conv.title).toBe('Tên do AI đặt');
    expect(conv.titleSource).toBe('ai');
  });

  it("rename(..., 'user') sets title_source to 'user'", () => {
    repo.rename('c1', 'Tên do người dùng đặt', 'user');
    expect(repo.get('c1')?.titleSource).toBe('user');
  });
});

describe('buildChatSystemPrompt — titleHint (SPEC-step32.md B4)', () => {
  const registry = createDefaultRegistry();
  const workflow = emptyWorkflow('wf-1', '');

  it('titleHint absent is byte-identical to titleHint explicitly false', () => {
    const withoutArg = buildChatSystemPrompt(registry, workflow, '');
    const withFalse = buildChatSystemPrompt(registry, workflow, '', undefined, false);
    expect(withFalse).toBe(withoutArg);
  });

  it('titleHint true adds the "Đặt tên workflow" block and a title-aware output contract/fewshot', () => {
    const withHint = buildChatSystemPrompt(registry, workflow, '', undefined, true);
    const withoutHint = buildChatSystemPrompt(registry, workflow, '');

    expect(withHint).toContain('## Đặt tên workflow');
    expect(withHint).toContain('"title"');
    expect(withoutHint).not.toContain('## Đặt tên workflow');
    // the base contract text (no "title" field documented) must NOT appear
    // verbatim once the title-aware variant replaces it.
    expect(withHint.length).toBeGreaterThan(withoutHint.length);
  });
});

describe('runChatTurn — applying an AI-suggested title (SPEC-step32.md B4)', () => {
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

    workflows.create(emptyWorkflow('wf-1', 'Workflow mới'));
    conversations.create({ id: 'c1', workflowId: 'wf-1' }); // title_source defaults 'auto'
  });

  afterEach(() => {
    db.close();
  });

  it('ops branch: applies title to both the conversation (source "ai") and workflow.name before saveVersioned', async () => {
    const ops = [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } }];
    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ reply: 'Đã tạo.', ops, title: 'Caption quán cà phê' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onMessageCalls: Array<{ title?: string }> = [];
    const result = await runChatTurn('c1', 'tạo workflow', {
      ...deps,
      events: { onMessage: (p) => onMessageCalls.push({ title: p.title }) },
    });

    expect(result.title).toBe('Caption quán cà phê');
    expect(result.workflow.name).toBe('Caption quán cà phê');
    expect(onMessageCalls).toEqual([{ title: 'Caption quán cà phê' }]);

    const conv = conversations.get('c1')!;
    expect(conv.title).toBe('Caption quán cà phê');
    expect(conv.titleSource).toBe('ai');

    // persisted workflow (not just the in-memory returned copy) also renamed.
    expect(workflows.get('wf-1')?.name).toBe('Caption quán cà phê');
  });

  it('ops-empty branch: applies the title without touching the (untouched) workflow', async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ reply: 'Chào bạn!', ops: [], title: 'Trò chuyện linh tinh' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'chào', deps);

    expect(result.title).toBe('Trò chuyện linh tinh');
    expect(conversations.get('c1')?.title).toBe('Trò chuyện linh tinh');
    expect(conversations.get('c1')?.titleSource).toBe('ai');
    expect(workflows.get('wf-1')?.name).toBe('Workflow mới'); // untouched
  });

  it('no "title" in the LLM response -> conversation untouched, result.title is undefined', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'hi', deps);

    expect(result.title).toBeUndefined();
    expect(conversations.get('c1')?.title).toBe('');
    expect(conversations.get('c1')?.titleSource).toBe('auto');
  });

  it('conversation already title_source "user" -> titleHint is false, an LLM-returned title is ignored', async () => {
    conversations.rename('c1', 'Tên người dùng tự đặt', 'user');
    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ reply: 'ok', ops: [], title: 'AI muốn đổi tên' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'hi', deps);

    expect(result.title).toBeUndefined();
    const conv = conversations.get('c1')!;
    expect(conv.title).toBe('Tên người dùng tự đặt');
    expect(conv.titleSource).toBe('user');
  });

  it('B4 race: a user rename that lands while the LLM call is in flight is not overwritten by the AI title', async () => {
    // `titleHint` is computed from the conversation read at turn start
    // (title_source still 'auto' here), but the rename below runs INSIDE the
    // mocked `fetch` call — i.e. while the (only) `await chatCompletion(...)`
    // of this turn is "in flight", exactly like a PATCH .../rename landing
    // mid-turn. The fix re-reads `titleSource` right after the LLM response
    // comes back instead of trusting that turn-start snapshot.
    const fetchMock = vi.fn(async () => {
      conversations.rename('c1', 'Tên người dùng đặt giữa lượt', 'user');
      return chatResponse(JSON.stringify({ reply: 'ok', ops: [], title: 'AI muốn đổi tên' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'hi', deps);

    expect(result.title).toBeUndefined();
    const conv = conversations.get('c1')!;
    expect(conv.title).toBe('Tên người dùng đặt giữa lượt');
    expect(conv.titleSource).toBe('user');
  });

  it('B4 race (ops branch): a mid-turn user rename is respected — neither conversation nor workflow.name is overwritten', async () => {
    const ops = [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } }];
    const fetchMock = vi.fn(async () => {
      conversations.rename('c1', 'Tên người dùng đặt giữa lượt', 'user');
      return chatResponse(JSON.stringify({ reply: 'Đã tạo.', ops, title: 'AI muốn đổi tên' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'tạo workflow', deps);

    expect(result.title).toBeUndefined();
    expect(result.workflow.name).toBe('Workflow mới');
    const conv = conversations.get('c1')!;
    expect(conv.title).toBe('Tên người dùng đặt giữa lượt');
    expect(conv.titleSource).toBe('user');
    expect(workflows.get('wf-1')?.name).toBe('Workflow mới');
  });

  it('system prompt requests a title exactly while title_source !== "user"', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await runChatTurn('c1', 'hi', deps);
    expect(requestBodyOf(fetchMock, 0).messages[0]!.content).toContain('## Đặt tên workflow');

    conversations.rename('c1', 'Đã có tên', 'user');
    const fetchMock2 = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock2 as unknown as typeof fetch;
    await runChatTurn('c1', 'hi lại', deps);
    expect(requestBodyOf(fetchMock2, 0).messages[0]!.content).not.toContain('## Đặt tên workflow');
  });

  it('title is still offered/applied on the 2nd (rebuilt) attempt after a version conflict', async () => {
    const aiOps = [{ op: 'add-node', node: { id: 'ai-node', type: 'input.text', params: {} } }];
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        const manual = applyPatch(workflows.get('wf-1')!, [
          { op: 'add-node', node: { id: 'manual-node', type: 'input.text', params: {} } },
        ]);
        workflows.saveVersioned(manual, workflows.getVersion('wf-1'));
      }
      return chatResponse(JSON.stringify({ reply: 'ok', ops: aiOps, title: 'Tên sau rebuild' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'thêm 1 node input.text', deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyOf(fetchMock, 1).messages[0]!.content).toContain('## Đặt tên workflow');
    expect(result.title).toBe('Tên sau rebuild');
    expect(conversations.get('c1')?.titleSource).toBe('ai');
  });
});

describe('SSE message event carries title only when applied (SPEC-step32.md B4)', () => {
  let app: FastifyInstance;
  let tmp: string;
  let baseUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step32-title-sse-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, chatTurnPaceMs: () => 0 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  interface SseEvent {
    event: string;
    data: unknown;
  }

  async function collectSseEvents(url: string, timeoutMs = 5000): Promise<SseEvent[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new Error(`SSE request failed: ${res.status}`);
    }
    const collected: SseEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!chunk.trim() || chunk.startsWith(':')) continue;
          const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice('event: '.length);
          const data: unknown = JSON.parse(dataLine.slice('data: '.length));
          collected.push({ event, data });
          if (event === 'done') return collected;
        }
      }
      return collected;
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
  }

  it('includes title in the message event payload right after applying an AI-suggested title', async () => {
    mockOpenRouter(() => chatResponse(JSON.stringify({ reply: 'Đã tạo.', ops: [], title: 'Tên AI đặt qua SSE' })));

    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const conversation = ((await createRes.json()) as { conversation: { id: string } }).conversation;

    const msgRes = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'chào bạn' }),
    });
    const { assistantMessageId } = (await msgRes.json()) as { assistantMessageId: string };

    const events = await collectSseEvents(`${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`);
    const messageEvent = events.find((e) => e.event === 'message')!;
    expect((messageEvent.data as { title?: string }).title).toBe('Tên AI đặt qua SSE');
  });

  it('omits title from the message event payload when no title was applied', async () => {
    mockOpenRouter(() => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));

    const createRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const conversation = ((await createRes.json()) as { conversation: { id: string } }).conversation;

    const msgRes = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'chào bạn không tên' }),
    });
    const { assistantMessageId } = (await msgRes.json()) as { assistantMessageId: string };

    const events = await collectSseEvents(`${baseUrl}/api/conversations/${conversation.id}/turns/${assistantMessageId}/events`);
    const messageEvent = events.find((e) => e.event === 'message')!;
    expect((messageEvent.data as { title?: string }).title).toBeUndefined();
  });
});

describe('routes/conversations.ts — title_source through the HTTP surface (SPEC-step32.md B4)', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step32-title-http-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('PATCH rename marks the conversation title_source "user"', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const conv = (createRes.json() as { conversation: { id: string } }).conversation;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conv.id}`,
      payload: { title: 'Đặt tay' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { conversation: { titleSource: string } }).conversation.titleSource).toBe('user');
  });

  it('the first message auto-title keeps title_source "auto"', async () => {
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] }))) as unknown as typeof fetch;
    const createRes = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const conv = (createRes.json() as { conversation: { id: string } }).conversation;

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conv.id}/messages`,
      payload: { content: 'một hai ba bốn năm sáu bảy tám chín' },
    });
    await wait(20);

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conv.id}` });
    expect((detail.json() as { conversation: { titleSource: string } }).conversation.titleSource).toBe('auto');
  });
});
