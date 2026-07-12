/**
 * Zustand store for chat/conversations (SPEC-step23.md §4) — the
 * ConversationRail + ChatPane pane's single source of truth. A conversation
 * is 1-1 with a workflow (DESIGN-ai-native.md §II.4): selecting one always
 * adopts its workflow into `useFlowStore` too, so the canvas pane and this
 * pane never disagree about which workflow is "current".
 *
 * `onPatchOp` is deliberately a no-op here (see `sendMessage` below) —
 * SPEC-step25.md is what animates the canvas per-op as a turn streams in;
 * this step only needs the turn to resolve into a final workflow.
 */
import { create } from 'zustand';
import * as api from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { ChatMessage, ConversationSummary } from '../api/types.ts';
import { useFlowStore } from './flow.ts';

export type LayoutMode = 'chat' | 'split' | 'canvas';

/** SPEC-step24.md §4 — below this many px, the chat pane isn't usefully readable alongside a visible canvas pane. */
export const CHAT_MIN_WIDTH = 320;
/** SPEC-step24.md §4 — ditto for the canvas pane (FlowCanvas + its own NodePalette/right-panel). */
export const CANVAS_MIN_WIDTH = 420;
/** SPEC-step24.md §2 — CSS transition duration for an *animated* `setSplitRatio` call (Mode Toggle clicks, double-click-to-reset, the auto-behaviors below); a plain divider drag never animates. */
export const SPLIT_ANIMATE_MS = 300;

const SPLIT_RATIO_STORAGE_KEY = 'ff.splitRatio';
const SPLIT_RATIO_PERSIST_THROTTLE_MS = 200;

/**
 * Derives the 3-way layout mode from the continuous `splitRatio` (SPEC-
 * step24.md §2): `>=0.99` reads as fully chat (canvas pane squashed to ~0px
 * — the 0.01 slack absorbs float rounding from the flex-grow math, not a
 * deliberate "almost closed" state), `<=0.01` fully canvas, anything else is
 * a genuine split. Exported as a plain function (not store-only state) so
 * both store internals and components (`ModeToggle`, `ChatPane`,
 * `CanvasPane`, `App`'s keyboard shortcut) can derive it from whatever
 * `splitRatio` they've already selected, without an extra store subscription.
 */
export function layoutModeFromRatio(ratio: number): LayoutMode {
  if (ratio >= 0.99) return 'chat';
  if (ratio <= 0.01) return 'canvas';
  return 'split';
}

const MODE_ORDER: LayoutMode[] = ['chat', 'split', 'canvas'];
const MODE_RATIO: Record<LayoutMode, number> = { chat: 1, split: 0.5, canvas: 0 };

/**
 * Pure cycle helper backing the ⌘\ / ⌘⇧\ shortcuts (SPEC-step24.md §2) —
 * `dir: 1` cycles chat → split → canvas → chat, `-1` reverses it. Kept as a
 * standalone pure function (rather than inlined into the keydown handler)
 * so it's directly unit-testable without touching the store or the DOM.
 */
export function nextMode(current: LayoutMode, dir: 1 | -1): LayoutMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + dir + MODE_ORDER.length) % MODE_ORDER.length]!;
}

/** Canonical `splitRatio` for a given mode — what ModeToggle's 3 buttons and the ⌘\ shortcut set. */
export function modeRatio(mode: LayoutMode): number {
  return MODE_RATIO[mode];
}

/**
 * Clamp `ratio` to [0,1], then snap fully open/closed if the resulting pixel
 * width of either pane would fall under its min-width (SPEC-step24.md §2/
 * §4) — dragging the divider past a pane's usable minimum closes that pane
 * entirely rather than leaving it uselessly thin. `containerWidth` is the
 * pixel width of the chat+divider+canvas span specifically (NOT the whole
 * app — `ConversationRail` sits outside it, at a fixed width unrelated to
 * `splitRatio`); callers that don't know it (Mode Toggle's canonical
 * 1/0.5/0 sets, or any call before a container has actually been measured)
 * pass `0`, which skips the snap and only clamps — those canonical ratios
 * never violate either min-width for any reasonable viewport anyway.
 */
