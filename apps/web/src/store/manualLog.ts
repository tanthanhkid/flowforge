/**
 * SPEC-step27.md §2 — turns every manual ("tay") canvas mutation into a
 * `PatchOp` logged to `workflow_changes` via `POST /api/workflows/:id/changes`
 * (routes/changes.ts, SPEC-step22.md §5), so the AI reads it back next turn
 * through `changeDigest.ts` and the user gets an undo path (`revertChange`,
 * wired in `HistoryPanel.tsx`).
 *
 * A pure module — no React, no store of its own. `store/flow.ts`'s mutators
 * call the scheduling functions below right after applying their change
 * locally (same "optimistic first, server reconciles after" shape as
 * `applyOptimisticOp`/`chatTurn`, SPEC-step26.md); this module owns only the
 * queueing/debounce/version-chain/rebase plumbing.
 *
 * Post-review fixes (this file's own header used to say every read below was
 * "fresh via getState() at send time, never captured at schedule time" — that
 * was itself the bug): `expectedVersion` is still correctly read fresh at
 * send time (that's what keeps the version chain correct across several
 * entries *for the same workflow*), but WHICH workflow an entry belongs to
 * must be captured at schedule time and never re-derived later — otherwise a
 * conversation switch mid-debounce (or mid-queue, for a slow in-flight
 * request) sends an op meant for workflow A to whatever workflow happens to
 * be current by the time the entry actually fires. Every entry now carries
 * its own `workflowId`, captured at the moment the user acted (schedule time
 * for the two debounced mutators, call time for the four immediate ones —
 * see `store/flow.ts`'s call sites), and `processEntry`/`handleConflict`
 * refuse to send (or act on a conflict for) an entry whose captured
 * `workflowId` no longer matches the live canvas.
 *
 * Deliberately NOT used by JSON-view edits, workflow rename, or `autoLayout()`
 * (SPEC-step27.md §4 "hạn chế ghi nhận có chủ đích" / §3 scope) — those keep
 * the pre-existing PUT `saveWorkflow()` path. `autoLayout()` in particular
 * also runs automatically after every AI turn (store/chat.ts's `onMessage`)
 * as a coarse re-layout nudge — logging it here as a "user" change would
 * mislabel an AI-turn side effect as a manual edit.
 */
import { applyPatch, PatchError } from 'shared';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { PatchOp, Workflow } from '../api/types.ts';
import { toast } from '../ui/Toast.tsx';
import { useChatStore } from './chat.ts';
import { useFlowStore } from './flow.ts';

/** Debounce window for `update-node` (params/label) — SPEC-step27.md §2. */
const PARAMS_DEBOUNCE_MS = 800;
/** Debounce window for `move-node` — SPEC-step27.md §2. */
const MOVE_DEBOUNCE_MS = 500;
/** Spec §2: "Nhiều op gộp → nối bằng '; ' cắt 200 ký tự." */
const SUMMARY_MAX_LENGTH = 200;

const TOAST_SYNC_FAIL =
  'Không áp được thay đổi sau khi đồng bộ — canvas đã cập nhật theo bản mới nhất.';
const TOAST_SYNC_OK = 'Đã đồng bộ với thay đổi mới nhất';
const TOAST_NETWORK_FAIL = 'Không lưu được thay đổi — bấm Save để lưu thủ công.';

/**
 * SPEC-step27.md §3 — the one gate for "should this mutation be logged at
 * all": a workflow with no paired conversation (the legacy/orphan edge case —
 * a workflow that predates the conversation-per-workflow invariant, or one
 * whose backfill hasn't run yet) keeps the pre-existing, untracked behavior
 * unchanged. `store/flow.ts`'s mutators call this once per action to decide
 * both whether to call anything below AND whether to still set the old
 * `dirty: true` (their fallback save path).
 */
export function hasActiveConversation(): boolean {
  return useChatStore.getState().activeConversationId !== null;
}

