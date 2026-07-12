import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createConversation,
  createRun,
  createWorkflow,
  deleteConversation,
  deleteWorkflow,
  estimateWorkflowCost,
  getConversation,
  getModelCatalog,
  getRegistry,
  getRun,
  getWorkflow,
  listChanges,
  listConversations,
  listRuns,
  listWorkflows,
  openRunEvents,
  openTurnEvents,
  postChatMessage,
  postManualChange,
  refreshCatalog,
  renameConversation,
  revertChange,
  stopTurn,
  updateWorkflow,
  uploadFile,
  validateWorkflow,
} from '../src/api/client.ts';
import type { Conversation, ConversationSummary, UnifiedCatalog, Workflow, WorkflowChangeSummary } from '../src/api/types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const sampleWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] };

describe('api client (CRUD + validate + runs)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function lastCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    if (!call) throw new Error('fetch was not called');
    return call as [string, RequestInit];
  }

  it('getRegistry: GET /api/registry, unwraps { nodes }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nodes: [{ type: 'a' }] }));
    const nodes = await getRegistry();
    expect(lastCall()[0]).toBe('/api/registry');
    expect(nodes).toEqual([{ type: 'a' }]);
  });

  it('listWorkflows: GET /api/workflows', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listWorkflows();
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('createWorkflow: POST /api/workflows with the workflow JSON as body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'wf1' }, 201));
    const res = await createWorkflow(sampleWorkflow);
    expect(res).toEqual({ id: 'wf1' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(sampleWorkflow);
  });

  it('getWorkflow: GET /api/workflows/:id, id url-encoded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sampleWorkflow));
    await getWorkflow('wf 1');
    expect(lastCall()[0]).toBe('/api/workflows/wf%201');
  });

  it('updateWorkflow: PUT /api/workflows/:id with the workflow JSON as body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'wf1' }));
    await updateWorkflow('wf1', sampleWorkflow);
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows/wf1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(sampleWorkflow);
  });

  it('deleteWorkflow: DELETE /api/workflows/:id, tolerates a 204 empty body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteWorkflow('wf1')).resolves.toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows/wf1');
    expect(init.method).toBe('DELETE');
  });

  it('validateWorkflow: POST /api/workflows/validate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, issues: [] }));
    const res = await validateWorkflow(sampleWorkflow);
    expect(res).toEqual({ ok: true, issues: [] });
    expect(lastCall()[0]).toBe('/api/workflows/validate');
    expect(lastCall()[1].method).toBe('POST');
  });

  it('estimateWorkflowCost: POST /api/estimate with the workflow JSON as body', async () => {
    const estimate = { totalUsd: 1.23, unknownCount: 0, nodes: [], disclaimer: 'x' };
    fetchMock.mockResolvedValueOnce(jsonResponse(estimate));
    const res = await estimateWorkflowCost(sampleWorkflow);
    expect(res).toEqual(estimate);
    const [url, init] = lastCall();
    expect(url).toBe('/api/estimate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(sampleWorkflow);
  });

  it('getModelCatalog: GET /api/model-catalog, returns the unified { falVideo, falImage, openrouter, meta } shape (SPEC-step19.md §1.6)', async () => {
    const catalog: UnifiedCatalog = {
      falVideo: [],
      falImage: [],
      openrouter: [],
      meta: { source: 'static', fetchedAt: null, counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(catalog));
    const res = await getModelCatalog();
    expect(res).toEqual(catalog);
    expect(lastCall()[0]).toBe('/api/model-catalog');
  });

  it('refreshCatalog: POST /api/catalog/refresh (SPEC-step19.md §1.4 — the picker\'s ↻ button)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ counts: { falVideo: 10, falImage: 5, openrouter: 300 }, fetchedAt: 12345, source: 'live' }),
    );
    const res = await refreshCatalog();
    expect(res).toEqual({ counts: { falVideo: 10, falImage: 5, openrouter: 300 }, fetchedAt: 12345, source: 'live' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/catalog/refresh');
    expect(init.method).toBe('POST');
  });

  // Post-review fix: CATALOG_LIVE=0 (server-side) must make POST
  // /api/catalog/refresh itself a no-network no-op — it returns the
  // static-only counts with source: 'static' and a null fetchedAt rather
  // than ever attempting a fetch.
  it('refreshCatalog: passes through a static (CATALOG_LIVE=0) result unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ counts: { falVideo: 24, falImage: 12, openrouter: 12 }, fetchedAt: null, source: 'static' }),
    );
    const res = await refreshCatalog();
    expect(res).toEqual({ counts: { falVideo: 24, falImage: 12, openrouter: 12 }, fetchedAt: null, source: 'static' });
  });

  it('createRun: POST /api/runs with the given body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: 'r1' }, 202));
    const res = await createRun({ workflowId: 'wf1', forceNodes: ['n1'] });
    expect(res).toEqual({ runId: 'r1' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ workflowId: 'wf1', forceNodes: ['n1'] });
  });

  it('listRuns: builds the querystring from workflowId/limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listRuns({ workflowId: 'wf1', limit: 10 });
    expect(lastCall()[0]).toBe('/api/runs?workflowId=wf1&limit=10');
  });

  it('listRuns: no params hits the bare endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await listRuns();
    expect(lastCall()[0]).toBe('/api/runs');
  });

  it('getRun: GET /api/runs/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run: {}, nodes: [] }));
    await getRun('r1');
    expect(lastCall()[0]).toBe('/api/runs/r1');
  });

  it('throws ApiError with server message + issues on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Invalid workflow', issues: [{ code: 'cycle', message: 'bad' }] }, 400),
    );
    await expect(createWorkflow(sampleWorkflow)).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Invalid workflow',
      issues: [{ code: 'cycle', message: 'bad' }],
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Invalid workflow' }, 400));
    await expect(createWorkflow(sampleWorkflow)).rejects.toBeInstanceOf(ApiError);
  });

  // SPEC-step23.md §2 — ApiError must keep the full parsed body of a non-2xx
  // response (additive `body?: unknown` field), not just `.issues`, so a
  // 409 version-conflict's `{ error, workflow, version }` survives for a
  // later rebase (SPEC-step26.md).
  it('ApiError.body carries the full parsed JSON body of a 409 response', async () => {
    const conflictBody = { error: 'version-conflict', workflow: sampleWorkflow, version: 3 };
    fetchMock.mockResolvedValueOnce(jsonResponse(conflictBody, 409));
    await expect(createWorkflow(sampleWorkflow)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      body: conflictBody,
    });
  });
});

