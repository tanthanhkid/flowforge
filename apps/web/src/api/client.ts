/**
 * Fetch wrappers for the server API (SPEC-step3.md §4, SPEC-step4.md §2).
 * Relative paths only — vite.config.ts's dev-server proxy forwards `/api`
 * and `/artifacts` to the real server (localhost:3001), so the client never
 * needs a base URL and works unchanged after `vite build` behind any
 * reverse proxy that does the same forwarding.
 */
import type {
  CostEstimate,
  CreateRunBody,
  EditNodeResult,
  GenerateWorkflowResult,
  ModelCatalog,
  NodeLogEvent,
  NodeSpec,
  NodeStateEvent,
  RunSnapshot,
  RunStateEvent,
  RunSummary,
  SettingSummary,
  UploadResult,
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

// ---- model catalog (SPEC-step13.md §2) -----------------------------------

export function getModelCatalog(): Promise<ModelCatalog> {
  return request('/api/model-catalog');
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

// ---- agent (SPEC-step5.md §5) -------------------------------------------

export function generateWorkflowFromDescription(description: string, model?: string): Promise<GenerateWorkflowResult> {
  return request('/api/agent/generate-workflow', { method: 'POST', body: JSON.stringify({ description, model }) });
}

export function editNodeWithInstruction(
  workflow: Workflow,
  nodeId: string,
  instruction: string,
  model?: string,
): Promise<EditNodeResult> {
  return request('/api/agent/edit-node', {
    method: 'POST',
    body: JSON.stringify({ workflow, nodeId, instruction, model }),
  });
}

// ---- estimate (POST /api/estimate, SPEC-step15.md §2) --------------------

export function estimateWorkflowCost(workflow: Workflow): Promise<CostEstimate> {
  return request('/api/estimate', { method: 'POST', body: JSON.stringify(workflow) });
}

// ---- settings (SPEC-step6.md §1) ----------------------------------------

export async function getSettings(): Promise<SettingSummary[]> {
  const res = await request<{ settings: SettingSummary[] }>('/api/settings');
  return res.settings;
}

export async function putSettings(updates: Record<string, string>): Promise<SettingSummary[]> {
  const res = await request<{ settings: SettingSummary[] }>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return res.settings;
}

// ---- upload (POST /api/upload, SPEC-step10.md §2) -----------------------

/**
 * Uploads a browser `File` via multipart/form-data — deliberately NOT routed
 * through `request()` above, since that helper always sets
 * `Content-Type: application/json`; a `FormData` body needs the browser to
 * set its own `multipart/form-data; boundary=...` header instead.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload', { method: 'POST', body: formData });

  const contentType = res.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const errorBody = isErrorBody(body) ? body : undefined;
    const message = errorBody?.error ?? `Upload failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }

  return body as UploadResult;
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
