/**
 * Zustand store (SPEC-step4.md §3) — the workflow JSON is the single source
 * of truth; React Flow (built by the next step) derives its nodes/edges from
 * `workflow.nodes` / `workflow.edges` rather than owning its own copy.
 */
import { create } from 'zustand';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type {
  NodeRunRecord,
  NodeSpec,
  NodeState,
  PortValue,
  RunStatus,
  ValidationIssue,
  Workflow,
  WorkflowEdge,
  WorkflowEdgeEndpoint,
  WorkflowNode,
} from '../api/types.ts';
import { compatible } from '../canvas/portColors.ts';

export interface NodeRunUiState {
  state: NodeState;
  outputs?: Record<string, PortValue>;
  error?: string;
  cached?: boolean;
  logs: string[];
  startedAt?: number;
  finishedAt?: number;
}

export interface FlowState {
  workflow: Workflow;
  selectedNodeId: string | null;
  registry: NodeSpec[];
  runId?: string;
  runStatus?: RunStatus;
  nodeRuns: Record<string, NodeRunUiState>;
  dirty: boolean;
  validationIssues: ValidationIssue[];
  /**
   * Not in spec §3's state list verbatim — added for the "Force re-run node
   * này" button (spec §4 ParamsPanel): nodeIds queued here get passed as
   * `force` on the *next* Toolbar ▶ Run click (SPEC-step4.md §4), then
   * cleared once that run actually starts. Additive: run()'s `force`
   * argument (already covered by store.test.ts) is still chosen explicitly
   * by the caller — this list only feeds Toolbar's own call site.
   */
  forceNodeIds: string[];

  loadRegistry(): Promise<void>;
  newWorkflow(): void;
  loadWorkflow(id: string): Promise<void>;
  saveWorkflow(): Promise<void>;
  /** Not from spec §3's action list verbatim, but selectedNodeId needs a setter for the canvas/panels built in the next step. */
  selectNode(id: string | null): void;
  addNode(type: string, position: { x: number; y: number }): string;
  updateNodeParams(id: string, params: Record<string, unknown>): void;
  updateNodePosition(id: string, position: { x: number; y: number }): void;
  removeNode(id: string): void;
  addEdge(from: WorkflowEdgeEndpoint, to: WorkflowEdgeEndpoint): boolean;
  removeEdge(id: string): void;
  setWorkflowJson(workflow: Workflow): void;
  /**
   * Returns whether a run was actually accepted by the server (`false` when
   * the POST failed validation, e.g. a 400 with `issues` — no runId was
   * ever assigned). Callers (Toolbar) use this to avoid clearing a pending
   * "force re-run" selection for a run that never started, and to know
   * when to surface `validationIssues`.
   */
  run(force?: string[]): Promise<boolean>;
  openRun(runId: string): Promise<void>;
  /** Not from spec §3's action list verbatim — backs the Toolbar's Validate button (spec §4). */
  validate(): Promise<boolean>;
  /** See `forceNodeIds` above. */
  toggleForceNode(id: string): void;
  clearForceNodes(): void;
}

function emptyWorkflow(): Workflow {
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: 'Untitled workflow',
    nodes: [],
    edges: [],
  };
}

/** `${type.replace('.', '_')}_${k}`, k incrementing until unique (spec §3). */
function generateNodeId(type: string, existing: WorkflowNode[]): string {
  const prefix = type.replaceAll('.', '_');
  const ids = new Set(existing.map((n) => n.id));
  let k = 1;
  let id = `${prefix}_${k}`;
  while (ids.has(id)) {
    k += 1;
    id = `${prefix}_${k}`;
  }
  return id;
}

function generateEdgeId(existing: WorkflowEdge[]): string {
  const ids = new Set(existing.map((e) => e.id));
  let k = 1;
  let id = `e_${k}`;
  while (ids.has(id)) {
    k += 1;
    id = `e_${k}`;
  }
  return id;
}

/** params = defaults from paramsJsonSchema `default` (spec §3). */
function defaultParamsFromSchema(spec: NodeSpec | undefined): Record<string, unknown> {
  const properties = spec?.paramsJsonSchema.properties;
  if (!properties) return {};
  const params: Record<string, unknown> = {};
  for (const [name, propSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(propSchema, 'default')) {
      params[name] = propSchema.default;
    }
  }
  return params;
}

