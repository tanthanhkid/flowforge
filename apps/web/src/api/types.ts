/**
 * Types mirrored from the server (apps/server/src/engine/types.ts,
 * engine/schema.ts, engine/registry.ts, engine/stores.ts, runManager.ts) —
 * SPEC-step4.md §2. Do NOT invent fields; every shape here must match what
 * the real routes in apps/server/src/routes/*.ts actually send/accept
 * (SPEC-step3.md §4).
 */

// ---- engine/types.ts -------------------------------------------------

// SPEC-step33.md §33e-1 — `CutPlan`/`CutMoment` are defined once in
// `packages/shared` (zod, FE/BE-shared, same pattern as `PatchOp` below)
// rather than hand-mirrored here. Imported (not just re-exported) so
// `NodeStateEvent` below can reference `CutPlan` directly.
import type { CutPlan, CutMoment } from 'shared';
export type { CutPlan, CutMoment };

export type PortType = 'text' | 'image' | 'video' | 'audio' | 'json' | 'number' | 'any';

export interface MediaValue {
  kind: 'image' | 'video' | 'audio';
  path?: string;
  url?: string;
  mime?: string;
  meta?: Record<string, unknown>;
}

// text=string, number=number, image/video/audio=MediaValue, json/any=unknown
export type PortValue = unknown;

export interface PortSpec {
  type: PortType;
  required?: boolean;
  description?: string;
}

// SPEC-step33.md §33e-1 — `'awaiting'` (server 33c) is a node paused mid-run
// waiting on human approval of a `CutPlan` (`video.selectMoments`) before the
// engine continues; distinct from `'pending'` (hasn't started yet).
export type NodeState = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'awaiting';
export type RunStatus = 'running' | 'success' | 'error';

// ---- engine/registry.ts (GET /api/registry) ---------------------------

/**
 * Best-effort shape of a zod v4 `z.toJSONSchema()` object-schema output —
 * loose by design (JSON Schema has many optional keywords we don't all
 * enumerate), just enough for the UI to read `default`/`type`/`enum`/bounds.
 */
export interface JsonSchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  [key: string]: unknown;
}

export interface JsonSchemaObject {
  type?: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface NodeSpec {
  type: string;
  category: string;
  title: string;
  description?: string;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  paramsJsonSchema: JsonSchemaObject;
}

// ---- engine/schema.ts (Workflow JSON, source of truth) -----------------

export interface WorkflowNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position?: { x: number; y: number };
  label?: string;
}

export interface WorkflowEdgeEndpoint {
  node: string;
  port: string;
}

export interface WorkflowEdge {
  id: string;
  from: WorkflowEdgeEndpoint;
  to: WorkflowEdgeEndpoint;
}

