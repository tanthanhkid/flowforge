/**
 * Fetch wrappers for the server API (SPEC-step3.md §4, SPEC-step4.md §2).
 * Relative paths only — vite.config.ts's dev-server proxy forwards `/api`
 * and `/artifacts` to the real server (localhost:3001), so the client never
 * needs a base URL and works unchanged after `vite build` behind any
 * reverse proxy that does the same forwarding.
 */
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  ConversationSummary,
  CostEstimate,
  CreateRunBody,
  CutPlan,
  EditNodeResult,
  GenerateWorkflowResult,
  NodeLogEvent,
  NodeSpec,
  NodeStateEvent,
  PatchOp,
  RefreshCatalogResult,
  RunSnapshot,
  RunStateEvent,
  RunSummary,
  SettingSummary,
  UnifiedCatalog,
  UploadResult,
  ValidationIssue,
  Workflow,
  WorkflowChangeSummary,
  WorkflowSummary,
} from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly issues?: ValidationIssue[];
  /**
   * SPEC-step23.md §2 — the full parsed JSON body of a non-2xx response
   * (additive; existing call sites that only read `.issues`/`.message` are
   * unaffected). A 409 `version-conflict` body carries `{ error, workflow,
   * version }` here, which SPEC-step26.md's rebase flow needs — `.issues`
   * alone can't carry that.
   */
  readonly body?: unknown;

  constructor(status: number, message: string, issues?: ValidationIssue[], body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
    this.body = body;
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
  // SPEC-step23.md §2 — only force `Content-Type: application/json` when a
  // body is actually being sent. A bodyless call (GET, or a DELETE like
  // `deleteConversation`/`deleteWorkflow` that never passes `body`) still
  // got this header before, and Fastify's JSON body parser — which DOES run
  // for DELETE, unlike GET — rejects a request that declares a JSON
  // content-type but carries zero bytes ("Body cannot be empty when
  // content-type is set to 'application/json'"), turning every such call
  // into a 400 the moment it hits a real server (not caught by any existing
  // unit test, which all mock `fetch` and never exercise Fastify's parser).
  const headers = init?.body !== undefined ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } : init?.headers;
  const res = await fetch(path, { ...init, headers });

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const errorBody = isErrorBody(body) ? body : undefined;
    const message = errorBody?.error ?? `Request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, errorBody?.issues, body);
  }

  return body as T;
}

// ---- registry -------------------------------------------------------

export async function getRegistry(): Promise<NodeSpec[]> {
  const res = await request<{ nodes: NodeSpec[] }>('/api/registry');
  return res.nodes;
}

// ---- model catalog (SPEC-step19.md §1.6/§2) -------------------------------

/** GET /api/model-catalog — the live+static merged catalog (`{ falVideo, falImage, openrouter, meta }`). */
export function getModelCatalog(): Promise<UnifiedCatalog> {
  return request('/api/model-catalog');
}

/** POST /api/catalog/refresh — force refetch both providers now, bypassing the 24h cache TTL (the picker's ↻ button). */
export function refreshCatalog(): Promise<RefreshCatalogResult> {
  return request('/api/catalog/refresh', { method: 'POST' });
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

// SPEC-step33.md §33e-1 — resume/stop an `'awaiting'` node (server 33c/33d):
// the human-in-the-loop CutPlan review gate. `resumeRun`'s body shape
// (`{nodeId, output}`) mirrors what the engine expects a paused node's
// resolved output to look like — `output` here is the (possibly
// human-edited) `CutPlan` itself, validated server-side against
// `CutPlanSchema` (400 on bad shape, e.g. `end <= start`).
export function resumeRun(runId: string, nodeId: string, plan: CutPlan): Promise<{ resumed: true }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, output: plan }),
  });
}

export function stopRun(runId: string): Promise<{ stopped: true }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
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

// ---- conversations (SPEC-step22.md §4, SPEC-step23.md §2) -----------------

export async function listConversations(search?: string): Promise<ConversationSummary[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const res = await request<{ conversations: ConversationSummary[] }>(`/api/conversations${qs}`);
  return res.conversations;
}

export async function createConversation(): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return res.conversation;
}

export function getConversation(
  id: string,
): Promise<{ conversation: Conversation; messages: ChatMessage[]; workflow: Workflow; version: number }> {
  return request(`/api/conversations/${encodeURIComponent(id)}`);
}

export async function renameConversation(id: string, title: string): Promise<Conversation> {
  const res = await request<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return res.conversation;
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * 202 `{ userMessageId, assistantMessageId }` — a 409 (`turn-in-progress`)
 * surfaces as an `ApiError`. `attachments` (SPEC-step32.md B1) is additive —
 * omitted from the body entirely (not sent as an empty array) when absent or
 * empty, so an un-migrated server sees byte-identical old behavior.
 */
export function postChatMessage(
  conversationId: string,
  content: string,
  attachments?: ChatAttachment[],
): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const body: { content: string; attachments?: ChatAttachment[] } = { content };
  if (attachments && attachments.length > 0) body.attachments = attachments;
  return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function stopTurn(conversationId: string, messageId: string): Promise<{ stopped: boolean }> {
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/stop`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