// SPEC-step23.md §2 — conversations/messages/changes API client functions.
describe('conversations API', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function lastCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    if (!call) throw new Error('fetch was not called');
    return call as [string, RequestInit];
  }

  const sampleConversation: Conversation = {
    id: 'c1',
    workflowId: 'wf1',
    title: 'Test conversation',
    createdAt: 1,
    updatedAt: 2,
    lastSeenChangeId: null,
  };

  const sampleSummary: ConversationSummary = {
    id: 'c1',
    workflowId: 'wf1',
    title: 'Test conversation',
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 2,
  };

  it('listConversations: GET /api/conversations, unwraps { conversations }, omits ?search when absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [sampleSummary] }));
    const res = await listConversations();
    expect(res).toEqual([sampleSummary]);
    expect(lastCall()[0]).toBe('/api/conversations');
  });

  it('listConversations: appends an encoded ?search= when given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [] }));
    await listConversations('mèo & chó');
    expect(lastCall()[0]).toBe('/api/conversations?search=m%C3%A8o%20%26%20ch%C3%B3');
  });

  it('createConversation: POST /api/conversations with an empty body, unwraps { conversation }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversation: sampleConversation }));
    const res = await createConversation();
    expect(res).toEqual(sampleConversation);
    const [url, init] = lastCall();
    expect(url).toBe('/api/conversations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('getConversation: GET /api/conversations/:id, id url-encoded', async () => {
    const payload = { conversation: sampleConversation, messages: [], workflow: sampleWorkflow, version: 0 };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));
    const res = await getConversation('c 1');
    expect(res).toEqual(payload);
    expect(lastCall()[0]).toBe('/api/conversations/c%201');
  });

  it('renameConversation: PATCH /api/conversations/:id with { title }, unwraps { conversation }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversation: { ...sampleConversation, title: 'Renamed' } }));
    const res = await renameConversation('c1', 'Renamed');
    expect(res.title).toBe('Renamed');
    const [url, init] = lastCall();
    expect(url).toBe('/api/conversations/c1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Renamed' });
  });

  it('deleteConversation: DELETE /api/conversations/:id, tolerates a 204 empty body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteConversation('c1')).resolves.toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe('/api/conversations/c1');
    expect(init.method).toBe('DELETE');
  });

  it('postChatMessage: POST /api/conversations/:id/messages with { content }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ userMessageId: 'u1', assistantMessageId: 'a1' }, 202),
    );
    const res = await postChatMessage('c1', 'xin chào');
    expect(res).toEqual({ userMessageId: 'u1', assistantMessageId: 'a1' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/conversations/c1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'xin chào' });
  });

  it('postChatMessage: a 409 (turn-in-progress) rejects as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'turn-in-progress' }, 409));
    await expect(postChatMessage('c1', 'hi')).rejects.toMatchObject({ name: 'ApiError', status: 409 });
  });

  it('stopTurn: POST /api/conversations/:id/messages/:messageId/stop', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ stopped: true }));
    const res = await stopTurn('c1', 'a1');
    expect(res).toEqual({ stopped: true });
    const [url, init] = lastCall();
    expect(url).toBe('/api/conversations/c1/messages/a1/stop');
    expect(init.method).toBe('POST');
  });
});

