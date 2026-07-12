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
import type { ZodError } from 'zod';
import { z } from 'zod';
import { getEnv } from '../config.js';
import type { ChangesRepo } from '../db/changes.js';
import type { ConversationsRepo } from '../db/conversations.js';
import type { Message } from '../db/messages.js';
import type { MessagesRepo } from '../db/messages.js';
import { VersionConflictError, type WorkflowsRepo } from '../db/workflows.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, type ValidationIssue, type Workflow } from '../engine/schema.js';
import { chatCompletion, type ChatMessage } from '../nodes/providers/openrouter.js';
import { buildChangeDigest } from './changeDigest.js';
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
  onThinking?: (note: string) => void;
  onPatchOp?: (op: PatchOp, index: number, total: number) => void;
  onMessage?: (p: { reply: string; workflow: Workflow; version: number; changeId: number | null }) => void;
}

export interface ChatTurnDeps {
  registry: NodeRegistry;
  workflows: WorkflowsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  changes: ChangesRepo;
  /** default: OPENROUTER_DEFAULT_MODEL, same as generateWorkflow/editNode. */
  model?: string;
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
}

function buildLlmMessages(systemPrompt: string, history: Message[], userContent: string): ChatMessage[] {
  const recentHistory = history.slice(-CHAT_HISTORY_LIMIT);
  const historyMessages: ChatMessage[] = recentHistory.map((m) => ({ role: m.role, content: m.content }));
  return [{ role: 'system', content: systemPrompt }, ...historyMessages, { role: 'user', content: userContent }];
}

/** Deterministic (no LLM call) 1-line summary for a `workflow_changes` row —
 * counts ops by kind, e.g. "AI: +2 node, ±1 node, +2 edge". */
function summarizeOps(ops: PatchOp[]): string {
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

  return `AI: ${parts.join(', ')}`;
}

export async function runChatTurn(
  conversationId: string,
  content: string,
  deps: ChatTurnDeps,
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

  // History BEFORE this turn — the new user message is appended separately
  // as the final "message user mới" (SPEC-step21.md §4.4), not folded in
  // here (it hasn't been written to the DB yet at this point anyway).
  const priorMessages = deps.messages.listByConversation(conversationId);

  const userMessageId = genId();
  deps.messages.create({ id: userMessageId, conversationId, role: 'user', content, status: 'done' });
  const assistantMessageId = genId();
  deps.messages.create({ id: assistantMessageId, conversationId, role: 'assistant', content: '', status: 'pending' });

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
    return { maxSeenId, digest: buildChangeDigest(unseen) };
  }

  let { maxSeenId, digest } = computeDigestContext();

  deps.events?.onThinking?.('Đang phân tích yêu cầu…');

  let messages = buildLlmMessages(buildChatSystemPrompt(deps.registry, wf0, digest), priorMessages, content);

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
      messages = buildLlmMessages(buildChatSystemPrompt(deps.registry, wf0, digest), priorMessages, content);
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

    const { reply, ops } = respParsed.data;

    if (ops.length === 0) {
      deps.messages.update(assistantMessageId, { content: reply, status: 'done' });
      if (maxSeenId !== null) {
        deps.conversations.setLastSeenChangeId(conversationId, maxSeenId);
      }
      deps.conversations.touch(conversationId);
      deps.events?.onMessage?.({ reply, workflow: wf0, version: v0, changeId: null });
      return { reply, workflow: wf0, version: v0, changeId: null, userMessageId, assistantMessageId };
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

    const change = deps.changes.create({
      workflowId: conversation.workflowId,
      conversationId,
      source: 'ai',
      scope: changeScope(ops),
      messageId: assistantMessageId,
      ops,
      summary: summarizeOps(ops),
      snapshotAfter: validated.workflow,
    });

    deps.messages.update(assistantMessageId, { content: reply, status: 'done', changeId: change.id });
    deps.conversations.setLastSeenChangeId(conversationId, change.id);
    deps.conversations.touch(conversationId);

    ops.forEach((op, i) => deps.events?.onPatchOp?.(op, i, ops.length));
    deps.events?.onMessage?.({ reply, workflow: validated.workflow, version: newVersion, changeId: change.id });

    return {
      reply,
      workflow: validated.workflow,
      version: newVersion,
      changeId: change.id,
      userMessageId,
      assistantMessageId,
    };
  }

  deps.messages.update(assistantMessageId, { status: 'error', error: JSON.stringify(lastIssues) });
  throw new AgentValidationError(lastIssues, lastRaw);
}
