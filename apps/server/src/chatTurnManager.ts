/**
 * ChatTurnManager (SPEC-step22.md §3): mirrors RunManager's shape (runs a
 * background job without awaiting it, fans out its events to per-turn
 * subscriber sets) but adds two things RunManager doesn't need: an
 * event-replay buffer per turn (so an SSE consumer connecting AFTER a turn
 * finished, or reconnecting mid-turn, still sees the full event sequence —
 * SPEC §3.2), and artificial pacing of `patch-op` events (SPEC §3.4, DESIGN
 * I §6's "streaming giả ở mức op") so the canvas can visibly "draw" one node
 * at a time even though `runChatTurn` computes the whole patch in one shot.
 *
 * `start()`'s synchronous return type is possible only because
 * `runChatTurn`'s new `onStart` event (chatTurn.ts) fires synchronously,
 * before the first `await` inside that async function — see the extended
 * comment on `ChatTurnEvents.onStart`. `start()` also re-checks conversation
 * existence itself (mirroring RunManager.start()'s own `validateWorkflow()`
 * call): a `ConversationNotFoundError` thrown by `runChatTurn` would only
 * ever surface as an (inherently async) Promise rejection, never as a
 * synchronous throw back to this method's caller.
 */
import type { ChangesRepo } from './db/changes.js';
import type { ConversationsRepo } from './db/conversations.js';
import type { MessagesRepo } from './db/messages.js';
import type { WorkflowsRepo } from './db/workflows.js';
import type { NodeRegistry } from './engine/registry.js';
import type { ValidationIssue, Workflow } from './engine/schema.js';
import type { NodeRunRecord, RunRecord } from './engine/stores.js';
import {
  ChatTurnAbortedError,
  ConversationNotFoundError,
  runChatTurn,
  type ChatTurnEvents,
} from './agent/chatTurn.js';
import { AgentValidationError } from './agent/generateWorkflow.js';
import type { PatchOp } from './agent/patch.js';

export type ChatTurnSseEvent =
  | { event: 'thinking'; data: { note: string } }
  | { event: 'patch-op'; data: { op: PatchOp; index: number; total: number } }
  | { event: 'message'; data: { content: string; workflow: Workflow; version: number; changeId: number | null } }
  | { event: 'error'; data: { message: string; issues?: ValidationIssue[] } }
  | { event: 'done'; data: Record<string, never> };

export type ChatTurnSseListener = (event: ChatTurnSseEvent) => void;

/** Thrown by `start()` when the conversation already has a turn running —
 * routes/conversations.ts maps this to 409 `{ error: 'turn-in-progress' }`. */
export class TurnInProgressError extends Error {
  constructor(conversationId: string) {
    super(`Conversation "${conversationId}" đã có 1 turn đang chạy.`);
    this.name = 'TurnInProgressError';
  }
}

export interface ChatTurnManagerDeps {
  registry: NodeRegistry;
  workflows: WorkflowsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  changes: ChangesRepo;
  /** default: OPENROUTER_DEFAULT_MODEL, same as runChatTurn's own default. */
  model?: string;
  /** SPEC-step30.md §2 — passed straight through to `runChatTurn`'s own dep
   * of the same name; optional/additive, `undefined` (every pre-step30
   * caller) means no run-summary block at all. */
  getLatestRun?: (workflowId: string) => { run: RunRecord; nodes: NodeRunRecord[] } | undefined;
  /** Injectable for tests — production default below; tests pass `() => 0`
   * to make pacing instantaneous. */
  paceMs?: (total: number) => number;
}

interface QueuedPatchOp {
  op: PatchOp;
  index: number;
  total: number;
}

interface TurnState {
  buffer: ChatTurnSseEvent[];
  listeners: Set<ChatTurnSseListener>;
  opQueue: QueuedPatchOp[];
  draining: boolean;
  /** Set once the terminal outcome (success or failure) is known; run once
   * `opQueue` has fully drained — emits `message`/`error` then `done`. */
  finalize?: () => void;
  controller: AbortController;
}

