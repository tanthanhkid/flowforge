/**
 * `runChatTurn` (SPEC-step21.md §4): the heart of the "Copilot Song Song"
 * redesign (docs/DESIGN-ai-native.md Phần I §6) — a single turn of the chat
 * loop. Unlike `generateWorkflow.ts` (first-time only) / `editNode.ts`
 * (single target node), every turn here is "just a patch": the workflow
 * always exists (possibly empty — `emptyWorkflow()`), and the LLM returns
 * `{ reply, ops }` where `ops` may be empty (pure Q&A / clarification, no
 * workflow change at all).
 *
 * Reuses generateWorkflow.ts/editNode.ts's retry-and-report-to-LLM pattern
 * (MAX_ATTEMPTS=3, `issuesToFeedback`, `AgentValidationError`), on top of
 * which this adds: an `AbortSignal` threaded into every `chatCompletion`
 * call (a real gap in the pre-step21 agent layer — see
 * `nodes/providers/openrouter.ts` — that this new entry point does NOT
 * inherit), and one round of optimistic-concurrency "rebuild the prompt and
 * retry" if the workflow was edited by hand while the LLM was thinking
 * (`workflows.saveVersioned`'s `expectedVersion`/`VersionConflictError`).
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { getEnv } from '../config.js';
import type { ChangesRepo } from '../db/changes.js';
import type { ConversationsRepo } from '../db/conversations.js';
import type { Message, MessageAttachment } from '../db/messages.js';
import type { MessagesRepo } from '../db/messages.js';
import { VersionConflictError, type WorkflowsRepo } from '../db/workflows.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, type ValidationIssue, type Workflow } from '../engine/schema.js';
import type { NodeRunRecord, RunRecord } from '../engine/stores.js';
import { chatCompletion, type ChatMessage } from '../nodes/providers/openrouter.js';
import { buildChangeDigest, resolveNodeRef } from './changeDigest.js';
import { AgentValidationError, issuesToFeedback } from './generateWorkflow.js';
import { extractJson } from './json.js';
import { applyPatch, changeScope, PatchError, PatchOpArraySchema, type PatchOp } from './patch.js';
import { buildChatSystemPrompt } from './promptBuilder.js';

const MAX_ATTEMPTS = 3;
const CHAT_HISTORY_LIMIT = 20;
/**
 * `changes.listByWorkflow` defaults to `limit: 100` (a pagination-style cap
 * meant for other future callers), which — combined with its `ORDER BY id
 * ASC` — would silently return the 100 OLDEST unseen changes instead of the
 * newest ones once a workflow accumulates more than 100 unseen manual edits.
 * `buildChangeDigest` already caps its OWN output to the newest 40 lines /
 * 6000 chars, so the digest query here just needs a generous upper bound
 * (never expected to bind in practice) rather than the pagination default.
 */
const DIGEST_CHANGE_FETCH_LIMIT = 5000;

const FAIL_SAFE_REPLY =
  'Workflow vừa được bạn chỉnh tay khi mình đang xử lý — gửi lại yêu cầu để mình cập nhật theo bản mới nhất.';

const PARSE_ISSUE: ValidationIssue = {
  code: 'parse',
  message: 'Không parse được JSON từ phản hồi của model.',
};

const ChatTurnResponseSchema = z.object({
  reply: z.string().min(1),
  ops: PatchOpArraySchema.default([]),
  // SPEC-step32.md B4 — the AI's own name/rename suggestion for this
  // conversation, only ever solicited (via `buildChatSystemPrompt`'s
  // `titleHint`) while `title_source !== 'user'`. Optional so every
  // pre-step32 fixture (`{ reply, ops }`, no `title` key at all) still
  // parses unchanged.
  title: z.string().min(1).max(80).optional(),
});

function zodErrorToIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'parse',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