describe('workflow changes API', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function lastCall(): [string, RequestInit] {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    if (!call) throw new Error('fetch was not called');
    return call as [string, RequestInit];
  }

  const sampleChange: WorkflowChangeSummary = {
    id: 1,
    workflowId: 'wf1',
    conversationId: 'c1',
    source: 'user',
    scope: 'structural',
    ops: [],
    summary: 'test change',
    createdAt: 1,
  };

  it('listChanges: GET .../changes with no query when opts omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ changes: [sampleChange] }));
    const res = await listChanges('wf1');
    expect(res).toEqual([sampleChange]);
    expect(lastCall()[0]).toBe('/api/workflows/wf1/changes');
  });

  it('listChanges: builds the querystring from since/limit/includeCosmetic', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ changes: [] }));
    await listChanges('wf1', { since: 5, limit: 10, includeCosmetic: true });
    expect(lastCall()[0]).toBe('/api/workflows/wf1/changes?since=5&limit=10&includeCosmetic=true');
  });

  it('postManualChange: POST /api/workflows/:id/changes with the given body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ change: sampleChange, workflow: sampleWorkflow, version: 1 }));
    const body = { ops: [{ op: 'move-node' as const, nodeId: 'a', position: { x: 1, y: 2 } }], expectedVersion: 0 };
    const res = await postManualChange('wf1', body);
    expect(res).toEqual({ change: sampleChange, workflow: sampleWorkflow, version: 1 });
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows/wf1/changes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('postManualChange: a 409 (version-conflict) rejects as an ApiError with the conflicting workflow/version in .body', async () => {
    const conflictBody = { error: 'version-conflict', workflow: sampleWorkflow, version: 4 };
    fetchMock.mockResolvedValueOnce(jsonResponse(conflictBody, 409));
    await expect(postManualChange('wf1', { ops: [], expectedVersion: 0 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      body: conflictBody,
    });
  });

  it('revertChange: POST /api/workflows/:id/changes/:changeId/revert', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ change: sampleChange, workflow: sampleWorkflow, version: 2 }));
    const res = await revertChange('wf1', 3);
    expect(res).toEqual({ change: sampleChange, workflow: sampleWorkflow, version: 2 });
    const [url, init] = lastCall();
    expect(url).toBe('/api/workflows/wf1/changes/3/revert');
    expect(init.method).toBe('POST');
  });
});

// SPEC-step10.md §2 — uploadFile: POST /api/upload with a FormData body
// (not the JSON `request()` helper other client fns use).
describe('uploadFile', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('POSTs a FormData body containing the file under field "file"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png', size: 3, kind: 'image' }, 201),
    );
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    const result = await uploadFile(file);

    expect(result).toEqual({ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png', size: 3, kind: 'image' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
    // Unlike request(), no Content-Type header is set — the browser needs
    // to add its own multipart boundary.
    expect(init.headers).toBeUndefined();
  });

  it('throws ApiError with the server message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'File vượt quá giới hạn 50MB.' }, 413));
    const file = new File(['x'], 'big.png', { type: 'image/png' });
    await expect(uploadFile(file)).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      message: 'File vượt quá giới hạn 50MB.',
    });
  });
});

