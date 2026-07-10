/**
 * Fetch wrappers for the server API (SPEC-step3.md §4, SPEC-step4.md §2).
 * Relative paths only — vite.config.ts's dev-server proxy forwards `/api`
 * and `/artifacts` to the real server (localhost:3001), so the client never
 * needs a base URL and works unchanged after `vite build` behind any
 * reverse proxy that does the same forwarding.
 */
import type {
  CreateRunBody,
  NodeLogEvent,
  NodeSpec,
  NodeStateEvent,
  RunSnapshot,
  RunStateEvent,
  RunSummary,
  ValidationIssue,
  Workflow,
  WorkflowSummary,
} from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly issues?: ValidationIssue[];

  constructor(status: number, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
  }
}

interface ErrorBody {
  error?: string;
  issues?: ValidationIssue[];
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const errorBody = isErrorBody(body) ? body : undefined;
    const message = errorBody?.error ?? `Request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, errorBody?.issues);
  }

  return body as T;
}

// ---- registry -------------------------------------------------------

export async function getRegistry(): Promise<NodeSpec[]> {
  const res = await request<{ nodes: NodeSpec[] }>('/api/registry');
  return res.nodes;
}

// ---- workflows --------------------------------------------------------

export function listWorkflows(): Promise<WorkflowSummary[]> {
  return request('/api/workflows');
}

export function createWorkflow(workflow: Workflow): Promise<{ id: string }> {
  return request('/api/workflows', { method: 'POST', body: JSON.stringify(workflow) });
}

export function getWorkflow(id: string): Promise<Workflow> {
  return request(`/api/workflows/${encodeURIComponent(id)}`);
}

export function updateWorkflow(id: string, workflow: Workflow): Promise<{ id: string }> {
  return request(`/api/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(workflow) });
}

export function deleteWorkflow(id: string): Promise<void> {
  return request(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function validateWorkflow(workflow: Workflow): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
  return request('/api/workflows/validate', { method: 'POST', body: JSON.stringify(workflow) });
}

// ---- runs ---------------------------------------------------------------

export function createRun(body: CreateRunBody): Promise<{ runId: string }> {
  return request('/api/runs', { method: 'POST', body: JSON.stringify(body) });
}

export function listRuns(params?: { workflowId?: string; limit?: number }): Promise<RunSummary[]> {
  const qs = new URLSearchParams();
  if (params?.workflowId) qs.set('workflowId', params.workflowId);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  const suffix = qs.toString();
  return request(`/api/runs${suffix ? `?${suffix}` : ''}`);
}

export function getRun(id: string): Promise<RunSnapshot> {
  return request(`/api/runs/${encodeURIComponent(id)}`);
}

// ---- SSE run events (GET /api/runs/:id/events) ---------------------------

export interface RunEventHandlers {
  onSnapshot?: (data: RunSnapshot) => void;
  onNodeState?: (data: NodeStateEvent) => void;
  onNodeLog?: (data: NodeLogEvent) => void;
  onRunState?: (data: RunStateEvent) => void;
  onDone?: () => void;
  onError?: (err: Event) => void;
}

/**
 * Subscribes to a run's SSE stream (event types: snapshot / node:state /
 * node:log / run:state / done — SPEC-step3.md §4). Returns an unsubscribe
 * function that closes the EventSource; safe to call multiple times.
 *
 * Uses `globalThis.EventSource` (rather than importing one) so tests can
 * substitute a mock via `vi.stubGlobal('EventSource', MockEventSource)` —
 * jsdom itself doesn't implement EventSource.
 */
export function openRunEvents(runId: string, handlers: RunEventHandlers): () => void {
  const es = new globalThis.EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);

  const listen = <T>(type: string, handler?: (data: T) => void): void => {
    if (!handler) return;
    es.addEventListener(type, (event) => {
      const raw = (event as MessageEvent<string>).data;
      handler(raw ? (JSON.parse(raw) as T) : (undefined as T));
    });
  };

  listen<RunSnapshot>('snapshot', handlers.onSnapshot);
  listen<NodeStateEvent>('node:state', handlers.onNodeState);
  listen<NodeLogEvent>('node:log', handlers.onNodeLog);
  listen<RunStateEvent>('run:state', handlers.onRunState);
  es.addEventListener('done', () => handlers.onDone?.());
  if (handlers.onError) {
    es.onerror = handlers.onError;
  }

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    es.close();
  };
}