// ---- the serialized queue --------------------------------------------------

let queueTail: Promise<void> = Promise.resolve();

function truncateSummary(summary: string): string {
  return summary.length > SUMMARY_MAX_LENGTH ? summary.slice(0, SUMMARY_MAX_LENGTH) : summary;
}

/**
 * SPEC-step27.md §2 — pushes one change-log entry (one or more ops sharing a
 * single summary) onto the client-side promise-chain queue. The entry only
 * actually sends once every earlier entry has fully settled (including any
 * 409 rebase — see `processEntry`/`handleConflict` below), which is what
 * keeps `workflow_changes` rows in the same order the user actually made the
 * edits, and keeps two debounced entries (a param edit racing a node move)
 * from landing out of order.
 *
 * `workflowId` is the workflow this entry was made FOR — captured by the
 * caller at the moment the user actually acted (post-review fix, critical
 * finding #1/#4: never re-derived live at send time, which is what let an
 * entry silently get redirected to whatever workflow happened to be current
 * once its debounce/queue turn came up).
 */
export function enqueueManualOps(workflowId: string, ops: PatchOp[], summary: string): void {
  if (ops.length === 0) return;
  const truncated = truncateSummary(summary);
  queueTail = queueTail.then(() => processEntry(workflowId, ops, truncated));
}

/**
 * True once the canvas has moved on from the workflow this entry was made
 * for — a conversation switch (or, in principle, `newWorkflow()`) that
 * happened after the entry was scheduled/enqueued but before it actually
 * sent. `store/chat.ts`'s `selectConversation`/`newConversation`/
 * `removeConversation` all await `flushManualLog()` before switching, which
 * keeps this rare in practice — this is the last-resort net for whatever
 * still slips through (e.g. an in-flight network request that resolves
 * after a switch that started elsewhere).
 */
function staleForCurrentWorkflow(workflowId: string): boolean {
  return useFlowStore.getState().workflow.id !== workflowId;
}

function warnDiscarded(workflowId: string, reason: string): void {
  console.warn(`[manualLog] discarding change-log entry for workflow "${workflowId}" — ${reason}`);
}

async function processEntry(workflowId: string, ops: PatchOp[], summary: string): Promise<void> {
  if (staleForCurrentWorkflow(workflowId)) {
    warnDiscarded(workflowId, 'the canvas has since switched to a different workflow');
    return;
  }
  // Read fresh, not captured at enqueue time — this IS the version chain:
  // entry 2 must send whatever version entry 1's response (or entry 1's own
  // rebase) actually left behind, not whatever was current when the user
  // made entry 2's edit (which may already be stale by the time entry 2
  // actually fires, since entry 1 might still be in flight). Safe to read
  // fresh here specifically because the check above already confirmed the
  // live workflow is still the one this entry belongs to.
  const expectedVersion = useChatStore.getState().workflowVersion;

  try {
    const res = await api.postManualChange(workflowId, { ops, summary, expectedVersion });
    useChatStore.setState({ workflowVersion: res.version });
    // Deliberately NOT reconciling `useFlowStore`'s `workflow` from
    // `res.workflow` here (unlike the 409/AI-turn paths, which have no other
    // source of truth): the local workflow already reflects this exact op
    // (that's what was submitted) plus possibly further LOCAL edits made
    // while this request was in flight — overwriting it with a snapshot that
    // only reflects ops up through *this* entry would silently drop those.
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await handleConflict(workflowId, ops, summary, err);
      return;
    }
    if (err instanceof ApiError && err.status === 422) {
      // Post-review fix (major finding #2): the op's target node/edge no
      // longer exists server-side — the common case is the user deleting a
      // node within the same debounce window a param edit for it was still
      // pending in (`store/flow.ts`'s `removeNode` now proactively cancels
      // that debounce via `cancelPendingNodeUpdate`/`cancelPendingMove`
      // below, so this shouldn't even fire for that exact race anymore) —
      // but this stays as a quiet fallback for anything else that can
      // invalidate an op's target between schedule and send (another
      // tab/session's edit, an AI turn's own removal). Whatever the entity's
      // fate was, it's already resolved and persisted server-side — there is
      // nothing here to save, so no `dirty`/scary toast (mirrors
      // `applyOptimisticOp`'s existing quiet PatchError handling in
      // store/flow.ts).
      console.warn('[manualLog] dropping stale op — target no longer exists server-side:', err.message);
      return;
    }
    // Network failure or 5xx — the change never persisted server-side. The
    // pre-existing Save button (PUT, a full upsert) is the safety net
    // (SPEC-step27.md §2/§4) — no infinite retry here.
    useFlowStore.setState({ dirty: true });
    toast(TOAST_NETWORK_FAIL, 'error');
  }
}

