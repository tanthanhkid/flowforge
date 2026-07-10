/**
 * Types mirrored from the server (apps/server/src/engine/types.ts,
 * engine/schema.ts, engine/registry.ts, engine/stores.ts, runManager.ts) —
 * SPEC-step4.md §2. Do NOT invent fields; every shape here must match what
 * the real routes in apps/server/src/routes/*.ts actually send/accept
 * (SPEC-step3.md §4).
 */

// ---- engine/types.ts -------------------------------------------------

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

export type NodeState = 'pending' | 'running' | 'success' | 'error' | 'skipped';
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