/** Thrown when `conversationId` (or its 1-1 workflow) doesn't exist. */
export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation "${conversationId}" không tồn tại.`);
    this.name = 'ConversationNotFoundError';
  }
}

/** Thrown when `deps.signal` aborts mid-turn (SPEC-step21.md §4.7). The
 * assistant message has already been marked `status: 'error'` by the time
 * this is thrown — the caller doesn't need to do that itself. */
export class ChatTurnAbortedError extends Error {
  constructor() {
    super('Đã dừng theo yêu cầu');
    this.name = 'ChatTurnAbortedError';
  }
}

export interface ChatTurnEvents {
  /**
   * SPEC-step22.md §2 — fires SYNCHRONOUSLY right after the turn's two
   * messages (user + assistant placeholder) are written, i.e. still within
   * the synchronous prefix of this async function (before the first
   * `await chatCompletion(...)`). `chatTurnManager.ts`'s `start()` relies on
   * this: it calls `runChatTurn` without awaiting it, and by the time that
   * call expression returns a (still-pending) Promise, `onStart` has already
   * run — so the manager can synchronously hand `{ userMessageId,
   * assistantMessageId }` back to its own (synchronous) caller, the route.
   */
  onStart?: (ids: { userMessageId: string; assistantMessageId: string }) => void;
  onThinking?: (note: string) => void;
  onPatchOp?: (op: PatchOp, index: number, total: number) => void;
  /** SPEC-step32.md B4 — `title` is set only when this turn just applied a
   * new AI-suggested conversation title (`runChatTurn` already called
   * `conversations.rename(..., 'ai')` by the time this fires). */
  onMessage?: (p: {
    reply: string;
    workflow: Workflow;
    version: number;
    changeId: number | null;
    title?: string;
  }) => void;
}

export interface ChatTurnDeps {
  registry: NodeRegistry;
  workflows: WorkflowsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  changes: ChangesRepo;
  /** default: OPENROUTER_DEFAULT_MODEL, same as generateWorkflow/editNode. */
  model?: string;
  /**
   * SPEC-step30.md §2 — looks up the most recent run of a workflow (full
   * node detail included), so the system prompt can tell the LLM what
   * actually happened last time this workflow ran instead of leaving it
   * "blind" (the real 2026-07-13 "sao ảnh kết quả không liên quan" session
   * this fixes). Optional/additive: every pre-step30 caller/test that
   * doesn't pass this just gets no run-summary block at all — see
   * `buildChatSystemPrompt`'s own optional 4th param.
   */
  getLatestRun?: (workflowId: string) => { run: RunRecord; nodes: NodeRunRecord[] } | undefined;
  /** Threaded into EVERY `chatCompletion` call this turn makes. */
  signal?: AbortSignal;
  events?: ChatTurnEvents;
  /** Clock injection — accepted for parity with the repos (which already
   * take their own `now` at construction time) and for test convenience;
   * `runChatTurn` itself never needs to stamp a timestamp directly, every
   * write goes through a repo that already has its own clock. */
  now?: () => number;
  /** uuid injection for deterministic tests. */
  id?: () => string;
}

export interface ChatTurnResult {
  reply: string;
  workflow: Workflow;
  version: number;
  /** null when this turn didn't patch anything (pure Q&A, or the fail-safe
   * ending after a repeated version conflict). */
  changeId: number | null;
  userMessageId: string;
  assistantMessageId: string;
  /** SPEC-step32.md B4 — set only when this turn just applied a new
   * AI-suggested conversation title. */
  title?: string;
}

/**
 * SPEC-step32.md B1 — the LLM-facing note appended to a message's `content`
 * when (and only when) it carries attachments; `''` (appends nothing) when
 * there are none. Never persisted — `MessagesRepo` always stores `content`
 * verbatim, this note is synthesized fresh every time a prompt is built.
 */
function attachmentsNote(attachments: MessageAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return '';
  const paths = attachments.map((a) => a.path).join(', ');
  return `\n\n[Đính kèm ${attachments.length} ảnh đã upload sẵn: ${paths}. Khi cần đưa ảnh vào workflow, tạo node input.image với params.path = path tương ứng.]`;
}

function buildLlmMessages(
  systemPrompt: string,
  history: Message[],
  userContent: string,
  userAttachments: MessageAttachment[] | undefined,
): ChatMessage[] {
  const recentHistory = history.slice(-CHAT_HISTORY_LIMIT);
  const historyMessages: ChatMessage[] = recentHistory.map((m) => ({
    role: m.role,
    content: m.content + attachmentsNote(m.attachments),
  }));
  return [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userContent + attachmentsNote(userAttachments) },
  ];
}

/**
 * SPEC-step32.md B3 — when `ops` is a single op AND `workflow` is available
 * to resolve it against, a short " — <detail>" suffix naming the specific
 * node/edge involved (via `resolveNodeRef`, the same helper
 * `changeDigest.ts` uses). `undefined` when there's nothing worth adding:
 * `ops.length !== 1` (an aggregated count can't be attributed to one node),
 * or the single op is `remove-edge`/`move-node` (neither carries a `nodeId`
 * in its `PatchOp` shape — same exclusion `changeDigest.ts` documents).
 */
function describeSingleOp(op: PatchOp, workflow: Workflow): string | undefined {
  switch (op.op) {
    case 'add-node':
      return `thêm ${resolveNodeRef(workflow, op.node.id)}`;
    case 'remove-node':
      return `xoá ${resolveNodeRef(workflow, op.nodeId)}`;
    case 'update-node': {
      const keys = [...(op.label !== undefined ? ['label'] : []), ...(op.params ? Object.keys(op.params) : [])];
      return keys.length > 0 ? `sửa ${keys.join(', ')} của ${resolveNodeRef(workflow, op.nodeId)}` : undefined;
    }
    case 'add-edge':
      return `nối ${resolveNodeRef(workflow, op.edge.from.node)} → ${resolveNodeRef(workflow, op.edge.to.node)}`;
    case 'remove-edge':
    case 'move-node':
      return undefined;
  }
}

/**
 * Deterministic (no LLM call) 1-line summary for a `workflow_changes` row —
 * counts ops by kind, e.g. "AI: +2 node, ±1 node, +2 edge". Exported
 * (SPEC-step22.md §5) so `routes/changes.ts`'s manual/"tay" change endpoint
 * can reuse it verbatim as the fallback `summary` when the caller doesn't
 * supply one, instead of duplicating this counting logic.
 *
 * `workflow` (SPEC-step32.md B3, optional/additive — omitted keeps the
 * exact pre-step32 aggregate-only string) resolves a node/edge label detail
 * onto the summary, but only for a single-op turn (see `describeSingleOp`) —
 * a multi-op turn keeps the plain aggregate, since a count like "±2 node"
 * can't be attributed to one label without listing every node involved.
 */
export function summarizeOps(ops: PatchOp[], workflow?: Workflow): string {
  let added = 0;
  let removed = 0;
  let updated = 0;
  let edgesAdded = 0;
  let edgesRemoved = 0;
  let moved = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'add-node':
        added++;
        break;
      case 'remove-node':
        removed++;
        break;
      case 'update-node':
        updated++;
        break;
      case 'add-edge':
        edgesAdded++;
        break;
      case 'remove-edge':
        edgesRemoved++;
        break;
      case 'move-node':
        moved++;
        break;
    }
  }

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} node`);
  if (removed > 0) parts.push(`-${removed} node`);
  if (updated > 0) parts.push(`±${updated} node`);
  if (edgesAdded > 0) parts.push(`+${edgesAdded} edge`);
  if (edgesRemoved > 0) parts.push(`-${edgesRemoved} edge`);
  if (moved > 0) parts.push(`~${moved} vị trí`);

  const base = `AI: ${parts.join(', ')}`;

  if (workflow && ops.length === 1) {
    const detail = describeSingleOp(ops[0]!, workflow);
    if (detail) return `${base} — ${detail}`;
  }

  return base;
}

