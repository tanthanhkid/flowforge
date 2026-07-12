/**
 * Zustand store (SPEC-step4.md §3) — the workflow JSON is the single source
 * of truth; React Flow (built by the next step) derives its nodes/edges from
 * `workflow.nodes` / `workflow.edges` rather than owning its own copy.
 */
import { create } from 'zustand';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type {
  CostEstimate,
  NodeRunRecord,
  NodeSpec,
  NodeState,
  PatchOp,
  PortValue,
  RunStatus,
  UnifiedCatalog,
  ValidationIssue,
  Workflow,
  WorkflowEdge,
  WorkflowEdgeEndpoint,
  WorkflowNode,
} from '../api/types.ts';
import { layoutWorkflow, type NodeSize } from '../canvas/layout.ts';
import { compatible } from '../canvas/portColors.ts';
// SPEC-step26.md §2 — same `applyPatch`/`PatchError` the server uses
// (packages/shared, SPEC-step25.md), reused here for the chat turn's
// per-op *optimistic* canvas apply (see `applyOptimisticOp` below).
import { applyPatch, PatchError } from 'shared';

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
  /**
   * SPEC-step19.md §1.6/§2 — the live+static merged fal.ai/OpenRouter model
   * catalog (`{ falVideo, falImage, openrouter, meta }`), fetched once
   * alongside the registry. Replaces the old static-only `{ video, image,
   * llm }` shape from SPEC-step13.md §3/SPEC-step14.md §2.
   */
  modelCatalog: UnifiedCatalog;
  runId?: string;
  runStatus?: RunStatus;
  nodeRuns: Record<string, NodeRunUiState>;
  dirty: boolean;
  validationIssues: ValidationIssue[];
  /**
   * SPEC-step9.md §1 — global "👁 Preview" toolbar toggle: when false, no
   * NodeCard renders its inline preview regardless of that node's own
   * collapse state. Default ON.
   */
  showNodePreviews: boolean;
  /**
   * SPEC-step9.md §2 — which right-panel tab is active. Lifted out of
   * App.tsx's local state (it used to be) so `openRun` (called both from
   * RunsPanel and from `run()`'s onDone) can auto-switch to "results"
   * without threading a callback through the store.
   */
  rightTab: 'params' | 'runs' | 'results';
  /**
   * SPEC-step9.md §1 — set by NodeCard when the user clicks a node's inline
   * preview ("mở panel Kết quả và scroll tới output node đó"). ResultsPanel
   * consumes this once (expanding its "all nodes" section + scrolling) then
   * clears it back to null.
   */
  scrollToNodeId: string | null;
  /**
   * Not in spec §3's state list verbatim — added for the "Force re-run node
   * này" button (spec §4 ParamsPanel): nodeIds queued here get passed as
   * `force` on the *next* Toolbar ▶ Run click (SPEC-step4.md §4), then
   * cleared once that run actually starts. Additive: run()'s `force`
   * argument (already covered by store.test.ts) is still chosen explicitly
   * by the caller — this list only feeds Toolbar's own call site.
   */
  forceNodeIds: string[];
  /**
   * SPEC-step15.md §3 — 💰 cost estimate shown next to Run. `null` until the
   * first `refreshEstimate()` resolves (or after a failed fetch, which
   * fails silently — the badge just doesn't render). Toolbar debounces the
   * calls to this (800ms after the workflow last changed); the store itself
   * doesn't debounce so tests/other callers can call it directly.
   */
  costEstimate: CostEstimate | null;
  /**
   * SPEC-step16.md §2/§3 — each node's *measured* on-screen box size, kept
   * up to date by FlowCanvas from React Flow's own `dimensions` NodeChange
   * events (the store doesn't own a React Flow instance itself, so this is
   * how `autoLayout()` gets real sizes rather than only ever using
   * `layoutWorkflow`'s fallback). Missing entries (a node that hasn't
   * rendered/measured yet) just fall back inside `layoutWorkflow`.
   */
  nodeSizes: Record<string, NodeSize>;
  /**
   * SPEC-step18.md §4 — bumped by `requestFitView()` (🪄 Sắp xếp toolbar
   * button, and anything else that wants the canvas recentered). FlowCanvas
   * watches this nonce and calls React Flow's `fitView({ padding: 0.15,
   * duration: 300 })` whenever it changes; a plain counter (rather than a
   * boolean) so two requests in a row without an intervening render both
   * still trigger an effect re-run.
   */
  fitViewNonce: number;

  loadRegistry(): Promise<void>;
  /** See `modelCatalog` above. */
  loadCatalog(): Promise<void>;
  /**
   * SPEC-step19.md §2 — the picker's "↻" button: force a live refetch
   * server-side (`POST /api/catalog/refresh`, bypassing the 24h cache TTL),
   * then reload `modelCatalog` from the now-fresh cache. Propagates any
   * error to the caller (ModelPicker shows it inline) rather than failing
   * silently like `refreshEstimate` — the user explicitly asked for a
   * refresh and should know if it didn't work.
   */
  refreshModelCatalog(): Promise<void>;
  newWorkflow(): void;
  /**
   * SPEC-step23.md §3 — the shared "load a workflow object into the store"
   * reset, factored out of `loadWorkflow` so `store/chat.ts` can adopt a
   * workflow it already fetched some other way (`selectConversation`'s
   * `GET /api/conversations/:id`, a chat turn's SSE `message` event, a
   * manual-change/revert response) without a redundant `GET
   * /api/workflows/:id` round-trip. Same reset semantics as `loadWorkflow`
   * (stop any live run subscription, clear selection/dirty/validation/etc.)
   * — `loadWorkflow` itself is now just `getWorkflow` + this.
   */
  adoptWorkflow(workflow: Workflow): void;
  /**
   * SPEC-step26.md §2 — `store/chat.ts`'s `onPatchOp` handler applies each
   * streamed-in `PatchOp` optimistically via this setter *as the AI turn is
   * still running*, so the canvas materializes node-by-node instead of only
   * ever snapping to the final result. Deliberately does NOT set `dirty`:
   * unlike every other mutator in this store, this mirrors a change the
   * server has *already* persisted server-side (the turn's `message` SSE
   * event always follows up with the full authoritative workflow — see
   * `sendMessage`'s `onMessage` handler in store/chat.ts — and that
   * reconcile always wins over this optimistic copy per SPEC-step23.md
   * §4's rule) — flagging `dirty` here would make the toolbar think there's
   * a *local, unsaved* edit and offer to overwrite the very workflow the
   * server just produced.
   *
   * A `PatchError` (e.g. the op references a node/edge id an EARLIER op in
   * the same turn was supposed to create, but that earlier op itself got
   * skipped for the same reason) is caught and swallowed here — console.warn
   * only, no throw — since the turn's final `message` event reconciles the
   * real state regardless; the canvas just silently skips animating that one
   * intermediate step. Returns whether the op actually applied so the caller
   * knows whether to also record a highlight for it.
   */
  applyOptimisticOp(op: PatchOp): boolean;
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
  /**
   * `opts.switchTab` defaults to `true` (spec §9 "auto-switch": both a
   * RunsPanel click and a live run's onDone land on "Kết quả"). Pass
   * `{ switchTab: false }` for a *background* load that must not yank the
   * user off whatever right-panel tab they're currently looking at — see
   * `ensureLatestRunLoaded` below (SPEC-step18.md §4/7.5).
   */
  openRun(runId: string, opts?: { switchTab?: boolean }): Promise<void>;
  /**
   * SPEC-step18.md §4/7.5 — root-cause fix for "tab Kết quả báo 'Chưa có run
   * nào' dù DB có run": the store's `runId` only ever gets set by `run()` or
   * `openRun()`, both of which require an explicit user/run action in *this*
   * browser session. A fresh page load (or switching to a workflow that was
   * last run in a previous session) leaves `runId` undefined even though the
   * workflow has runs sitting in the DB — RunsPanel already fetches its own
   * list independently and shows them, so the mismatch reads as a bug.
   *
   * Called by ResultsPanel on mount/workflow-change: if there's no live run
   * yet, fetch this workflow's run history and `openRun` the most recent one
   * (server already returns `ORDER BY created_at DESC` — see
   * routes/runs.ts), WITHOUT switching `rightTab` (the user is already on
   * "Kết quả" — RunsPanel driving this same call must not fight the user's
   * own tab choice, spec §4 "KHÔNG tự chuyển tab"). No-op (silent) when
   * there's already a live run, the workflow has no runs, or the fetch
   * fails — ResultsPanel just keeps showing its placeholder in that case.
   *
   * Post-review fix (major): also a no-op when the latest run's own status
   * is still `'running'`. `openRun()` only ever loads a static snapshot —
   * it does NOT subscribe to SSE (only `run()`'s own call site does that) —
   * so auto-loading a `running` row here would set `runStatus: 'running'`
   * with nothing ever moving it out of that state. Toolbar's `isRunning`
   * (`runStatus === 'running'`) gates both Run buttons, so this would
   * permanently disable them the moment the user opens "Kết quả" on a
   * workflow whose most recent run got orphaned (e.g. a dev-server restart
   * mid-run — see apps/server/src/routes/runs.ts) or is genuinely still
   * executing from elsewhere. Skipping it here just leaves the "Chưa có run
   * nào" placeholder up, same as the "no runs at all" case — RunsPanel still
   * lets the user open that run explicitly if they want to see it.
   */
  ensureLatestRunLoaded(): Promise<void>;
  /** Not from spec §3's action list verbatim — backs the Toolbar's Validate button (spec §4). */
  validate(): Promise<boolean>;
  /** See `costEstimate` above. Silent-fails (leaves the previous estimate in place) on any error. */
  refreshEstimate(): Promise<void>;
  /** See `forceNodeIds` above. */
  toggleForceNode(id: string): void;
  clearForceNodes(): void;
  /** See `showNodePreviews` above. */
  toggleNodePreviews(): void;
  /** See `rightTab` above. */
  setRightTab(tab: 'params' | 'runs' | 'results'): void;
  /** See `scrollToNodeId` above. */
  requestScrollToNode(id: string): void;
  clearScrollToNode(): void;
  /** See `nodeSizes` above. */
  setNodeSizes(sizes: Record<string, NodeSize>): void;
  /**
   * SPEC-step16.md §3 — recomputes every node's position via
   * `layoutWorkflow` using the current `nodeSizes` (falling back to
   * NodeCard's fixed box size for anything not yet measured), keeps the
   * current selection, and marks the workflow dirty (positions changed).
   * Backs both the Toolbar "🪄 Sắp xếp" button and the auto-run-once after a
   * successful ✨ generate.
   */
  autoLayout(): void;
  /** See `fitViewNonce` above. */
  requestFitView(): void;
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
  modelCatalog: {
    falVideo: [],
    falImage: [],
    openrouter: [],
    meta: { source: 'static', fetchedAt: null, counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
  },
  runId: undefined,
  runStatus: undefined,
  nodeRuns: {},
  dirty: false,
  validationIssues: [],
  forceNodeIds: [],
  costEstimate: null,
  showNodePreviews: true,
  rightTab: 'params',
  scrollToNodeId: null,
  nodeSizes: {},
  fitViewNonce: 0,

  async loadRegistry() {
    const nodes = await api.getRegistry();
    set({ registry: nodes });
  },

  async loadCatalog() {
    const modelCatalog = await api.getModelCatalog();
    set({ modelCatalog });
  },

  async refreshModelCatalog() {
    await api.refreshCatalog();
    const modelCatalog = await api.getModelCatalog();
    set({ modelCatalog });
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
      rightTab: 'params',
      scrollToNodeId: null,
    });
  },

  adoptWorkflow(workflow) {
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
      rightTab: 'params',
      scrollToNodeId: null,
    });
  },

  applyOptimisticOp(op) {
    try {
      const workflow = applyPatch<Workflow>(get().workflow, [op]);
      set({ workflow });
      return true;
    } catch (err) {
      if (err instanceof PatchError) {
        console.warn('[flow] optimistic patch-op skipped:', err.message);
        return false;
      }
      throw err;
    }
  },

  async loadWorkflow(id) {
    const workflow = await api.getWorkflow(id);
    get().adoptWorkflow(workflow);
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

  async openRun(runId, opts) {
    const snapshot = await api.getRun(runId);
    const nodeRuns: Record<string, NodeRunUiState> = {};
    for (const rec of snapshot.nodes) {
      nodeRuns[rec.nodeId] = nodeRunFromRecord(rec);
    }
    // SPEC-step9.md §2 "auto-switch": this fires both when a *live* run
    // finishes (run()'s onDone refetches via openRun) and when the user
    // opens a past run from RunsPanel — both cases should land on Kết quả.
    // `ensureLatestRunLoaded` (SPEC-step18.md §4) opts out via
    // `switchTab: false` — it runs *because* the user is already on Kết quả.
    set((state) => ({
      runId,
      runStatus: snapshot.run.status,
      nodeRuns,
      rightTab: opts?.switchTab === false ? state.rightTab : 'results',
    }));
  },

  async ensureLatestRunLoaded() {
    const state = get();
    if (state.runId) return;
    const workflowId = state.workflow.id;
    try {
      const runs = await api.listRuns({ workflowId, limit: 1 });
      const latest = runs[0];
      if (!latest) return;
      // A `running` row can never resolve via this path (see the doc
      // comment above) — leave it unloaded rather than bricking ▶ Run.
      if (latest.status === 'running') return;
      // Re-check after the await: the user may have started a live run, hit
      // an older run in RunsPanel, or navigated to a different workflow
      // while this fetch was in flight — any of those already set a `runId`
      // (or changed `workflow.id`) that this stale lookup must not clobber.
      if (get().runId || get().workflow.id !== workflowId) return;
      await get().openRun(latest.id, { switchTab: false });
    } catch {
      // Silent fail (mirrors refreshEstimate above) — ResultsPanel just
      // keeps showing its "Chưa có run nào" placeholder.
    }
  },

  async validate() {
    const res = await api.validateWorkflow(get().workflow);
    set({ validationIssues: res.issues });
    return res.ok;
  },

  async refreshEstimate() {
    try {
      const estimate = await api.estimateWorkflowCost(get().workflow);
      set({ costEstimate: estimate });
    } catch {
      // Silent fail (spec §3): a transient network error shouldn't clobber
      // the toolbar with an error banner — the 💰 badge just doesn't update.
    }
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

  toggleNodePreviews() {
    set((state) => ({ showNodePreviews: !state.showNodePreviews }));
  },

  setRightTab(tab) {
    set({ rightTab: tab });
  },

  requestScrollToNode(id) {
    set({ rightTab: 'results', scrollToNodeId: id });
  },

  clearScrollToNode() {
    set({ scrollToNodeId: null });
  },

  setNodeSizes(sizes) {
    set({ nodeSizes: sizes });
  },

  autoLayout() {
    set((state) => ({
      workflow: layoutWorkflow(state.workflow, state.nodeSizes),
      dirty: true,
    }));
  },

  requestFitView() {
    set((state) => ({ fitViewNonce: state.fitViewNonce + 1 }));
  },
}));