export function resolveSplitRatio(ratio: number, containerWidth = 0): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  // Already fully closed on one side (chat-only or canvas-only) — nothing
  // to snap. Without this early return, a container narrower than a pane's
  // min-width would flip an *already* fully-open ratio to the opposite
  // extreme just because the whole window is small, which is backwards:
  // "fully open" always means 100% of whatever space exists, never a
  // trigger to close that same pane.
  if (clamped <= 0 || clamped >= 1) return clamped;
  if (containerWidth <= 0) return clamped;
  const chatPx = clamped * containerWidth;
  const canvasPx = containerWidth - chatPx;
  if (chatPx < CHAT_MIN_WIDTH) return 0;
  if (canvasPx < CANVAS_MIN_WIDTH) return 1;
  return clamped;
}

/** Init value when `ff.splitRatio` was never saved (or fails to parse): 1.0 = chat-first landing (SPEC-step24.md §2). */
function readPersistedSplitRatio(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (raw === null) return 1;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
  } catch {
    // Some environments (privacy mode, disabled storage) throw on access.
    return 1;
  }
}

// Module-level (not store state) — a throttle handle, not UI-observable data.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSplitRatio(ratio: number): void {
  if (typeof window === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));
    } catch {
      // Ignore quota/private-mode errors — persistence is a nicety, not load-bearing.
    }
  }, SPLIT_RATIO_PERSIST_THROTTLE_MS);
}

// Module-level (not store state) — clears `splitAnimating` back to false
// 300ms after an animated `setSplitRatio` call; re-armed (not stacked) if
// another animated call lands before the previous timer fires.
let animateClearTimer: ReturnType<typeof setTimeout> | null = null;

export interface ChatState {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeTitle: string;
  messages: ChatMessage[];
  /** SPEC-step22.md §6 — the workflow's optimistic-concurrency version, as of the last conversation load / turn result. */
  workflowVersion: number;
  turnState: 'idle' | 'streaming';
  activeTurnMessageId: string | null;
  chatError: string | null;
  /**
   * Bumped (never just implied by `chatError` changing) every time a *new*
   * error occurs. ChatPane's "show a fresh error banner" effect depends on
   * this instead of on `chatError` itself: React's `useSyncExternalStore`
   * (which Zustand v5 uses directly, no custom equality fn) bails out of
   * re-rendering when a primitive selector's value compares equal via
   * `Object.is` — so setting `chatError` to the *same string twice in a row*
   * (e.g. two 409s back to back) would never re-trigger the effect that
   * un-hides the banner. Same "plain counter, not a boolean, so repeats
   * still trigger" pattern as `store/flow.ts`'s `fitViewNonce`.
   */
  chatErrorNonce: number;
  railCollapsed: boolean;
  search: string;

  /** SPEC-step24.md §2 — 0..1 share of the chat+divider+canvas span's width given to ChatPane; 0 = canvas-only, 1 = chat-only. Persisted (`ff.splitRatio`), init 1.0 (chat-first) when never saved. */
  splitRatio: number;
  /**
   * SPEC-step24.md §2 — true for 300ms after an *animated* `setSplitRatio`
   * call. `ChatPane`/`CanvasPane`/`SplitDivider` read this to switch on a
   * CSS transition for that one resize only — a plain divider drag must
   * track the pointer with zero transition lag.
   */
  splitAnimating: boolean;
  /**
   * SPEC-step24.md §5 — bumped by `requestFocusComposer()` (the empty-
   * canvas onboarding CTA, after switching to split mode). `ChatPane`'s
   * effect focuses its composer textarea whenever this changes — a plain
   * counter (not a boolean) so two requests in a row without an
   * intervening render both still trigger the effect, same pattern as
   * `store/flow.ts`'s `fitViewNonce`/`chatErrorNonce` above.
   */
  focusComposerNonce: number;