/** SPEC-step30.md §3 — hard cap on the whole run-summary block (header +
 * every node line combined), so it can't blow up the system prompt for a
 * workflow with many nodes. */
const RUN_SUMMARY_CAP_CHARS = 1500;
/** SPEC-step30.md §3 — an error message is truncated to this length
 * (independently of the overall block cap above) before being embedded. */
const RUN_SUMMARY_ERROR_TRUNCATE_CHARS = 200;

function truncateWithEllipsis(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** `run.createdAt` is an epoch-ms timestamp (same clock as every other
 * `*Repo`'s `now()`, e.g. `db/conversations.ts`) — rendered without
 * milliseconds ("ISO ngắn" per SPEC-step30.md §3). */
function toShortIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Deterministic (given `nowMs`) Vietnamese relative-time phrase — the whole
 * reason `buildRunSummary` takes `now` as an explicit ms timestamp instead of
 * calling `Date.now()` itself: same rationale as every other clock-injected
 * spot in this codebase (tests get a fixed, reproducible string). */
function formatRelativeTime(nowMs: number, thenMs: number): string {
  const deltaMs = Math.max(0, nowMs - thenMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs < minuteMs) return 'vừa xong';
  if (deltaMs < hourMs) return `${Math.floor(deltaMs / minuteMs)} phút trước`;
  if (deltaMs < dayMs) return `${Math.floor(deltaMs / hourMs)} giờ trước`;
  return `${Math.floor(deltaMs / dayMs)} ngày trước`;
}

/** A `MediaValue` (engine/types.ts) — duck-typed here rather than imported,
 * since `PortValue`/node outputs are typed `unknown` all the way down to
 * `NodeRunRecord.outputs` and this module has no other reason to depend on
 * `engine/types.ts`. */
function isMediaValue(value: unknown): value is { kind: string; path?: string; url?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    ['image', 'video', 'audio'].includes((value as { kind: string }).kind)
  );
}

/**
 * One output port's contribution to a node line: `<port>=<kind>:<file>` for
 * media outputs (basename only — SPEC-step30.md §3 explicitly says NOT to
 * embed the full path/URL/content), `<port>=<kind>` for everything else
 * (never the actual text/number/json content itself, same "no content"
 * rule).
 */
function describeOutputValue(portName: string, value: unknown): string {
  if (isMediaValue(value)) {
    const file = value.path ? path.basename(value.path) : value.url ? '(url)' : '(không có file)';
    return `${portName}=${value.kind}:${file}`;
  }
  if (typeof value === 'string') return `${portName}=text`;
  if (typeof value === 'number') return `${portName}=number`;
  if (typeof value === 'boolean') return `${portName}=boolean`;
  return `${portName}=json`;
}

function buildRunSummaryNodeLine(
  node: NodeRunRecord,
  nodeTypeById: Map<string, string>,
  nodeParamsById: Map<string, Record<string, unknown>>,
): string {
  const nodeType = nodeTypeById.get(node.nodeId) ?? '?';

  const tags = [node.state as string];
  if (node.cacheHit) tags.push('cache');
  const modelId = nodeParamsById.get(node.nodeId)?.modelId;
  if (typeof modelId === 'string' && modelId.length > 0) tags.push(`model ${modelId}`);

  let line = `- ${node.nodeId} (${nodeType}): ${tags.join(', ')}`;

  if (node.state === 'error' && node.error) {
    line += ` — lỗi: ${truncateWithEllipsis(node.error, RUN_SUMMARY_ERROR_TRUNCATE_CHARS)}`;
  } else if (node.state === 'success' && node.outputs && Object.keys(node.outputs).length > 0) {
    const outputParts = Object.entries(node.outputs).map(([port, value]) => describeOutputValue(port, value));
    line += ` — output: ${outputParts.join(', ')}`;
  }

  return line;
}

/**
 * SPEC-step30.md §3 — pure (no I/O, no clock read — `nowMs` is an explicit
 * param) so it's directly unit-testable and reused by every rebuild inside
 * `runChatTurn` below. Renders:
 *   Run <8-char id> — <status>, <relative time> (bắt đầu <short ISO>)
 *   - <nodeId> (<type>): <state>[, cache][, model <id>][ — lỗi: ...|— output: ...]
 *   ...
 * `run.workflowJson` (the exact snapshot the engine ran against — always
 * present on a `RunRecord`) is where node `type`/`params.modelId` come from;
 * a node id present in `nodes` but missing from that snapshot (shouldn't
 * happen, but JSON is JSON) just falls back to `'?'` for its type / no model
 * tag, rather than throwing.
 *
 * The whole block is capped to `RUN_SUMMARY_CAP_CHARS`: every `state:
 * 'error'` node line is ALWAYS kept (even if that alone blows the cap —
 * errors are exactly what the user is most likely asking about), while
 * non-error node lines are dropped (in original order, best-effort — a line
 * that doesn't fit is skipped rather than aborting the whole packing, so a
 * later shorter line still gets a chance) to make room. Error lines' total
 * length is reserved out of the budget UP FRONT (before any success line is
 * considered), regardless of where in `nodes` the error node sits — a
 * forward-only pass that only checked the cap on success lines and added
 * error lines unconditionally could let error lines that come AFTER a run
 * of success lines push the total past the cap.
 */
export function buildRunSummary(run: RunRecord, nodes: NodeRunRecord[], nowMs: number): string {
  const nodeTypeById = new Map<string, string>();
  const nodeParamsById = new Map<string, Record<string, unknown>>();
  try {
    const workflow = JSON.parse(run.workflowJson) as Workflow;
    for (const node of workflow.nodes ?? []) {
      nodeTypeById.set(node.id, node.type);
      nodeParamsById.set(node.id, (node.params ?? {}) as Record<string, unknown>);
    }
  } catch {
    // workflowJson malformed/unavailable — every node line below just falls
    // back to '?' for its type and no model tag, instead of throwing.
  }

  const header = `Run ${run.id.slice(0, 8)} — ${run.status}, ${formatRelativeTime(nowMs, run.createdAt)} (bắt đầu ${toShortIso(run.createdAt)})`;
  const nodeLines = nodes.map((node) => buildRunSummaryNodeLine(node, nodeTypeById, nodeParamsById));

  // Reserve the error lines' length FIRST (they're always kept in full, no
  // matter how big), then only fill whatever budget remains with success
  // lines — this way success lines packed before an error line in `nodes`
  // can never push the total past the cap once the (mandatory) error line
  // is added in.
  let reservedLen = header.length;
  nodes.forEach((node, i) => {
    if (node.state === 'error') reservedLen += 1 + nodeLines[i]!.length; // +1 for the joining '\n'
  });

  const keptIndices = new Set<number>();
  let currentLen = reservedLen;
  nodes.forEach((node, i) => {
    if (node.state === 'error') {
      keptIndices.add(i);
      return;
    }
    const additionalLen = 1 + nodeLines[i]!.length; // +1 for the joining '\n'
    if (currentLen + additionalLen <= RUN_SUMMARY_CAP_CHARS) {
      keptIndices.add(i);
      currentLen += additionalLen;
    }
  });

  // Output preserves the original `nodes` order (error lines are not hoisted
  // to the top) — only which success lines survive the cap changes.
  const kept = nodeLines.filter((_, i) => keptIndices.has(i));

  return [header, ...kept].join('\n');
}

export async function runChatTurn(
  conversationId: string,
  content: string,
  deps: ChatTurnDeps,
  /** SPEC-step32.md B1 — images the user attached to THIS turn's message
   * (already uploaded via `POST /api/upload`; this is just their `path`s +
   * display metadata). Trailing/optional so every pre-step32 call site
   * (tests included) keeps compiling and behaving identically without
   * passing it — same "additive extra param" pattern as `ChatTurnDeps`'s own
   * optional fields. */
  attachments?: MessageAttachment[],
): Promise<ChatTurnResult> {
  const genId = deps.id ?? randomUUID;
  const model = deps.model ?? getEnv('OPENROUTER_DEFAULT_MODEL');

  const conversation = deps.conversations.get(conversationId);
  if (!conversation) throw new ConversationNotFoundError(conversationId);

  const wfv0 = deps.workflows.getWithVersion(conversation.workflowId);
  if (!wfv0) {
    throw new Error(
      `Workflow "${conversation.workflowId}" của conversation "${conversationId}" không tồn tại (dữ liệu không nhất quán).`,
    );
  }

  // SPEC-step32.md B4 — computed once from the conversation read above and
  // reused for every `buildChatSystemPrompt` call this turn makes (including
  // the version-conflict rebuild): the AI is offered the "đặt tên" prompt
  // block exactly while a human hasn't already claimed the title via PATCH.
  const titleHint = conversation.titleSource !== 'user';

  // History BEFORE this turn — the new user message is appended separately
  // as the final "message user mới" (SPEC-step21.md §4.4), not folded in
  // here (it hasn't been written to the DB yet at this point anyway).
  const priorMessages = deps.messages.listByConversation(conversationId);

  const userMessageId = genId();
  deps.messages.create({ id: userMessageId, conversationId, role: 'user', content, status: 'done', attachments });
  const assistantMessageId = genId();
  deps.messages.create({ id: assistantMessageId, conversationId, role: 'assistant', content: '', status: 'pending' });
  deps.events?.onStart?.({ userMessageId, assistantMessageId });

  let wf0 = wfv0.workflow;
  let v0 = wfv0.version;
  let rebuilt = false;

  function computeDigestContext(): { maxSeenId: number | null; digest: string } {
    const unseen = deps.changes.listByWorkflow(conversation!.workflowId, {
      sinceId: conversation!.lastSeenChangeId ?? 0,
      includeCosmetic: false,
      limit: DIGEST_CHANGE_FETCH_LIMIT,
    });
    const maxSeenId = unseen.length > 0 ? Math.max(...unseen.map((c) => c.id)) : null;
    // SPEC-step32.md B3 — `wf0` (a `let`, closed over by reference) is
    // whatever this turn's "current workflow" is AT THE TIME this runs: the
    // read-at-turn-start snapshot on the first call, or the freshly-rebuilt
    // one when `handleVersionConflict` calls this again after reassigning
    // `wf0` — either way it already reflects every one of these `unseen`
    // changes having been applied, so it's the right snapshot to resolve
    // their `nodeId`s' labels against.
    return { maxSeenId, digest: buildChangeDigest(unseen, wf0) };
  }

  const now = deps.now ?? Date.now;

  /**
   * SPEC-step30.md §3 — `undefined` when there's no `getLatestRun` dep at
   * all (pre-step30 callers/tests, additive) OR that workflow has never
   * been run yet; either way `buildChatSystemPrompt`'s 4th param is likewise
   * `undefined` and the whole "Run gần nhất" block is omitted, byte-for-byte
   * identical to before this step.
   */
  function computeRunSummary(): string | undefined {
    const found = deps.getLatestRun?.(conversation!.workflowId);
    if (!found) return undefined;
    return buildRunSummary(found.run, found.nodes, now());
  }

  let { maxSeenId, digest } = computeDigestContext();

  deps.events?.onThinking?.('Đang phân tích yêu cầu…');

  let messages = buildLlmMessages(
    buildChatSystemPrompt(deps.registry, wf0, digest, computeRunSummary(), titleHint),
    priorMessages,
    content,
    attachments,
  );

  /**
   * Handles a detected version conflict (workflow.version at read-time !=
   * v0), whether found by the explicit pre-apply check (§4.5.b) or by
   * `saveVersioned` throwing `VersionConflictError` (§4.5.d, the rare race
   * between that check and the write itself). First occurrence in this turn
   * -> rebuild prompt/context from the latest workflow and retry (still
   * within MAX_ATTEMPTS); second occurrence -> end the turn with the
   * fail-safe reply. Returns 'continue' (caller does the actual `continue`,
   * since a `continue` statement can't cross a function boundary) or a
   * final `ChatTurnResult` (caller returns it as-is).
   */
  function handleVersionConflict(latestWorkflow: Workflow, latestVersion: number): 'continue' | ChatTurnResult {
    if (!rebuilt) {
      rebuilt = true;
      wf0 = latestWorkflow;
      v0 = latestVersion;
      ({ maxSeenId, digest } = computeDigestContext());
      messages = buildLlmMessages(
        buildChatSystemPrompt(deps.registry, wf0, digest, computeRunSummary(), titleHint),
        priorMessages,
        content,
        attachments,
      );
      // SPEC-step21.md §4.5.b: rebuilding re-runs "bước 3-4", and bước 4 ends
      // with onThinking — re-emit it so an SSE consumer sees a fresh
      // "đang phân tích" signal for the 2nd LLM call this rebuild triggers.
      deps.events?.onThinking?.('Đang phân tích yêu cầu…');
      return 'continue';
    }

    deps.messages.update(assistantMessageId, { content: FAIL_SAFE_REPLY, status: 'done' });
    deps.events?.onMessage?.({ reply: FAIL_SAFE_REPLY, workflow: latestWorkflow, version: latestVersion, changeId: null });
    return {
      reply: FAIL_SAFE_REPLY,
      workflow: latestWorkflow,
      version: latestVersion,
      changeId: null,
      userMessageId,
      assistantMessageId,
    };
  }

  let lastRaw = '';
  let lastIssues: ValidationIssue[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await chatCompletion({ model, messages, temperature: 0.2, signal: deps.signal });
    } catch (err) {
      if (deps.signal?.aborted) {
        deps.messages.update(assistantMessageId, { status: 'error', error: 'Đã dừng theo yêu cầu' });
        throw new ChatTurnAbortedError();
      }
      // Hard failure from chatCompletion (e.g. OpenRouter 401/500 after its
      // own internal retries) — not an abort, and NOT one of the retry-with-
      // feedback parse/validate paths below, so this throws straight out of
      // `runChatTurn`. Without this, `assistantMessageId` would stay stuck at
      // `status: 'pending'` in the DB forever (db/messages.ts's documented
      // pending -> streaming -> done|error lifecycle), unlike the abort
      // branch above and the MAX_ATTEMPTS branch at the end of this function.
      const message = err instanceof Error ? err.message : String(err);
      deps.messages.update(assistantMessageId, { status: 'error', error: message });
      throw err;
    }
    lastRaw = raw;

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      lastIssues = [PARSE_ISSUE];
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    const respParsed = ChatTurnResponseSchema.safeParse(parsed);
    if (!respParsed.success) {
      lastIssues = zodErrorToIssues(respParsed.error);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    const { reply, ops, title } = respParsed.data;
    // SPEC-step32.md B4 — the LLM is only ever ASKED for `title` while
    // `titleHint` is true (see `buildChatSystemPrompt` above), but a fixture
    // or an unusually eager model could still send one back with `titleHint`
    // false. More importantly: `titleHint` was captured from the
    // conversation read at TURN START, before the (possibly multi-second)
    // `chatCompletion` await above — if the user renamed the conversation
    // (PATCH .../rename, `title_source='user'`) while that call was in
    // flight, the stale `titleHint` would still read `true` and let the AI's
    // title silently clobber the user's. Re-read `titleSource` fresh right
    // here instead of trusting the closure: every step from here to the
    // `conversations.rename(..., 'ai')` calls below (DB reads/writes,
    // `applyPatch`, `validateWorkflow`) is synchronous, so this read stays
    // accurate for the rest of the attempt.
    const titleStillOpen = deps.conversations.get(conversationId)?.titleSource !== 'user';
    const appliedTitle = titleStillOpen && title ? title : undefined;

    if (ops.length === 0) {
      if (appliedTitle) {
        deps.conversations.rename(conversationId, appliedTitle, 'ai');
      }
      deps.messages.update(assistantMessageId, { content: reply, status: 'done' });
      if (maxSeenId !== null) {
        deps.conversations.setLastSeenChangeId(conversationId, maxSeenId);
      }
      deps.conversations.touch(conversationId);
      deps.events?.onMessage?.({ reply, workflow: wf0, version: v0, changeId: null, title: appliedTitle });
      return {
        reply,
        workflow: wf0,
        version: v0,
        changeId: null,
        userMessageId,
        assistantMessageId,
        title: appliedTitle,
      };
    }

    // Optimistic concurrency (SPEC-step21.md §4.5.a-b): re-read the
    // workflow's current version right before applying, in case a manual
    // edit landed while the LLM was thinking.
    const fresh = deps.workflows.getWithVersion(conversation.workflowId)!;
    if (fresh.version !== v0) {
      const outcome = handleVersionConflict(fresh.workflow, fresh.version);
      if (outcome === 'continue') continue;
      return outcome;
    }

    let patched: Workflow;
    try {
      patched = applyPatch(fresh.workflow, ops);
    } catch (err) {
      const message = err instanceof PatchError ? err.message : err instanceof Error ? err.message : String(err);
      lastIssues = [{ code: 'patch', message }];
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    const validated = validateWorkflow(patched, deps.registry);
    if (!validated.ok) {
      lastIssues = validated.issues;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    // SPEC-step32.md B4 — "workflow.name = title trước khi save": stamped
    // onto the patched workflow itself (so it lands in both `saveVersioned`
    // and this change's `snapshotAfter` below) BEFORE the save, taking the
    // workflow past its default "Workflow mới" name.
    if (appliedTitle) {
      validated.workflow.name = appliedTitle;
    }

    let newVersion: number;
    try {
      newVersion = deps.workflows.saveVersioned(validated.workflow, fresh.version);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        const latest = deps.workflows.getWithVersion(conversation.workflowId)!;
        const outcome = handleVersionConflict(latest.workflow, latest.version);
        if (outcome === 'continue') continue;
        return outcome;
      }
      throw err;
    }

    if (appliedTitle) {
      deps.conversations.rename(conversationId, appliedTitle, 'ai');
    }

    const change = deps.changes.create({
      workflowId: conversation.workflowId,
      conversationId,
      source: 'ai',
      scope: changeScope(ops),
      messageId: assistantMessageId,
      ops,
      // SPEC-step32.md B3 — `validated.workflow` is the POST-patch snapshot
      // (already includes any node this turn's ops just added), so a
      // single-op turn's `add-node`/`update-node`/`add-edge` detail resolves
      // correctly; a single `remove-node` still falls back to the bare id
      // (the node is gone from this snapshot by definition) same as
      // `changeDigest.ts`'s identical fallback.
      summary: summarizeOps(ops, validated.workflow),
      snapshotAfter: validated.workflow,
    });

    deps.messages.update(assistantMessageId, { content: reply, status: 'done', changeId: change.id });
    deps.conversations.setLastSeenChangeId(conversationId, change.id);
    deps.conversations.touch(conversationId);

    ops.forEach((op, i) => deps.events?.onPatchOp?.(op, i, ops.length));
    deps.events?.onMessage?.({
      reply,
      workflow: validated.workflow,
      version: newVersion,
      changeId: change.id,
      title: appliedTitle,
    });

    return {
      reply,
      workflow: validated.workflow,
      version: newVersion,
      changeId: change.id,
      userMessageId,
      assistantMessageId,
      title: appliedTitle,
    };
  }

  deps.messages.update(assistantMessageId, { status: 'error', error: JSON.stringify(lastIssues) });
  throw new AgentValidationError(lastIssues, lastRaw);
}