/** DESIGN-ai-native.md I §6: `min(180ms, 1500ms/total)`, capping the whole
 * patch-op animation sequence at ~1.5s regardless of how many ops there are. */
const DEFAULT_PACE_MS = (total: number): number => Math.min(180, 1500 / total);

/** SPEC-step22.md §3.5 — cap on how many turns' buffers this process keeps
 * around for replay/reconnect (simple FIFO, no TTL — local single-user). */
const MAX_TRACKED_TURNS = 200;

function mapTurnError(err: unknown): { message: string; issues?: ValidationIssue[] } {
  if (err instanceof AgentValidationError) {
    return { message: err.message, issues: err.issues };
  }
  if (err instanceof ChatTurnAbortedError) {
    return { message: 'Đã dừng theo yêu cầu' };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export class ChatTurnManager {
  private readonly turns = new Map<string, TurnState>();
  /** Insertion order of every assistantMessageId ever registered — oldest
   * first, for the FIFO eviction in `evictIfNeeded()`. */
  private readonly turnOrder: string[] = [];
  private readonly activeByConversation = new Map<string, string>();
  private readonly activeAssistantIds = new Set<string>();

  constructor(private readonly deps: ChatTurnManagerDeps) {}

  start(conversationId: string, content: string): { userMessageId: string; assistantMessageId: string } {
    if (this.activeByConversation.has(conversationId)) {
      throw new TurnInProgressError(conversationId);
    }
    // Mirrors RunManager.start()'s own validateWorkflow() call: this is the
    // one synchronous-throw path SPEC §3.1 calls out by name
    // (ConversationNotFoundError) — checking it here ourselves guarantees
    // `runChatTurn`'s `onStart` really will fire before its call expression
    // returns below, so `capturedIds` below is never left unset in practice.
    if (!this.deps.conversations.get(conversationId)) {
      throw new ConversationNotFoundError(conversationId);
    }

    const controller = new AbortController();
    let capturedIds: { userMessageId: string; assistantMessageId: string } | undefined;
    let state: TurnState | undefined;

    const events: ChatTurnEvents = {
      onStart: (ids) => {
        capturedIds = ids;
        state = { buffer: [], listeners: new Set(), opQueue: [], draining: false, controller };
        this.turns.set(ids.assistantMessageId, state);
        this.turnOrder.push(ids.assistantMessageId);
        this.activeAssistantIds.add(ids.assistantMessageId);
        this.activeByConversation.set(conversationId, ids.assistantMessageId);
        this.evictIfNeeded();
      },
      onThinking: (note) => {
        this.emit(state!, { event: 'thinking', data: { note } });
      },
      onPatchOp: (op, index, total) => {
        state!.opQueue.push({ op, index, total });
        this.kick(state!);
      },
      onMessage: (p) => {
        state!.finalize = () => {
          this.emit(state!, {
            event: 'message',
            data: { content: p.reply, workflow: p.workflow, version: p.version, changeId: p.changeId },
          });
          this.emit(state!, { event: 'done', data: {} });
          this.finishTurn(conversationId, capturedIds!.assistantMessageId);
        };
        this.kick(state!);
      },
    };

    // Not awaited by design (mirrors RunManager.start()'s engine.run() call)
    // — the turn runs in the background, fanning out through `events`
    // above; this .catch() is the last-resort net for the reject path
    // (abort / AgentValidationError / any other hard failure), converting
    // it into an `error` + `done` SSE pair instead of an unhandled rejection.
    runChatTurn(conversationId, content, {
      registry: this.deps.registry,
      workflows: this.deps.workflows,
      conversations: this.deps.conversations,
      messages: this.deps.messages,
      changes: this.deps.changes,
      model: this.deps.model,
      getLatestRun: this.deps.getLatestRun,
      signal: controller.signal,
      events,
    }).catch((err: unknown) => {
      if (!state) {
        // onStart never fired at all — shouldn't happen given the
        // conversation-existence check above, but there is no turn/buffer
        // to notify anyone through, so just log instead of crashing the
        // process with an unhandled rejection.
        // eslint-disable-next-line no-console
        console.error(`[ChatTurnManager] turn for conversation "${conversationId}" failed before onStart:`, err);
        return;
      }
      const { message, issues } = mapTurnError(err);
      state.finalize = () => {
        this.emit(state!, { event: 'error', data: issues ? { message, issues } : { message } });
        this.emit(state!, { event: 'done', data: {} });
        this.finishTurn(conversationId, capturedIds!.assistantMessageId);
      };
      this.kick(state);
    });

    if (!capturedIds) {
      // Extremely defensive: the conversation-existence check above should
      // make this unreachable in practice (every other synchronous throw
      // inside runChatTurn's prefix happens strictly after that same check
      // succeeds there too), but a Promise's rejection reason genuinely
      // cannot be read synchronously, so there is no way to recover the
      // original error here if this ever does trip.
      throw new Error(`Không khởi tạo được chat turn cho conversation "${conversationId}".`);
    }
    return capturedIds;
  }

  /** Replays the full event buffer synchronously into `listener`, then
   * (if the turn hasn't already finished) keeps streaming live events to it
   * until unsubscribed. Returns `undefined` if this manager has no record of
   * `assistantMessageId` (never started here, or evicted by the LRU cap /
   * a process restart) — callers fall back to reading `messages` from the DB. */
  subscribe(assistantMessageId: string, listener: ChatTurnSseListener): (() => void) | undefined {
    const state = this.turns.get(assistantMessageId);
    if (!state) return undefined;

    for (const event of state.buffer) listener(event);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  stop(assistantMessageId: string): boolean {
    if (!this.activeAssistantIds.has(assistantMessageId)) return false;
    const state = this.turns.get(assistantMessageId);
    if (!state) return false;
    state.controller.abort();
    return true;
  }

  isActive(assistantMessageId: string): boolean {
    return this.activeAssistantIds.has(assistantMessageId);
  }

  private emit(state: TurnState, event: ChatTurnSseEvent): void {
    state.buffer.push(event);
    for (const listener of state.listeners) listener(event);
  }

  /** Starts the drain loop if it isn't already running; a no-op if it is —
   * `drain()` itself keeps re-scheduling until both `opQueue` is empty AND
   * `finalize` has been consumed. */
  private kick(state: TurnState): void {
    if (state.draining) return;
    state.draining = true;
    this.drain(state);
  }

  private drain(state: TurnState): void {
    const item = state.opQueue.shift();
    if (item) {
      this.emit(state, { event: 'patch-op', data: { op: item.op, index: item.index, total: item.total } });
      const delay = (this.deps.paceMs ?? DEFAULT_PACE_MS)(item.total);
      setTimeout(() => this.drain(state), delay);
      return;
    }

    state.draining = false;
    if (state.finalize) {
      const finalize = state.finalize;
      state.finalize = undefined;
      finalize();
    }
  }

  private finishTurn(conversationId: string, assistantMessageId: string): void {
    this.activeAssistantIds.delete(assistantMessageId);
    if (this.activeByConversation.get(conversationId) === assistantMessageId) {
      this.activeByConversation.delete(conversationId);
    }
  }

  /** FIFO eviction once more than MAX_TRACKED_TURNS have ever been
   * registered — never evicts a turn that's still actively running (its
   * `finishTurn()` hasn't run yet), so an in-flight turn is always safe even
   * if it happens to be the oldest tracked one. */
  private evictIfNeeded(): void {
    while (this.turnOrder.length > MAX_TRACKED_TURNS) {
      const oldest = this.turnOrder[0]!;
      if (this.activeAssistantIds.has(oldest)) break;
      this.turnOrder.shift();
      this.turns.delete(oldest);
    }
  }
}