  loadConversations(search?: string): Promise<void>;
  selectConversation(id: string): Promise<void>;
  newConversation(): Promise<void>;
  renameActive(title: string): Promise<void>;
  removeConversation(id: string): Promise<void>;
  /** Resolves `true` iff the message was actually sent (accepted by the
   * server); `false` if guarded out client-side or rejected with 409 — lets
   * callers (ChatPane) only clear the composer on an actual send. */
  sendMessage(content: string): Promise<boolean>;
  stopActiveTurn(): Promise<void>;
  toggleRail(): void;
  setSearch(query: string): void;
  /** See `splitRatio` above. `opts.containerWidth` feeds the min-width snap (`resolveSplitRatio`); `opts.animate` feeds `splitAnimating`. */
  setSplitRatio(ratio: number, opts?: { animate?: boolean; containerWidth?: number }): void;
  /** Derives the 3-way mode from the current `splitRatio` — see `layoutModeFromRatio`. */
  layoutMode(): LayoutMode;
  /** See `focusComposerNonce` above. */
  requestFocusComposer(): void;
}

// Kept outside the store's own state, same pattern as store/flow.ts's
// `activeRunUnsubscribe` — an implementation-only handle for cleaning up the
// previous turn's SSE subscription, not UI-observable data.
let activeTurnUnsubscribe: (() => void) | undefined;

