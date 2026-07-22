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
  CutPlan,
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
// SPEC-step27.md §3 — every mutator below that a USER can trigger from the
// canvas (as opposed to `adoptWorkflow`/`applyOptimisticOp`, which mirror an
// AI turn) logs a `PatchOp` through this queue after applying its change
// locally, unless the workflow has no paired conversation (`hasActiveConversation`).
import {
  cancelPendingMove,
  cancelPendingNodeUpdate,
  enqueueManualOps,
  flushManualLog,
  hasActiveConversation,
  scheduleMove,
  scheduleNodeParamsChange,
} from './manualLog.ts';

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
  /**
   * SPEC-step33.md §33e-1 — set while a node is parked in the `'awaiting'`
   * state (a human-in-the-loop `CutPlan` review gate, server 33c): the run
   * that's paused, which node it's paused at, and the plan to review/edit.
   * `null` whenever no gate is currently pending (the common case). Cleared
   * on a terminal `run:state` (success/error) and after a successful
   * `resumeAwaiting`/`cancelAwaiting`.
   */
  awaitingGate: { runId: string; nodeId: string; plan: CutPlan } | null;
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
  /** SPEC-step27.md §5 adds the 4th "Lịch sử" tab (HistoryPanel). */
  rightTab: 'params' | 'runs' | 'results' | 'history';
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
   *
   * SPEC-step31.md F1 — also bumps `fitViewNonce` (see below), but ONLY when
   * the incoming workflow's `id` differs from whatever was previously
   * loaded: that's the "first load or conversation switch" case the audit
   * found broken (React Flow's own `fitView` prop only fires once at mount,
   * and the canvas stays mounted across a conversation switch — see
   * `canvas/FlowCanvas.tsx`'s `fitViewNonce` effect / `panels/CanvasPane.tsx`'s
   * visible-effect). A SAME-id adoption is a reconcile of the workflow
   * already on screen (`store/chat.ts`'s SSE `message` handler — which fits
   * separately and unconditionally right after this call, unchanged since
   * step 26 — `HistoryPanel.tsx`'s revert, a future `POST .../changes`
   * response) and must never reset the pan/zoom the user is mid-gesture on.
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
  /**
   * SPEC-step33.md §33e-1 — approves (possibly human-edited) `awaitingGate`
   * and resumes the paused run. Throws (leaving `awaitingGate` untouched,
   * matching how `run()`'s own createRun-rejection path works above) on a
   * 400 shape-invalid plan or a 409 stale gate — `CutPlanReview.tsx` shows
   * the message inline rather than this store silent-failing it. Clears
   * `awaitingGate` only after the server confirms the resume.
   */
  resumeAwaiting(plan: CutPlan): Promise<void>;
  /**
   * SPEC-step33.md §33e-1 — "Huỷ": aborts the paused run entirely (server
   * `/stop`) rather than resuming it. Clears `awaitingGate` unconditionally
   * once the request settles — even a 409 ("already not active") means
   * there's nothing left to keep waiting on.
   */
  cancelAwaiting(): Promise<void>;
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
  setRightTab(tab: 'params' | 'runs' | 'results' | 'history'): void;
  /** See `scrollToNodeId` above. */
  requestScrollToNode(id: string): void;
  clearScrollToNode(): void;
  /** See `nodeSizes` above. */
  setNodeSizes(sizes: Record<string, NodeSize>): void;
  /**
   * SPEC-step16.md §3 — recomputes every node's position via
   * `layoutWorkflow` using the current `nodeSizes` (falling back to
   * NodeCard's fixed box size for anything not yet measured), keeping the
   * current selection. Backs both the Toolbar "🪄 Sắp xếp" button and
   * `store/chat.ts`'s post-turn re-layout of the AI's own coarse positions.
   *
   * SPEC-step31.md F7 — `opts.log` (default `true`) decides how the moved
   * positions are persisted:
   * - `true` (Toolbar's manual click) with an active conversation: goes
   *   through the SAME `manualLog.ts` queue a node drag does — ONE entry
   *   batching every node that actually moved as its own `move-node` op
   *   (cosmetic scope), summary "sắp xếp lại bố cục (N node)". Log success
   *   means already-persisted, so `dirty` is NOT set here (matches every
   *   other logged mutator below).
   * - `false` (`store/chat.ts`'s post-turn call) — or no active
   *   conversation — keeps the pre-existing behavior: just set `dirty: true`
   *   (the old Save-button path), no manualLog entry. `chat.ts` passes
   *   `false` deliberately: this re-layout is a coarse client-side nudge on
   *   top of a workflow the server *just* persisted from the AI turn itself
   *   — logging it as a "tay" (manual) change would mislabel that AI-turn
   *   side effect (see `manualLog.ts`'s own header).
   */
  autoLayout(opts?: { log?: boolean }): void;
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
  awaitingGate: null,
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
      // Post-review fix (HIGH) — a gate parked on the workflow being left
      // behind must not keep `CutPlanReview`'s full-canvas overlay up over
      // the new (empty) one.
      awaitingGate: null,
      dirty: false,
      validationIssues: [],
      forceNodeIds: [],
      rightTab: 'params',
      scrollToNodeId: null,
    });
  },

  adoptWorkflow(workflow) {
    stopActiveRunSubscription();
    set((state) => ({
      workflow,
      selectedNodeId: null,
      runId: undefined,
      runStatus: undefined,
      nodeRuns: {},
      // Post-review fix (HIGH) — same reasoning as `newWorkflow` above:
      // switching conversation/workflow must drop any gate left over from
      // whatever workflow was previously loaded (its run is no longer
      // being displayed, so its gate has no business staying on-screen).
      awaitingGate: null,
      dirty: false,
      validationIssues: [],
      forceNodeIds: [],
      rightTab: 'params',
      scrollToNodeId: null,
      // SPEC-step31.md F1 — see the interface doc comment above: only a
      // workflow.id change re-centers the viewport.
      ...(state.workflow.id !== workflow.id ? { fitViewNonce: state.fitViewNonce + 1 } : {}),
    }));
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
    // SPEC-step27.md §2 — flush mốc bắt buộc: any debounced manual-change
    // entry still pending must be sent (and awaited) before Save's PUT, so
    // the change log doesn't lag behind what's about to be persisted.
    await flushManualLog();
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
    // SPEC-step27.md §3/§4 — a workflow with an active conversation
    // auto-persists this op through the manual-change queue below, so it
    // never needs the old `dirty`/Save-button path; a conversation-less
    // workflow (legacy orphan edge case) keeps exactly the old behavior.
    const logged = hasActiveConversation();
    set({
      workflow: { ...state.workflow, nodes: [...state.workflow.nodes, node] },
      ...(logged ? {} : { dirty: true }),
    });
    // SPEC-step32.md B3-FE — appends the node's label when it has one (e.g.
    // a node the AI created earlier in the conversation, since `add-node`
    // ops can carry a `label`, packages/shared's patch.ts §schema); `addNode`
    // itself never sets one today (no label-editing UI exists yet — see
    // store/manualLog.ts's `scheduleNodeLabelChange`), so this is a no-op in
    // practice for now but keeps the format consistent with `removeNode`.
    if (logged) {
      enqueueManualOps(
        state.workflow.id,
        [{ op: 'add-node', node }],
        `thêm node ${type} (${id})${node.label ? ` "${node.label}"` : ''}`,
      );
    }
    return id;
  },

  updateNodeParams(id, params) {
    const prevParams = get().workflow.nodes.find((n) => n.id === id)?.params ?? {};
    const logged = hasActiveConversation();
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) => (n.id === id ? { ...n, params } : n)),
      },
      ...(logged ? {} : { dirty: true }),
    }));
    // SPEC-step27.md §2/§3 — debounced 800ms after the last keystroke;
    // `scheduleNodeParamsChange` keeps `prevParams` as the ORIGINAL baseline
    // across repeated calls within the same debounce window, so only the net
    // diff against the value still standing after that silence gets logged.
    if (logged) scheduleNodeParamsChange(id, prevParams, params);
  },

  updateNodePosition(id, position) {
    const logged = hasActiveConversation();
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
      },
      ...(logged ? {} : { dirty: true }),
    }));
    // SPEC-step27.md §3 — FlowCanvas reports a `position` change on every
    // pointermove during a drag; `scheduleMove`'s own 500ms debounce (not
    // this call site) is what coalesces those into one `move-node` entry.
    if (logged) scheduleMove(id, position);
  },

  removeNode(id) {
    const logged = hasActiveConversation();
    const state = get();
    const workflowId = state.workflow.id;
    // SPEC-step32.md B3-FE — captured BEFORE the `set()` below removes the
    // node from the workflow, so the summary can still name it (`describeNode`
    // in store/manualLog.ts has the same "read before it's gone" concern for
    // update-node, but there the node is still present at flush time — here
    // it's about to be deleted synchronously by this very call).
    const label = state.workflow.nodes.find((n) => n.id === id)?.label;
    if (logged) {
      // Post-review fix (major finding #2): cancel any still-pending
      // params/label (800ms) or move (500ms) debounce for this node BEFORE
      // it's gone — otherwise that debounce fires later, POSTs an
      // `update-node`/`move-node` for an id the server no longer has, and
      // the resulting 422 used to be misread as a network failure.
      cancelPendingNodeUpdate(id);
      cancelPendingMove(id);
    }
    set((state) => ({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.filter((n) => n.id !== id),
        edges: state.workflow.edges.filter((e) => e.from.node !== id && e.to.node !== id),
      },
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
      ...(logged ? {} : { dirty: true }),
    }));
    // A single remove-node op already cascades to every edge touching it
    // (packages/shared's applyPatch) — no separate remove-edge entries needed.
    if (logged) {
      enqueueManualOps(
        workflowId,
        [{ op: 'remove-node', nodeId: id }],
        `xoá node ${id}${label ? ` "${label}"` : ''}`,
      );
    }
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
    const logged = hasActiveConversation();
    set({
      workflow: { ...workflow, edges: [...workflow.edges, edge] },
      ...(logged ? {} : { dirty: true }),
    });
    if (logged) {
      enqueueManualOps(
        workflow.id,
        [{ op: 'add-edge', edge }],
        `nối ${from.node}.${from.port} → ${to.node}.${to.port}`,
      );
    }
    return true;
  },

  removeEdge(id) {
    const logged = hasActiveConversation();
    const workflowId = get().workflow.id;
    set((state) => ({
      workflow: { ...state.workflow, edges: state.workflow.edges.filter((e) => e.id !== id) },
      ...(logged ? {} : { dirty: true }),
    }));
    if (logged) enqueueManualOps(workflowId, [{ op: 'remove-edge', edgeId: id }], `xoá edge ${id}`);
  },

  setWorkflowJson(workflow) {
    // SPEC-step27.md §4 — deliberate exclusion ("hạn chế ghi nhận có chủ
    // đích"): raw JSON edits (JsonView.tsx) and the workflow-name field
    // (Toolbar.tsx, also routed through this setter) keep the pre-existing
    // `dirty: true` + manual-Save (PUT) path and never call manualLog — the
    // AI still sees the latest workflow every turn via the system prompt,
    // it just won't show up as its own row in the change-log digest. Not
    // expanding this step's scope to cover it.
    set((state) => ({
      workflow,
      selectedNodeId: workflow.nodes.some((n) => n.id === state.selectedNodeId) ? state.selectedNodeId : null,
      dirty: true,
    }));
  },

  async run(force) {
    // SPEC-step27.md §2 — same mandatory flush point as saveWorkflow() above
    // (also covers the `dirty` branch below, which calls saveWorkflow() and
    // would otherwise flush a second time there — harmless, the queue is
    // already drained by then).
    await flushManualLog();
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
    set({ runId, runStatus: 'running', nodeRuns: {}, validationIssues: [], awaitingGate: null });

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
        set((state) => {
          // Post-review fix (MEDIUM) — SPEC-step33.md §33e requires
          // surviving a reconnect mid-gate: EventSource auto-reconnects on
          // any network blip (a gate can sit open up to 30 min waiting on
          // a human), and a fresh connection replays `snapshot`, NOT the
          // original `node:state` — so this is the only event a
          // reconnected client is guaranteed to see for an already-open
          // gate. Only set it from here when nothing is already tracked
          // for this run (a snapshot naturally repeats on every
          // reconnect; it must not re-derive/clobber an `awaitingGate` a
          // user is actively mid-edit on from the *original* `node:state`
          // or the very same fallback below).
          const awaitingRec = data.nodes.find((rec) => rec.state === 'awaiting');
          const alreadyTracked = state.awaitingGate?.runId === runId;
          if (!awaitingRec || alreadyTracked) {
            return { runStatus: data.run.status, nodeRuns };
          }
          const plan = (awaitingRec.outputs?.pendingApproval as { plan?: CutPlan } | undefined)?.plan;
          return {
            runStatus: data.run.status,
            nodeRuns,
            ...(plan ? { awaitingGate: { runId, nodeId: awaitingRec.nodeId, plan } } : {}),
          };
        });
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
        // SPEC-step33.md §33e-1 — the event usually carries the plan
        // directly (`pendingApproval`, server 33c); fall back to a full
        // `getRun` (the node's `outputs.pendingApproval.plan`) only for the
        // case where THIS event itself is missing the payload. Surviving a
        // dropped-connection reconnect mid-gate is a separate case, handled
        // by `onSnapshot` above (a reconnect replays `snapshot`, not this
        // event).
        if (data.state === 'awaiting') {
          const fromEvent = data.pendingApproval?.plan;
          if (fromEvent) {
            set({ awaitingGate: { runId, nodeId: data.nodeId, plan: fromEvent } });
          } else {
            void api.getRun(runId).then((snapshot) => {
              if (!isDisplayed()) return;
              const rec = snapshot.nodes.find((n) => n.nodeId === data.nodeId);
              const plan = (rec?.outputs?.pendingApproval as { plan?: CutPlan } | undefined)?.plan;
              if (plan) {
                set({ awaitingGate: { runId, nodeId: data.nodeId, plan } });
              }
            });
          }
        }
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
        // SPEC-step33.md §33e-1 — a terminal status means whatever gate was
        // pending (if any — `stopRun` while awaiting lands here too) is
        // moot; a resume instead moves the engine back to `'running'` and a
        // *later* node:state may open a fresh gate.
        set({ runStatus: data.status, ...(data.status === 'running' ? {} : { awaitingGate: null }) });
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
      // Post-review fix (HIGH) — `openRun` loads a *static* snapshot; it
      // never subscribes to SSE, so it can never itself observe a fresh
      // gate opening. Whatever `awaitingGate` was pending before this call
      // belonged to a run this view is about to stop showing (either a
      // just-finished live run whose `run()` handler already cleared it,
      // or the user jumping to a different/historical run from RunsPanel)
      // — either way it must not survive into the run now being displayed.
      awaitingGate: null,
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

  async resumeAwaiting(plan) {
    const gate = get().awaitingGate;
    if (!gate) return;
    // Let a 400 (bad plan shape) / 409 (stale gate) propagate to the
    // caller (CutPlanReview) rather than swallowing it here — matches
    // `run()`'s own createRun-rejection handling above, which also leaves
    // state untouched and lets the caller decide what to show.
    await api.resumeRun(gate.runId, gate.nodeId, plan);
    set({ awaitingGate: null });
  },

  async cancelAwaiting() {
    const gate = get().awaitingGate;
    if (!gate) return;
    try {
      await api.stopRun(gate.runId);
    } catch {
      // Swallowed deliberately (mirrors `refreshEstimate`/
      // `ensureLatestRunLoaded` above): a 404/409 ("already not active")
      // still means there's nothing left worth staying gated on, and
      // `CutPlanReview`'s "Huỷ" isn't wired to show an inline error the way
      // "Duyệt & cắt" is (see `resumeAwaiting`, which deliberately doesn't
      // swallow).
    } finally {
      set({ awaitingGate: null });
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

  autoLayout(opts) {
    const state = get();
    const laidOut = layoutWorkflow(state.workflow, state.nodeSizes);
    const logged = (opts?.log ?? true) && hasActiveConversation();

    if (!logged) {
      set({ workflow: laidOut, dirty: true });
      return;
    }

    // SPEC-step31.md F7 — only the nodes whose position actually changed
    // (comparing against the pre-layout workflow, not e.g. every node
    // unconditionally, which `layoutWorkflow` recomputes regardless of
    // whether the result differs from where it already was). `position` is
    // optional on `WorkflowNode` (a node can be un-positioned before its
    // first layout) even though `layoutWorkflow` always fills one in here —
    // fall back to the same `{ x: 0, y: 0 }` `layoutWorkflow` itself uses.
    const moves: PatchOp[] = [];
    const movedNodeIds: string[] = [];
    for (const node of laidOut.nodes) {
      const position = node.position ?? { x: 0, y: 0 };
      const before = state.workflow.nodes.find((n) => n.id === node.id);
      const beforePosition = before?.position ?? { x: 0, y: 0 };
      if (!before || beforePosition.x !== position.x || beforePosition.y !== position.y) {
        moves.push({ op: 'move-node', nodeId: node.id, position });
        movedNodeIds.push(node.id);
      }
    }
    set({ workflow: laidOut });
    if (moves.length > 0) {
      // Post-review fix (F7 follow-up) — a node dragged just before this
      // click still has its OWN 500ms move debounce armed (`scheduleMove`,
      // manualLog.ts) targeting its pre-layout position. Left alone, that
      // stale entry fires after this batch (same serialized queue, FIFO)
      // and silently reintroduces the old position server-side with no
      // `dirty` flag to catch the divergence (SPEC-step31.md F7 review).
      // Cancel it for every node this batch itself is about to move so this
      // entry's own position is the last word.
      for (const nodeId of movedNodeIds) cancelPendingMove(nodeId);
      enqueueManualOps(state.workflow.id, moves, `sắp xếp lại bố cục (${moves.length} node)`);
    }
  },

  requestFitView() {
    set((state) => ({ fitViewNonce: state.fitViewNonce + 1 }));
  },
}));