export interface Workflow {
  version: 1;
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

// ---- db/workflows.ts (GET /api/workflows) -------------------------------

export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// ---- engine/stores.ts (GET /api/runs/:id, SSE snapshot) -----------------

export interface NodeRunRecord {
  runId: string;
  nodeId: string;
  state: NodeState;
  outputs?: Record<string, PortValue>;
  error?: string;
  logs: string[];
  cacheHit: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowJson: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
}

export interface RunSnapshot {
  run: RunRecord;
  nodes: NodeRunRecord[];
}

// ---- routes/runs.ts GET /api/runs (history list) ------------------------

export interface RunSummary {
  id: string;
  workflowId: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
}

// ---- routes/runs.ts POST /api/runs ---------------------------------------

export interface CreateRunBody {
  workflowId?: string;
  workflow?: Workflow;
  forceNodes?: string[];
}

// ---- runManager.ts SSE event payloads (routes/runs.ts /events) ----------

export interface NodeStateEvent {
  runId: string;
  nodeId: string;
  state: NodeState;
  error?: string;
  cached?: boolean;
  /** SPEC-step33.md §33c — present only when `state === 'awaiting'`: the
   * `CutPlan` the human is being asked to review/edit before the engine
   * resumes this node. */
  pendingApproval?: { plan: CutPlan };
}

export interface NodeLogEvent {
  runId: string;
  nodeId: string;
  message: string;
}

export interface RunStateEvent {
  runId: string;
  status: RunStatus;
}

// ---- routes/agent.ts (POST /api/agent/generate-workflow, /edit-node) -----

export interface GenerateWorkflowResult {
  workflow: Workflow;
  attempts: number;
}

export interface EditNodeResult {
  workflow: Workflow;
  ops: unknown[];
  attempts: number;
}

// ---- routes/upload.ts (POST /api/upload, SPEC-step10.md §1.1) -----------

export type UploadKind = 'image' | 'pdf' | 'markdown' | 'video' | 'audio' | 'other';

export interface UploadResult {
  /** Relative to artifactsDir, e.g. "uploads/<uuid>.png" — drop straight into a node's `path` param. */
  path: string;
  /** Original filename as chosen by the user, for display only. */
  filename: string;
  mime: string;
  size: number;
  kind: UploadKind;
}

// ---- routes/settings.ts (GET/PUT /api/settings, SPEC-step6.md §1) -------

export interface SettingSummary {
  key: string;
  isSet: boolean;
  /** `'••••' + last 4 chars`, or null when unset. Never the full value. */
  preview: string | null;
  secret: boolean;
  /** Only present for non-secret keys, and only when set. */
  value?: string;
}

// ---- routes/modelCatalog.ts (GET /api/model-catalog, SPEC-step19.md §1.6) --
//
// Replaces the old static-only { video, image, llm } shape (SPEC-step13.md
// §1-2 / SPEC-step14.md §2) with the live+static merged catalog — mirrors
// apps/server/src/catalog/live/types.ts's `CatalogFalEntry`/`CatalogLlmEntry`/
// `UnifiedCatalog` exactly (that module is the source of truth for this
// shape; see SPEC-step19.md §1.5/§1.6 for how `featured`/`tier`/`estUsd` are
// derived).

/** fal.ai category bucket this catalog cares about. */
export type CatalogFalKind = 'image' | 'video-t2v' | 'video-i2v';

/** Price tier, now derived purely from `estUsd` (SPEC-step19.md §1.3) — `'unknown'` when `estUsd` is null (price couldn't be parsed/estimated). */
export type CatalogTier = 'xin' | 'kha' | 're' | 'unknown';

export interface CatalogFalEntry {
  id: string;
  label: string;
  kind: CatalogFalKind;
  tier: CatalogTier;
  /** null = giá không xác định được (không đoán bừa) — UI hiển thị ❓. */
  estUsd: number | null;
  estBasis: string;
  note?: string;
  /** epoch ms, null if unknown. */
  createdAt: number | null;
  /** true = cũng có trong preset tĩnh tay-curated (label/note/estUsd đáng tin hơn). */
  featured: boolean;
  /** SPEC-step29.md §2 — t2i/i2i sub-classification, only meaningful for `kind: 'image'`; undefined when unknown. No UI picker badge yet (backlog). */
  imageKind?: 't2i' | 'i2i';
}

export interface CatalogLlmEntry {
  id: string;
  label: string;
  tier: CatalogTier;
  estUsd: number | null;
  estBasis: string;
  note?: string;
  createdAt: number | null;
  featured: boolean;
  /** USD per 1M input/output tokens — present when this id was seen live (both live-only and featured-matched-to-live entries); absent for a featured preset with no live match. */
  per1MIn?: number;
  per1MOut?: number;
  contextLength?: number | null;
}

export type CatalogSource = 'live' | 'live-stale' | 'static';

export interface CatalogMeta {
  source: CatalogSource;
  /** epoch ms of the underlying live fetch this response is based on; null when source === 'static'. */
  fetchedAt: number | null;
  counts: { falVideo: number; falImage: number; openrouter: number };
}

export interface UnifiedCatalog {
  falVideo: CatalogFalEntry[];
  falImage: CatalogFalEntry[];
  openrouter: CatalogLlmEntry[];
  meta: CatalogMeta;
}

// ---- POST /api/catalog/refresh (SPEC-step19.md §1.4) ---------------------

export interface RefreshCatalogResult {
  counts: { falVideo: number; falImage: number; openrouter: number };
  /** null only when `source: 'static'` (server-side CATALOG_LIVE=0 — no fetch ever happened). */
  fetchedAt: number | null;
  source: CatalogSource;
}

// ---- db/conversations.ts / db/messages.ts / db/changes.ts / agent/patch.ts
// (SPEC-step20.md §3, SPEC-step22.md §2/§4/§5 — routes/conversations.ts,
// routes/changes.ts) -------------------------------------------------------

export interface Conversation {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastSeenChangeId: number | null;
}

export interface ConversationSummary {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  lastRunStatus?: string;
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error';

// SPEC-step32.md B1 — an image already uploaded via `POST /api/upload`
// (`{path, filename, mime, size, kind}`), referenced from a chat message by
// its `path` only (the other `UploadResult` fields aren't persisted on the
// message row).
export interface ChatAttachment {
  path: string;
  filename?: string;
  mime?: string;
}

// SPEC-step32.md B2 — per-op-kind counts for a single turn. Populated two
// ways that must agree on shape: live, by store/chat.ts's `onPatchOp`
// accumulator (finalized onto the assistant message at `onMessage`); on
// reload, by `GET /api/conversations/:id` joining `workflow_changes` for any
// message with a `changeId` and counting its `ops`.
export interface ChatDiffCounts {
  addNode: number;
  removeNode: number;
  updateNode: number;
  addEdge: number;
  removeEdge: number;
  moveNode: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error?: string;
  changeId?: number;
  createdAt: number;
  /** SPEC-step32.md B1 — images attached to this (user) message; null/undefined when none. */
  attachments?: ChatAttachment[] | null;
  /** SPEC-step32.md B2 — this (assistant) turn's patch-op counts; absent when the turn made no workflow change. */
  diff?: ChatDiffCounts;
}

// Mirrors apps/server/src/agent/patch.ts's `PatchOpSchema` exactly (5 base
// ops + `move-node`) — no shared package yet (DESIGN-ai-native.md §7 notes
// this as tech debt for a later step), so this is a hand-mirrored copy like
// every other type in this file.
export type PatchOp =
  | { op: 'update-node'; nodeId: string; params?: Record<string, unknown>; label?: string }
  | { op: 'add-node'; node: WorkflowNode }
  | { op: 'remove-node'; nodeId: string }
  | { op: 'add-edge'; edge: WorkflowEdge }
  | { op: 'remove-edge'; edgeId: string }
  | { op: 'move-node'; nodeId: string; position: { x: number; y: number } };

export type ChangeSource = 'ai' | 'user';
export type ChangeScope = 'structural' | 'cosmetic';

/** `WorkflowChange` minus `snapshotAfter` — routes/changes.ts never sends that field to the client. */
export interface WorkflowChangeSummary {
  id: number;
  workflowId: string;
  conversationId: string;
  source: ChangeSource;
  scope: ChangeScope;
  messageId?: string;
  ops: PatchOp[];
  summary: string;
  createdAt: number;
}

// ---- routes/estimate.ts (POST /api/estimate, SPEC-step15.md §2) --------

export interface NodeCostEstimate {
  nodeId: string;
  type: string;
  /** null = không ước tính được (model id ngoài catalog). */
  usd: number | null;
  basis: string;
  note?: string;
}

export interface CostEstimate {
  totalUsd: number;
  unknownCount: number;
  nodes: NodeCostEstimate[];
  disclaimer: string;
}