function stopActiveTurnSubscription(): void {
  activeTurnUnsubscribe?.();
  activeTurnUnsubscribe = undefined;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  activeTitle: '',
  messages: [],
  workflowVersion: 0,
  turnState: 'idle',
  activeTurnMessageId: null,
  chatError: null,
  chatErrorNonce: 0,
  railCollapsed: false,
  search: '',
  splitRatio: readPersistedSplitRatio(),
  splitAnimating: false,
  focusComposerNonce: 0,

  async loadConversations(search) {
    const conversations = await api.listConversations(search);
    set({ conversations });
  },

  async selectConversation(id) {
    const res = await api.getConversation(id);
    stopActiveTurnSubscription();
    set({
      activeConversationId: id,
      activeTitle: res.conversation.title,
      messages: res.messages,
      workflowVersion: res.version,
      turnState: 'idle',
      activeTurnMessageId: null,
      chatError: null,
    });
    useFlowStore.getState().adoptWorkflow(res.workflow);
    // SPEC-step24.md §2 auto-behavior: opening a non-empty workflow while
    // the layout is chat-only auto-splits to 50/50 so the user actually
    // sees the canvas they just switched to, without needing a manual
    // Mode Toggle click. Only fires from chat mode — split/canvas are left
    // exactly as the user set them (this is a convenience nudge, not a
    // forced reset every time a conversation is opened).
    if (res.workflow.nodes.length > 0 && get().layoutMode() === 'chat') {
      get().setSplitRatio(0.5, { animate: true });
    }
  },

  async newConversation() {
    const conversation = await api.createConversation();
    set((state) => ({
      conversations: [
        {
          id: conversation.id,
          workflowId: conversation.workflowId,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          nodeCount: 0,
        },
        ...state.conversations,
      ],
    }));
    await get().selectConversation(conversation.id);
  },

  async renameActive(title) {
    const id = get().activeConversationId;
    if (!id) return;
    const updated = await api.renameConversation(id, title);
    set((state) => ({
      activeTitle: updated.title,
      conversations: state.conversations.map((c) => (c.id === id ? { ...c, title: updated.title } : c)),
    }));
  },

  async removeConversation(id) {
    await api.deleteConversation(id);
    set((state) => ({ conversations: state.conversations.filter((c) => c.id !== id) }));
    if (get().activeConversationId === id) {
      stopActiveTurnSubscription();
      set({
        activeConversationId: null,
        activeTitle: '',
        messages: [],
        workflowVersion: 0,
        turnState: 'idle',
        activeTurnMessageId: null,
        chatError: null,
      });
      useFlowStore.getState().newWorkflow();
    }
  },

  async sendMessage(content) {
    const trimmed = content.trim();
    const conversationId = get().activeConversationId;
    if (get().turnState !== 'idle' || !conversationId || trimmed.length < 1) return false;

    let ids: { userMessageId: string; assistantMessageId: string };
    try {
      ids = await api.postChatMessage(conversationId, trimmed);
    } catch (err) {
      // SPEC-step23.md §4.4 — a 409 means the previous turn is still running
      // (the caller lost a race, or clicked before the UI disabled itself);
      // surface it as a plain error banner, don't append a phantom message.
      if (err instanceof ApiError && err.status === 409) {
        // Only surface the banner if the user is still looking at this
        // conversation — a stale 409 for one they've since navigated away
        // from would otherwise pop an unrelated error over whatever
        // conversation is on screen now.
        if (get().activeConversationId === conversationId) {
          set((state) => ({
            chatError: 'AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.',
            chatErrorNonce: state.chatErrorNonce + 1,
          }));
        }
        return false;
      }
      throw err;
    }

    // The user can switch to a different conversation (ConversationRail, or
    // "+ mới") while the `postChatMessage` round-trip above is in flight —
    // re-check we're still displaying the conversation this send was for
    // before touching any state. Without this, a slow response lands after
    // `selectConversation` has already swapped `messages`/canvas over to
    // the newly-active conversation, and the two lines below would append
    // this (now-stale) turn's messages onto the *new* conversation's list.
    // The message itself was still accepted and the turn keeps running
    // server-side — the user will see it if/when they navigate back.
    if (get().activeConversationId !== conversationId) return true;

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: ids.userMessageId,
      conversationId,
      role: 'user',
      content: trimmed,
      status: 'done',
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: ids.assistantMessageId,
      conversationId,
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: now,
    };
    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      turnState: 'streaming',
      activeTurnMessageId: ids.assistantMessageId,
      chatError: null,
    }));

    stopActiveTurnSubscription();
    const assistantMessageId = ids.assistantMessageId;
    // Gate every state-mutating handler on "is this still the conversation
    // being displayed" — same pattern (and same reason) as store/flow.ts's
    // `run()` `isDisplayed` guard: the user can switch conversations while
    // this turn's SSE stream is still open, and a stale turn's events must
    // not mutate a *different* conversation's messages/canvas/turnState.
    const isDisplayed = () => get().activeConversationId === conversationId;
    const unsubscribe = api.openTurnEvents(conversationId, assistantMessageId, {
      onThinking: () => {
        if (!isDisplayed()) return;
        set((state) => ({
          messages: state.messages.map((m) => (m.id === assistantMessageId ? { ...m, status: 'streaming' } : m)),
        }));
      },
      // SPEC-step25.md territory (per-op canvas animation) — this step just
      // needs the turn to resolve, so patch-op events are ignored here.
      onPatchOp: () => {},
      onMessage: (data) => {
        if (!isDisplayed()) return;
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessageId
              ? { ...m, content: data.content, status: 'done', changeId: data.changeId ?? undefined }
              : m,
          ),
          workflowVersion: data.version,
        }));
        // Mirrors Toolbar's ✨ Describe flow (SPEC-step16.md §3): the AI's
        // own node positions are only a coarse pre-validation nudge, so
        // re-layout + re-center immediately rather than leaving nodes
        // overlapping.
        useFlowStore.getState().adoptWorkflow(data.workflow);
        useFlowStore.getState().autoLayout();
        useFlowStore.getState().requestFitView();
        // SPEC-step24.md §2 auto-behavior (interim heuristic — SPEC-step25.md
        // moves this trigger to the turn's *first* patch-op instead of
        // waiting for the final message): the AI actually changed the
        // workflow (a non-null changeId) while the layout was chat-only ->
        // auto-split to 40/60 so the result is visible without a manual
        // Mode Toggle click.
        if (data.changeId !== null && get().layoutMode() === 'chat') {
          get().setSplitRatio(0.4, { animate: true });
        }
      },
      onError: (data) => {
        if (!isDisplayed()) return;
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantMessageId ? { ...m, status: 'error', error: data.message } : m,
          ),
          chatError: data.message,
          chatErrorNonce: state.chatErrorNonce + 1,
        }));
      },
      onDone: () => {
        // The server always closes the SSE response right after `done` —
        // per the EventSource spec a server-closed connection auto-
        // reconnects, so this stream MUST be closed here (mirrors
        // store/flow.ts's `run()` onDone). Unconditional: this cleanup has
        // to happen regardless of which conversation is on screen, or the
        // subscription handle leaks / auto-reconnects forever.
        unsubscribe();
        if (activeTurnUnsubscribe === unsubscribe) {
          activeTurnUnsubscribe = undefined;
        }
        // Only this conversation's own turnState may be cleared here — if
        // the user has since switched to another conversation that has
        // since started its OWN turn, blindly resetting turnState/
        // activeTurnMessageId would wrongly make that genuinely-in-progress
        // turn look idle (Send button reappears, ■ Dừng disappears) while
        // it's still actually streaming server-side.
        if (isDisplayed()) {
          set({ turnState: 'idle', activeTurnMessageId: null });
        }
        // The server may have just auto-titled this conversation from its
        // first message (routes/conversations.ts §4.6) — refresh the list
        // and mirror the (possibly new) title into `activeTitle`. Safe to
        // do unconditionally: `activeId` below is re-read fresh, so this
        // only ever touches whichever conversation is *actually* active by
        // the time it resolves.
        void (async () => {
          await get().loadConversations(get().search || undefined);
          const activeId = get().activeConversationId;
          const updated = activeId ? get().conversations.find((c) => c.id === activeId) : undefined;
          if (updated) set({ activeTitle: updated.title });
        })();
      },
    });
    activeTurnUnsubscribe = unsubscribe;
    return true;
  },

  async stopActiveTurn() {
    const conversationId = get().activeConversationId;
    const messageId = get().activeTurnMessageId;
    if (!conversationId || !messageId) return;
    await api.stopTurn(conversationId, messageId);
  },

  toggleRail() {
    set((state) => ({ railCollapsed: !state.railCollapsed }));
  },

  setSearch(query) {
    set({ search: query });
  },

  setSplitRatio(ratio, opts) {
    const resolved = resolveSplitRatio(ratio, opts?.containerWidth ?? 0);
    if (opts?.animate) {
      if (animateClearTimer) clearTimeout(animateClearTimer);
      set({ splitRatio: resolved, splitAnimating: true });
      animateClearTimer = setTimeout(() => {
        animateClearTimer = null;
        set({ splitAnimating: false });
      }, SPLIT_ANIMATE_MS);
    } else {
      // A non-animated call (a live divider drag, one `setSplitRatio` per
      // pointermove) must win over any *previous* animated call still in
      // flight — e.g. double-click-to-reset or a ModeToggle click followed,
      // within SPLIT_ANIMATE_MS, by the user grabbing the divider. Without
      // clearing `splitAnimating`/`animateClearTimer` here, `splitAnimating`
      // would stay `true` until the stale timer fires on its own schedule,
      // and ChatPane/CanvasPane would keep applying their 300ms CSS
      // transition to a drag that must track the pointer with zero lag.
      if (animateClearTimer) {
        clearTimeout(animateClearTimer);
        animateClearTimer = null;
      }
      set({ splitRatio: resolved, splitAnimating: false });
    }
    persistSplitRatio(resolved);
  },

  layoutMode() {
    return layoutModeFromRatio(get().splitRatio);
  },

  requestFocusComposer() {
    set((state) => ({ focusComposerNonce: state.focusComposerNonce + 1 }));
  },
}));
