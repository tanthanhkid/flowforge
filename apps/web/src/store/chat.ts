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
}));