/** ids of nodes an op batch creates/updates/moves/removes — see `mergeLocalOnly` below. */
function touchedNodeIds(ops: PatchOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case 'add-node':
        ids.add(op.node.id);
        break;
      case 'update-node':
      case 'move-node':
      case 'remove-node':
        ids.add(op.nodeId);
        break;
    }
  }
  return ids;
}

/** ids of edges an op batch creates/removes — see `mergeLocalOnly` below. */
function touchedEdgeIds(ops: PatchOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === 'add-edge') ids.add(op.edge.id);
    if (op.op === 'remove-edge') ids.add(op.edgeId);
  }
  return ids;
}

/**
 * Folds whatever nodes/edges exist in `local` but not yet in `base` (by id)
 * into `base` — i.e. "bring over anything the canvas already has optimistic-
 * ally that this server snapshot doesn't know about yet" (other manual-log
 * entries still queued behind this one, each already applied to the canvas
 * synchronously by their own mutator well before their own network request
 * ever goes out — see `store/flow.ts`). `excludeNodeIds`/`excludeEdgeIds`
 * additionally drop ids that belong to THIS entry's own now-known-unrebase-
 * able ops, rather than re-introducing an add the server has just proven
 * can't land.
 */
function mergeLocalOnly(
  base: Workflow,
  local: Workflow,
  excludeNodeIds: Set<string>,
  excludeEdgeIds: Set<string>,
): Workflow {
  const baseNodeIds = new Set(base.nodes.map((n) => n.id));
  const baseEdgeIds = new Set(base.edges.map((e) => e.id));
  const extraNodes = local.nodes.filter((n) => !baseNodeIds.has(n.id) && !excludeNodeIds.has(n.id));
  const extraEdges = local.edges.filter((e) => !baseEdgeIds.has(e.id) && !excludeEdgeIds.has(e.id));
  if (extraNodes.length === 0 && extraEdges.length === 0) return base;
  return { ...base, nodes: [...base.nodes, ...extraNodes], edges: [...base.edges, ...extraEdges] };
}

/**
 * SPEC-step27.md §2 — exactly one rebase attempt: use the server's latest
 * workflow + version as the new base, replay `ops` onto it locally, re-POST
 * once. A second conflict on that retry, or a `PatchError` replaying `ops`
 * onto the new base (e.g. the node they touched no longer exists there),
 * gives up rather than looping — DESIGN-ai-native.md §6's "rebase 1 lần,
 * không rebase vô hạn".
 *
 * Post-review fix (major finding #3): this used to call
 * `useFlowStore.getState().adoptWorkflow(body.workflow)` — a full-state reset
 * (selection, right-tab, live-run subscription, and every other node/edge
 * the canvas had locally but hadn't yet round-tripped through THIS entry)
 * before reapplying only this entry's own `ops`. That silently dropped any
 * OTHER pending-but-already-applied local edit (e.g. a 2nd node added while
 * this entry's request was in flight) from the canvas, even though it would
 * go on to persist server-side just fine moments later via its own queue
 * entry — it just vanished from view until reload. Fixed by never touching
 * anything but `workflow` itself (no side effects), and by merging the
 * server's snapshot with whatever the local canvas has that the server
 * doesn't know about yet (`mergeLocalOnly` above) instead of discarding it.
 */