function nodeRunFromRecord(rec: NodeRunRecord): NodeRunUiState {
  return {
    state: rec.state,
    outputs: rec.outputs,
    error: rec.error,
    cached: rec.cacheHit,
    logs: rec.logs,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

// Kept outside the store's own state (rather than as a FlowState field)
// because it's an implementation-only handle for cleaning up the previous
// run's SSE subscription, not UI-observable data.
let activeRunUnsubscribe: (() => void) | undefined;

function stopActiveRunSubscription(): void {
  activeRunUnsubscribe?.();
  activeRunUnsubscribe = undefined;
}

export const useFlowStore = create<FlowState>()((set, get) => ({
  workflow: emptyWorkflow(),
  selectedNodeId: null,
  registry: [],
  runId: undefined,
  runStatus: undefined,
  nodeRuns: {},
  dirty: false,
  validationIssues: [],
  forceNodeIds: [],

  async loadRegistry() {
    const nodes = await api.getRegistry();
    set({ registry: nodes });
  },

  newWorkflow() {
    stopActiveRunSubscription();
    set({
      workflow: emptyWorkflow(),
      selectedNodeId: null,
      runId: undefined,
      runStatus: undefined,
      nodeRuns: {},
      dirty: false,
      validationIssues: [],
      forceNodeIds: [],
    });
  },

  async loadWorkflow(id) {
    const workflow = await api.getWorkflow(id);
    stopActiveRunSubscription();
    set({
      workflow,
      selectedNodeId: null,
      runId: undefined,
      runStatus: undefined,
      nodeRuns: {},
      dirty: false,
      validationIssues: [],
      forceNodeIds: [],
    });
  },

  async saveWorkflow() {
    const workflow = get().workflow;
    try {
      await api.createWorkflow(workflow);
    } catch (err) {
      // 409 = "already exists on the server" (spec §3: POST if new, PUT if
      // it already has a server-side copy) — fall back to an upsert.
      if (err instanceof ApiError && err.status === 409) {
        await api.updateWorkflow(workflow.id, workflow);
      } else {
        throw err;
      }
    }
    // Only clear `dirty` if the workflow object is still the exact snapshot
    // we saved — all mutations replace `workflow` wholesale, so reference
    // equality means "nothing changed while the request was in flight".
    // Otherwise a concurrent edit (node drag, param keystroke) landed mid-
    // save and must stay `dirty` since the server doesn't have it yet.
    set((state) => (state.workflow === workflow ? { dirty: false } : {}));
  },

  selectNode(id) {
    set({ selectedNodeId: id });
  },

  addNode(type, position) {
    const state = get();
    const spec = state.registry.find((s) => s.type === type);
    const id = generateNodeId(type, state.workflow.nodes);
    const node: WorkflowNode = {
      id,
      type,
      params: defaultParamsFromSchema(spec),
      position,
    };
    set({
      workflow: { ...state.workflow, nodes: [...state.workflow.nodes, node] },
      dirty: true,
    });
    return id;
  },

  updateNodeParams(id, params) {
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) => (n.id === id ? { ...n, params } : n)),
      },
      dirty: true,
    }));
  },

  updateNodePosition(id, position) {
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
      },
      dirty: true,
    }));
  },

  removeNode(id) {
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.filter((n) => n.id !== id),
        edges: state.workflow.edges.filter((e) => e.from.node !== id && e.to.node !== id),
      },
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
      dirty: true,
    }));
  },

  addEdge(from, to) {
    const state = get();
    const workflow = state.workflow;
    const fromNode = workflow.nodes.find((n) => n.id === from.node);
    const toNode = workflow.nodes.find((n) => n.id === to.node);
    if (!fromNode || !toNode) return false;

    const fromSpec = state.registry.find((s) => s.type === fromNode.type);
    const toSpec = state.registry.find((s) => s.type === toNode.type);
    const outPort = fromSpec?.outputs[from.port];
    const inPort = toSpec?.inputs[to.port];
    if (!outPort || !inPort) return false;
    if (!compatible(outPort.type, inPort.type)) return false;

    const inputOccupied = workflow.edges.some((e) => e.to.node === to.node && e.to.port === to.port);
    if (inputOccupied) return false;

    const edge: WorkflowEdge = { id: generateEdgeId(workflow.edges), from, to };
    set({
      workflow: { ...workflow, edges: [...workflow.edges, edge] },
      dirty: true,
    });
    return true;
  },

  removeEdge(id) {
    set((state) => ({
      workflow: { ...state.workflow, edges: state.workflow.edges.filter((e) => e.id !== id) },
      dirty: true,
    }));
  },

  setWorkflowJson(workflow) {
    set((state) => ({
      workflow,
      selectedNodeId: workflow.nodes.some((n) => n.id === state.selectedNodeId) ? state.selectedNodeId : null,
      dirty: true,
    }));
  },

  async run(force) {
    if (get().dirty) {
      await get().saveWorkflow();
    }
    const workflow = get().workflow;

    let runId: string;
    try {
      const res = await api.createRun({ workflowId: workflow.id, forceNodes: force });
      runId = res.runId;
    } catch (err) {
      if (err instanceof ApiError && err.issues) {
        set({ validationIssues: err.issues });
        // No run was accepted by the server — report "did not start" so
        // callers (Toolbar) know NOT to clear a pending force-rerun
        // selection for a run that never happened, and can show the issues.
        return false;
      }
      throw err;
    }

    stopActiveRunSubscription();
    set({ runId, runStatus: 'running', nodeRuns: {}, validationIssues: [] });

    // The store's `runId` can change while this stream is still open — the
    // user can click an older run in RunsPanel (openRun) while this one is
    // still executing. Gate every state-mutating handler on "is this run
    // still the one being displayed" so a backgrounded live run can't clobber
    // a historical run the user navigated to (and vice versa).
    const isDisplayed = () => get().runId === runId;

    // Capture the unsubscribe function locally so onDone can call it
    // directly (it closes over its own EventSource instance) rather than
    // relying on the module-level `activeRunUnsubscribe`, which may already
    // have been reassigned to a *different* run's handle by the time this
    // `done` event fires (e.g. the user started a new run in the meantime).
    const unsubscribe = api.openRunEvents(runId, {
      onSnapshot: (data) => {
        if (!isDisplayed()) return;
        const nodeRuns: Record<string, NodeRunUiState> = {};
        for (const rec of data.nodes) {
          nodeRuns[rec.nodeId] = nodeRunFromRecord(rec);
        }
        set({ runStatus: data.run.status, nodeRuns });
      },
      onNodeState: (data) => {
        if (!isDisplayed()) return;
        set((state) => {
          const existing = state.nodeRuns[data.nodeId] ?? { state: data.state, logs: [] };
          return {
            nodeRuns: {
              ...state.nodeRuns,
              [data.nodeId]: { ...existing, state: data.state, error: data.error, cached: data.cached },
            },
          };
        });
      },
      onNodeLog: (data) => {
        if (!isDisplayed()) return;
        set((state) => {
          const existing = state.nodeRuns[data.nodeId] ?? { state: 'pending' as NodeState, logs: [] };
          return {
            nodeRuns: {
              ...state.nodeRuns,
              [data.nodeId]: { ...existing, logs: [...existing.logs, data.message] },
            },
          };
        });
      },
      onRunState: (data) => {
        if (!isDisplayed()) return;
        set({ runStatus: data.status });
      },
      onDone: () => {
        // The server always ends the SSE response right after `done`
        // (apps/server/src/routes/runs.ts) — per the EventSource spec a
        // server-closed connection auto-reconnects, so this stream MUST be
        // closed here or it reconnects forever (replaying snapshot+done on
        // a ~3s timer) and leaks one immortal EventSource per run.
        unsubscribe();
        if (activeRunUnsubscribe === unsubscribe) {
          activeRunUnsubscribe = undefined;
        }
        // Refetch full node records (outputs included) now that the run has
        // finished (spec §3) — but only if the user is still looking at
        // this run; otherwise this would yank a historical-run view back to
        // the just-finished run.
        if (isDisplayed()) {
          void get().openRun(runId);
        }
      },
    });
    activeRunUnsubscribe = unsubscribe;
    return true;
  },

  async openRun(runId) {
    const snapshot = await api.getRun(runId);
    const nodeRuns: Record<string, NodeRunUiState> = {};
    for (const rec of snapshot.nodes) {
      nodeRuns[rec.nodeId] = nodeRunFromRecord(rec);
    }
    set({ runId, runStatus: snapshot.run.status, nodeRuns });
  },

  async validate() {
    const res = await api.validateWorkflow(get().workflow);
    set({ validationIssues: res.issues });
    return res.ok;
  },

  toggleForceNode(id) {
    set((state) => ({
      forceNodeIds: state.forceNodeIds.includes(id)
        ? state.forceNodeIds.filter((x) => x !== id)
        : [...state.forceNodeIds, id],
    }));
  },

  clearForceNodes() {
    set({ forceNodeIds: [] });
  },
}));
