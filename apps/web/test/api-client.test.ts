import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createRun,
  createWorkflow,
  deleteWorkflow,
  getRegistry,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  openRunEvents,
  updateWorkflow,
  uploadFile,
  validateWorkflow,
} from '../src/api/client.ts';
import type { Workflow } from '../src/api/types.ts';

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