async function handleConflict(
  workflowId: string,
  ops: PatchOp[],
  summary: string,
  err: ApiError,
): Promise<void> {
  if (staleForCurrentWorkflow(workflowId)) {
    warnDiscarded(workflowId, 'the canvas has since switched to a different workflow (conflict path)');
    return;
  }

  const body = err.body as { workflow?: Workflow; version?: number } | undefined;
  if (!body?.workflow || body.version === undefined) {
    // Malformed/unexpected 409 body — nothing sound to rebase onto.
    useFlowStore.setState({ dirty: true });
    toast(TOAST_NETWORK_FAIL, 'error');
    return;
  }

  useChatStore.setState({ workflowVersion: body.version });

  let rebased: Workflow;
  try {
    rebased = applyPatch(body.workflow, ops);
  } catch (patchErr) {
    if (patchErr instanceof PatchError) {
      // Dead end for THIS entry only — its own ops can no longer apply onto
      // the server's latest state (e.g. another tab/session removed the
      // node it targeted). Still fold in whatever OTHER entries have
      // already applied optimistically onto the local canvas, dropping only
      // this entry's own now-invalid ids rather than re-introducing them.
      const local = useFlowStore.getState().workflow;
      const merged = mergeLocalOnly(body.workflow, local, touchedNodeIds(ops), touchedEdgeIds(ops));
      useFlowStore.setState({ workflow: merged });
      toast(TOAST_SYNC_FAIL, 'error');
      return;
    }
    throw patchErr;
  }

  // Rebase succeeded structurally onto the server's latest workflow — fold
  // in any OTHER pending entry's already-applied local-only nodes/edges too,
  // rather than resetting the canvas down to just `rebased`.
  const local = useFlowStore.getState().workflow;
  const merged = mergeLocalOnly(rebased, local, new Set(), new Set());
  useFlowStore.setState({ workflow: merged });

  try {
    const res = await api.postManualChange(workflowId, { ops, summary, expectedVersion: body.version });
    useChatStore.setState({ workflowVersion: res.version });
    toast(TOAST_SYNC_OK, 'info');
  } catch (err2) {
    if (err2 instanceof ApiError && err2.status === 409) {
      toast(TOAST_SYNC_FAIL, 'error');
      return;
    }
    useFlowStore.setState({ dirty: true });
    toast(TOAST_NETWORK_FAIL, 'error');
  }
}

// ---- debounced update-node (params/label), 800ms ---------------------------

interface PendingNodeUpdate {
  /** The workflow active when this debounce window started — see the file header's post-review-fix note. */
  workflowId: string;
  timer: ReturnType<typeof setTimeout>;
  paramsTouched: boolean;
  baselineParams: Record<string, unknown>;
  latestParams: Record<string, unknown>;
  labelTouched: boolean;
  baselineLabel: string | undefined;
  latestLabel: string | undefined;
}

const pendingNodeUpdates = new Map<string, PendingNodeUpdate>();

/** Only the keys whose value actually changed between the debounce window's baseline and its final value (spec §2: "chỉ giữ giá trị cuối mỗi param"). */
function diffParams(baseline: Record<string, unknown>, latest: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(latest)) {
    if (baseline[key] !== value) changed[key] = value;
  }
  return changed;
}