describe('openRunEvents', () => {
  class MockEventSource {
    static instances: MockEventSource[] = [];
    readonly url: string;
    readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
    closed = false;
    onerror: ((err: Event) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
    }

    addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(cb);
    }

    removeEventListener(type: string, cb: (ev: MessageEvent) => void): void {
      this.listeners.get(type)?.delete(cb);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, data: unknown): void {
      const event = { data: JSON.stringify(data) } as MessageEvent;
      for (const cb of this.listeners.get(type) ?? []) cb(event);
    }
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function firstInstance(): MockEventSource {
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error('EventSource was not constructed');
    return instance;
  }

  it('opens an EventSource against /api/runs/:id/events', () => {
    openRunEvents('r1', {});
    expect(firstInstance().url).toBe('/api/runs/r1/events');
  });

  it('parses snapshot / node:state / node:log / run:state / done events', () => {
    const onSnapshot = vi.fn();
    const onNodeState = vi.fn();
    const onNodeLog = vi.fn();
    const onRunState = vi.fn();
    const onDone = vi.fn();

    openRunEvents('r1', { onSnapshot, onNodeState, onNodeLog, onRunState, onDone });
    const es = firstInstance();

    const snapshot = { run: { id: 'r1' }, nodes: [] };
    es.emit('snapshot', snapshot);
    es.emit('node:state', { runId: 'r1', nodeId: 'n1', state: 'running' });
    es.emit('node:log', { runId: 'r1', nodeId: 'n1', message: 'hi' });
    es.emit('run:state', { runId: 'r1', status: 'success' });
    es.emit('done', {});

    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onNodeState).toHaveBeenCalledWith({ runId: 'r1', nodeId: 'n1', state: 'running' });
    expect(onNodeLog).toHaveBeenCalledWith({ runId: 'r1', nodeId: 'n1', message: 'hi' });
    expect(onRunState).toHaveBeenCalledWith({ runId: 'r1', status: 'success' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe function closes the EventSource', () => {
    const unsubscribe = openRunEvents('r1', {});
    const es = firstInstance();
    expect(es.closed).toBe(false);
    unsubscribe();
    expect(es.closed).toBe(true);
  });
});

// SPEC-step23.md §2 — openTurnEvents mirrors openRunEvents above (same
// EventSource-wrapping shape), just against the chat-turn SSE endpoint and
// event set (thinking / patch-op / message / error / done).
describe('openTurnEvents', () => {
  class MockEventSource {
    static instances: MockEventSource[] = [];
    readonly url: string;
    readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
    closed = false;

    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
    }

    addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(cb);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, data: unknown): void {
      const event = { data: JSON.stringify(data) } as MessageEvent;
      for (const cb of this.listeners.get(type) ?? []) cb(event);
    }
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function firstInstance(): MockEventSource {
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error('EventSource was not constructed');
    return instance;
  }

  it('opens an EventSource against /api/conversations/:id/turns/:messageId/events', () => {
    openTurnEvents('c1', 'a1', {});
    expect(firstInstance().url).toBe('/api/conversations/c1/turns/a1/events');
  });

  it('parses thinking / patch-op / message / error / done events', () => {
    const onThinking = vi.fn();
    const onPatchOp = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();

    openTurnEvents('c1', 'a1', { onThinking, onPatchOp, onMessage, onError, onDone });
    const es = firstInstance();

    es.emit('thinking', { note: 'Đang nghĩ...' });
    es.emit('patch-op', { op: { op: 'move-node', nodeId: 'n1', position: { x: 0, y: 0 } }, index: 0, total: 1 });
    es.emit('message', { content: 'done', workflow: sampleWorkflow, version: 1, changeId: 5 });
    es.emit('error', { message: 'boom' });
    es.emit('done', {});

    expect(onThinking).toHaveBeenCalledWith({ note: 'Đang nghĩ...' });
    expect(onPatchOp).toHaveBeenCalledWith({
      op: { op: 'move-node', nodeId: 'n1', position: { x: 0, y: 0 } },
      index: 0,
      total: 1,
    });
    expect(onMessage).toHaveBeenCalledWith({ content: 'done', workflow: sampleWorkflow, version: 1, changeId: 5 });
    expect(onError).toHaveBeenCalledWith({ message: 'boom' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe function closes the EventSource', () => {
    const unsubscribe = openTurnEvents('c1', 'a1', {});
    const es = firstInstance();
    expect(es.closed).toBe(false);
    unsubscribe();
    expect(es.closed).toBe(true);
  });
});
