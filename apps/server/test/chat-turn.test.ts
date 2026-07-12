/**
 * SPEC-step21.md §6.3 — runChatTurn, against a fully mocked OpenRouter
 * `fetch` (same pattern as agent-generate.test.ts) and a real in-memory
 * SQLite db for the repos.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentValidationError } from '../src/agent/generateWorkflow.js';
import { applyPatch } from '../src/agent/patch.js';
import {
  ChatTurnAbortedError,
  ConversationNotFoundError,
  runChatTurn,
  type ChatTurnDeps,
} from '../src/agent/chatTurn.js';
import { ChangesRepo } from '../src/db/changes.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { MessagesRepo } from '../src/db/messages.js';
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

describe('runChatTurn', () => {
  let db: Database.Database;
  let clock: number;
  let workflows: WorkflowsRepo;
  let conversations: ConversationsRepo;
  let messages: MessagesRepo;
  let changes: ChangesRepo;
  let deps: ChatTurnDeps;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_DEFAULT_MODEL = 'test/dummy-model';

    db = openDb(':memory:');
    clock = 1000;
    workflows = new WorkflowsRepo(db, () => clock);
    conversations = new ConversationsRepo(db, () => clock);
    messages = new MessagesRepo(db, () => clock);
    changes = new ChangesRepo(db, () => clock);
    deps = { registry: createDefaultRegistry(), workflows, conversations, messages, changes };
  });

  afterEach(() => {
    db.close();
  });

  function setupConversation(workflowId = 'wf-1', conversationId = 'c1'): void {
    workflows.create(emptyWorkflow(workflowId, ''));
    conversations.create({ id: conversationId, workflowId });
  }

  it('throws ConversationNotFoundError for an unknown conversationId, without calling the LLM', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(runChatTurn('does-not-exist', 'hi', deps)).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path turn 1: creates the workflow from empty via add-node/add-edge ops — full message/change/version lifecycle + events in order', async () => {
    setupConversation();
    let idCounter = 0;

    const ops = [
      { op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } },
      { op: 'add-node', node: { id: 'n2', type: 'output.collect', params: {} } },
      { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'in1' } } },
    ];
    const fetchMock = vi.fn(async () => {
      // Assistant message must already be 'pending' by the time the LLM
      // call is in flight (id-1 is the assistant message: id-0 is the user
      // message, created just before it).
      expect(messages.get('id-1')?.status).toBe('pending');
      return chatResponse(JSON.stringify({ reply: 'Đã tạo workflow.', ops }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events: string[] = [];
    const patchOpCalls: Array<{ index: number; total: number }> = [];

    const result = await runChatTurn('c1', 'Tạo workflow đơn giản', {
      ...deps,
      id: () => `id-${idCounter++}`,
      events: {
        onThinking: (note) => events.push(`thinking:${note}`),
        onPatchOp: (op, index, total) => {
          events.push(`patch-op:${index}`);
          patchOpCalls.push({ index, total });
        },
        onMessage: (p) => events.push(`message:${p.reply}`),
      },
    });

    expect(result.reply).toBe('Đã tạo workflow.');
    expect(result.changeId).not.toBeNull();
    expect(result.version).toBe(1);
    expect(result.workflow.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(result.userMessageId).toBe('id-0');
    expect(result.assistantMessageId).toBe('id-1');

    const allMessages = messages.listByConversation('c1');
    expect(allMessages).toHaveLength(2);
    const userMsg = allMessages.find((m) => m.role === 'user')!;
    expect(userMsg.status).toBe('done');
    expect(userMsg.content).toBe('Tạo workflow đơn giản');
    const assistantMsg = allMessages.find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('done');
    expect(assistantMsg.content).toBe('Đã tạo workflow.');
    expect(assistantMsg.changeId).toBe(result.changeId);

    const changeRows = changes.listByWorkflow('wf-1', { includeCosmetic: true });
    expect(changeRows).toHaveLength(1);
    const change = changeRows[0]!;
    expect(change.source).toBe('ai');
    expect(change.scope).toBe('structural');
    expect(change.messageId).toBe(assistantMsg.id);
    expect(change.snapshotAfter).toEqual(result.workflow);

    expect(workflows.getVersion('wf-1')).toBe(1);
    expect(conversations.get('c1')?.lastSeenChangeId).toBe(change.id);

    expect(events[0]).toMatch(/^thinking:/);
    expect(events.slice(1, 4)).toEqual(['patch-op:0', 'patch-op:1', 'patch-op:2']);
    expect(events[4]).toBe('message:Đã tạo workflow.');
    expect(patchOpCalls).toEqual([
      { index: 0, total: 3 },
      { index: 1, total: 3 },
      { index: 2, total: 3 },
    ]);
  });

  it('ops empty: pure reply, no change created, last_seen_change_id set to the max unseen change id', async () => {
    setupConversation();
    const manualChange = changes.create({
      workflowId: 'wf-1',
      conversationId: 'c1',
      source: 'user',
      scope: 'structural',
      ops: [{ op: 'add-node', node: { id: 'z', type: 'input.text', params: {} } }],
      summary: 'manual',
      snapshotAfter: emptyWorkflow('wf-1', ''),
    });

    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ reply: 'Bạn muốn mình tạo node gì cụ thể?', ops: [] })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'ơ vậy à', deps);

    expect(result.changeId).toBeNull();
    expect(result.reply).toBe('Bạn muốn mình tạo node gì cụ thể?');
    expect(changes.listByWorkflow('wf-1', { includeCosmetic: true })).toHaveLength(1); // still just the manual one
    expect(conversations.get('c1')?.lastSeenChangeId).toBe(manualChange.id);

    const assistantMsg = messages.listByConversation('c1').find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('done');
    expect(assistantMsg.changeId).toBeUndefined();
  });

  it('embeds the digest of an unseen manual change into the system prompt sent to the LLM', async () => {
    setupConversation();
    changes.create({
      workflowId: 'wf-1',
      conversationId: 'c1',
      source: 'user',
      scope: 'structural',
      ops: [{ op: 'add-node', node: { id: 'manual1', type: 'input.text', params: {} } }],
      summary: 'manual',
      snapshotAfter: emptyWorkflow('wf-1', ''),
    });

    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runChatTurn('c1', 'gì đó', deps);

    const body = requestBodyOf(fetchMock, 0);
    const systemMsg = body.messages[0]!;
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content).toContain('[tay] thêm node input.text (id manual1)');
  });

  it('digest reflects the NEWEST unseen manual changes even with >100 unseen (not the 100 oldest)', async () => {
    setupConversation();
    // 150 unseen structural changes — well past listByWorkflow's default
    // pagination limit of 100 — so the digest must not silently truncate to
    // the 100 oldest ones before buildChangeDigest gets a chance to keep the
    // newest 40.
    for (let i = 0; i < 150; i++) {
      changes.create({
        workflowId: 'wf-1',
        conversationId: 'c1',
        source: 'user',
        scope: 'structural',
        ops: [{ op: 'add-node', node: { id: `manual-${i}`, type: 'input.text', params: {} } }],
        summary: 'manual',
        snapshotAfter: emptyWorkflow('wf-1', ''),
      });
    }

    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runChatTurn('c1', 'gì đó', deps);

    const body = requestBodyOf(fetchMock, 0);
    const systemMsg = body.messages[0]!;
    // Newest change (id 149) must be present; digest caps at 40 lines, so the
    // oldest ones (e.g. id 0) must have been rolled up/dropped instead.
    expect(systemMsg.content).toContain('manual-149');
    expect(systemMsg.content).not.toContain('manual-0)');
  });

  it('retries once on a malformed JSON response, then succeeds (2 LLM calls, correct feedback)', async () => {
    setupConversation();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse('Sorry, I cannot help with that.'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ reply: 'ok', ops: [] })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'hi', deps);

    expect(result.reply).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = requestBodyOf(fetchMock, 1);
    const feedback = secondBody.messages[secondBody.messages.length - 1]!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('parse');
  });

  it('recovers from exactly ONE version conflict by rebuilding the prompt (2nd attempt system prompt reflects the new workflow) and succeeds', async () => {
    setupConversation();
    const aiOps = [{ op: 'add-node', node: { id: 'ai-node', type: 'input.text', params: {} } }];
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate a manual edit landing WHILE this (attempt 1) call was in flight.
        const manual = applyPatch(workflows.get('wf-1')!, [
          { op: 'add-node', node: { id: 'manual-node', type: 'input.text', params: {} } },
        ]);
        workflows.saveVersioned(manual, workflows.getVersion('wf-1'));
        return chatResponse(JSON.stringify({ reply: 'Đã thêm node.', ops: aiOps }));
      }
      return chatResponse(JSON.stringify({ reply: 'Đã thêm node sau khi cập nhật.', ops: aiOps }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'thêm 1 node input.text', deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('Đã thêm node sau khi cập nhật.');
    expect(result.workflow.nodes.map((n) => n.id).sort()).toEqual(['ai-node', 'manual-node']);
    expect(workflows.getVersion('wf-1')).toBe(2);
    expect(result.changeId).not.toBeNull();

    const secondBody = requestBodyOf(fetchMock, 1);
    expect(secondBody.messages[0]!.content).toContain('manual-node');
  });

  it('re-emits onThinking when a version conflict forces a rebuild (SPEC §4.5.b "quay lại bước 3-4")', async () => {
    setupConversation();
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
      return chatResponse(JSON.stringify({ reply: 'ok', ops: aiOps }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const thinkingEvents: string[] = [];
    await runChatTurn('c1', 'thêm 1 node input.text', {
      ...deps,
      events: { onThinking: (note) => thinkingEvents.push(note) },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // One onThinking for the initial attempt (bước 4) + one more when the
    // version conflict forces a rebuild back to bước 3-4 — an SSE consumer
    // must see a fresh "đang phân tích" signal for the 2nd LLM call too.
    expect(thinkingEvents).toEqual(['Đang phân tích yêu cầu…', 'Đang phân tích yêu cầu…']);
  });

  it('ends with the fail-safe reply after TWO consecutive version conflicts — no change row, no AgentValidationError', async () => {
    setupConversation();
    const aiOps = [{ op: 'add-node', node: { id: 'ai-node', type: 'input.text', params: {} } }];
    let callCount = 0;

    const fetchMock = vi.fn(async () => {
      callCount++;
      const manual = applyPatch(workflows.get('wf-1')!, [
        { op: 'add-node', node: { id: `manual-${callCount}`, type: 'input.text', params: {} } },
      ]);
      workflows.saveVersioned(manual, workflows.getVersion('wf-1'));
      return chatResponse(JSON.stringify({ reply: `attempt ${callCount}`, ops: aiOps }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runChatTurn('c1', 'thêm node', deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.changeId).toBeNull();
    expect(result.reply).toContain('Workflow vừa được bạn chỉnh tay');
    expect(changes.listByWorkflow('wf-1', { includeCosmetic: true })).toHaveLength(0);

    const assistantMsg = messages.listByConversation('c1').find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('done');
    expect(assistantMsg.content).toContain('Workflow vừa được bạn chỉnh tay');
  });

  it('marks the assistant message errored (not stuck pending) when chatCompletion throws a hard, non-abort error', async () => {
    setupConversation();
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'invalid api key' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(runChatTurn('c1', 'hi', deps)).rejects.toThrow(/OpenRouter/);

    const assistantMsg = messages.listByConversation('c1').find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('error');
    expect(assistantMsg.error).toContain('OpenRouter');
  });

  it('throws ChatTurnAbortedError and marks the assistant message errored when the signal aborts mid-flight', async () => {
    setupConversation();
    const controller = new AbortController();

    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const turnPromise = runChatTurn('c1', 'hi', { ...deps, signal: controller.signal });
    controller.abort();

    await expect(turnPromise).rejects.toBeInstanceOf(ChatTurnAbortedError);

    const assistantMsg = messages.listByConversation('c1').find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('error');
    expect(assistantMsg.error).toBe('Đã dừng theo yêu cầu');
  });

  it('throws AgentValidationError and marks the assistant message errored after 3 failed attempts', async () => {
    setupConversation();
    const fetchMock = vi.fn(async () => chatResponse('not valid json'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(runChatTurn('c1', 'hi', deps)).rejects.toBeInstanceOf(AgentValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const assistantMsg = messages.listByConversation('c1').find((m) => m.role === 'assistant')!;
    expect(assistantMsg.status).toBe('error');
    expect(assistantMsg.error).toBeTruthy();
  });
});