function flushNodeUpdate(nodeId: string): void {
  const entry = pendingNodeUpdates.get(nodeId);
  pendingNodeUpdates.delete(nodeId);
  if (!entry) return;

  const changedParams = entry.paramsTouched ? diffParams(entry.baselineParams, entry.latestParams) : {};
  const labelChanged = entry.labelTouched && entry.latestLabel !== entry.baselineLabel;
  const hasParamsChange = Object.keys(changedParams).length > 0;
  // Net no-op (e.g. the user typed a value then undid it back to the
  // original within the same debounce window) — nothing to log.
  if (!hasParamsChange && !labelChanged) return;

  const op: PatchOp = {
    op: 'update-node',
    nodeId,
    ...(hasParamsChange ? { params: changedParams } : {}),
    ...(labelChanged ? { label: entry.latestLabel } : {}),
  };

  const fields: string[] = [];
  for (const [key, value] of Object.entries(changedParams)) {
    fields.push(`${key} = ${JSON.stringify(value)}`);
  }
  if (labelChanged) fields.push(`label = ${JSON.stringify(entry.latestLabel)}`);

  enqueueManualOps(entry.workflowId, [op], `node ${nodeId}: ${fields.join(', ')}`);
}

/**
 * SPEC-step27.md §3 — `store/flow.ts`'s `updateNodeParams` calls this on
 * every keystroke/select; only the value still standing 800ms after the last
 * call actually gets logged. `prevParams` is only used to seed the
 * debounce-window's ORIGINAL baseline the first time this fires for a given
 * node — repeated calls within the same window keep that original baseline
 * and just move `latestParams` forward, so the eventual diff is against
 * what was there before the user started this edit, not against the
 * second-to-last keystroke. Likewise, `workflowId` (the workflow active
 * right now, at the moment of THIS call) is only captured the first time a
 * window opens for this node — see the file header's post-review-fix note.
 */
export function scheduleNodeParamsChange(
  nodeId: string,
  prevParams: Record<string, unknown>,
  nextParams: Record<string, unknown>,
): void {
  const existing = pendingNodeUpdates.get(nodeId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.latestParams = nextParams;
    existing.paramsTouched = true;
    existing.timer = setTimeout(() => flushNodeUpdate(nodeId), PARAMS_DEBOUNCE_MS);
    return;
  }
  pendingNodeUpdates.set(nodeId, {
    workflowId: useFlowStore.getState().workflow.id,
    paramsTouched: true,
    baselineParams: prevParams,
    latestParams: nextParams,
    labelTouched: false,
    baselineLabel: undefined,
    latestLabel: undefined,
    timer: setTimeout(() => flushNodeUpdate(nodeId), PARAMS_DEBOUNCE_MS),
  });
}

/**
 * Not currently called from any `store/flow.ts` mutator — no label-editing
 * UI exists yet in this codebase (SPEC-step27.md implementation notes: no
 * `updateNodeLabel` action/UI predates this step, so wiring one is out of
 * this step's scope). Kept alongside `scheduleNodeParamsChange` — sharing the
 * same per-node debounce bucket/window — since DESIGN-ai-native.md §II.5's
 * action table treats "sửa label" as the same `update-node`/800ms family, so
 * a future label-edit UI can wire straight into this without touching the
 * debounce machinery.
 */
export function scheduleNodeLabelChange(nodeId: string, prevLabel: string | undefined, nextLabel: string): void {
  const existing = pendingNodeUpdates.get(nodeId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.latestLabel = nextLabel;
    existing.labelTouched = true;
    existing.timer = setTimeout(() => flushNodeUpdate(nodeId), PARAMS_DEBOUNCE_MS);
    return;
  }
  pendingNodeUpdates.set(nodeId, {
    workflowId: useFlowStore.getState().workflow.id,
    paramsTouched: false,
    baselineParams: {},
    latestParams: {},
    labelTouched: true,
    baselineLabel: prevLabel,
    latestLabel: nextLabel,
    timer: setTimeout(() => flushNodeUpdate(nodeId), PARAMS_DEBOUNCE_MS),
  });
}