// ---- SSE chat-turn events (GET /api/conversations/:id/turns/:messageId/events, SPEC-step22.md §3/§4.7) --

export interface TurnEventHandlers {
  onThinking?: (data: { note: string }) => void;
  onPatchOp?: (data: { op: PatchOp; index: number; total: number }) => void;
  onMessage?: (data: {
    content: string;
    workflow: Workflow;
    version: number;
    changeId: number | null;
    /** SPEC-step32.md B4 — present only when this turn just AI-renamed the conversation. */
    title?: string;
  }) => void;
  onError?: (data: { message: string; issues?: ValidationIssue[] }) => void;
  onDone?: () => void;
}

/**
 * Subscribes to a single chat turn's SSE stream (event types: thinking /
 * patch-op / message / error / done — SPEC-step22.md §3). Mirrors
 * `openRunEvents` above: returns an unsubscribe function the caller MUST
 * invoke from its own `onDone` handler (the server closes the response right
 * after `done`, and a server-closed SSE connection otherwise auto-reconnects
 * forever per the EventSource spec).
 */
export function openTurnEvents(conversationId: string, assistantMessageId: string, handlers: TurnEventHandlers): () => void {
  const es = new globalThis.EventSource(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(assistantMessageId)}/events`,
  );

  const listen = <T>(type: string, handler?: (data: T) => void): void => {
    if (!handler) return;
    es.addEventListener(type, (event) => {
      const raw = (event as MessageEvent<string>).data;
      handler(raw ? (JSON.parse(raw) as T) : (undefined as T));
    });
  };

  listen<{ note: string }>('thinking', handlers.onThinking);
  listen<{ op: PatchOp; index: number; total: number }>('patch-op', handlers.onPatchOp);
  listen<{ content: string; workflow: Workflow; version: number; changeId: number | null; title?: string }>(
    'message',
    handlers.onMessage,
  );
  listen<{ message: string; issues?: ValidationIssue[] }>('error', handlers.onError);
  es.addEventListener('done', () => handlers.onDone?.());

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    es.close();
  };
}

// ---- workflow changes (SPEC-step22.md §5, SPEC-step23.md §2) --------------

export async function listChanges(
  workflowId: string,
  opts?: { since?: number; limit?: number; includeCosmetic?: boolean },
): Promise<WorkflowChangeSummary[]> {
  const qs = new URLSearchParams();
  if (opts?.since !== undefined) qs.set('since', String(opts.since));
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
  if (opts?.includeCosmetic !== undefined) qs.set('includeCosmetic', String(opts.includeCosmetic));
  const suffix = qs.toString();
  const res = await request<{ changes: WorkflowChangeSummary[] }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/changes${suffix ? `?${suffix}` : ''}`,
  );
  return res.changes;
}

export function postManualChange(
  workflowId: string,
  body: { ops: PatchOp[]; summary?: string; expectedVersion: number },
): Promise<{ change: WorkflowChangeSummary; workflow: Workflow; version: number }> {
  return request(`/api/workflows/${encodeURIComponent(workflowId)}/changes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function revertChange(
  workflowId: string,
  changeId: number,
): Promise<{ change: WorkflowChangeSummary; workflow: Workflow; version: number }> {
  return request(`/api/workflows/${encodeURIComponent(workflowId)}/changes/${encodeURIComponent(changeId)}/revert`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