/**
 * Post-review fix (major finding #2) — `store/flow.ts`'s `removeNode` calls
 * this (and `cancelPendingMove` below) BEFORE enqueueing its own
 * `remove-node` op, so a still-pending 800ms param/label debounce for the
 * node being deleted never fires an `update-node` for an id the queue is
 * about to delete out from under it (which used to surface as a spurious
 * 422 → misread as a network failure, toasting "bấm Save để lưu thủ công"
 * over a delete that had, in fact, already persisted cleanly). Silent no-op
 * if nothing was pending for this node.
 */
export function cancelPendingNodeUpdate(nodeId: string): void {
  const entry = pendingNodeUpdates.get(nodeId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingNodeUpdates.delete(nodeId);
}

// ---- debounced move-node, 500ms -------------------------------------------

interface PendingMove {
  /** The workflow active when this debounce window started — see the file header's post-review-fix note. */
  workflowId: string;
  timer: ReturnType<typeof setTimeout>;
  position: { x: number; y: number };
}

const pendingMoves = new Map<string, PendingMove>();

function flushMove(nodeId: string): void {
  const entry = pendingMoves.get(nodeId);
  pendingMoves.delete(nodeId);
  if (!entry) return;
  enqueueManualOps(entry.workflowId, [{ op: 'move-node', nodeId, position: entry.position }], `di chuyển node ${nodeId}`);
}

/**
 * SPEC-step27.md §3 — FlowCanvas's `onNodesChange` reports a `position`
 * NodeChange on every pointermove during a drag (not just drag-end), so
 * `updateNodePosition` calls this on every one of those; only the position
 * still standing 500ms after the last call (i.e. ~500ms after the user
 * actually let go) gets logged, coalescing the whole drag into one entry.
 */
export function scheduleMove(nodeId: string, position: { x: number; y: number }): void {
  const existing = pendingMoves.get(nodeId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.position = position;
    existing.timer = setTimeout(() => flushMove(nodeId), MOVE_DEBOUNCE_MS);
    return;
  }
  pendingMoves.set(nodeId, {
    workflowId: useFlowStore.getState().workflow.id,
    position,
    timer: setTimeout(() => flushMove(nodeId), MOVE_DEBOUNCE_MS),
  });
}

/** See `cancelPendingNodeUpdate` above — same fix, for a still-pending drag debounce. */
export function cancelPendingMove(nodeId: string): void {
  const entry = pendingMoves.get(nodeId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingMoves.delete(nodeId);
}

// ---- flush mốc bắt buộc (SPEC-step27.md §2) --------------------------------

/**
 * Fires every pending debounce immediately, then waits for the whole queue
 * (including whatever those just fired enqueued) to fully drain.
 * `store/flow.ts`'s `run()` and `saveWorkflow()`, and `store/chat.ts`'s
 * `selectConversation()`/`newConversation()`/`removeConversation()` (post-
 * review fix, critical finding #1/#4 — switching conversations used to be
 * the one workflow-changing action that never flushed), all await this
 * first so the change log never lags behind — and, for the conversation
 * switchers specifically, so a still-debouncing edit gets its chance to send
 * to the workflow it actually belongs to before the canvas moves on.
 */
export async function flushManualLog(): Promise<void> {
  for (const nodeId of [...pendingNodeUpdates.keys()]) {
    const entry = pendingNodeUpdates.get(nodeId);
    if (!entry) continue;
    clearTimeout(entry.timer);
    flushNodeUpdate(nodeId);
  }
  for (const nodeId of [...pendingMoves.keys()]) {
    const entry = pendingMoves.get(nodeId);
    if (!entry) continue;
    clearTimeout(entry.timer);
    flushMove(nodeId);
  }
  await queueTail;
}

// Best-effort only (SPEC-step27.md §2, DESIGN-ai-native.md §9 risk list): a
// real network request kicked off during `beforeunload` has no completion
// guarantee — this just gives an in-flight debounce its best shot rather
// than dropping it silently the instant the tab starts closing, exactly as
// the spec accepts ("chấp nhận mất").
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    void flushManualLog();
  });
}
