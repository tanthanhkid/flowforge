/**
 * store/chat.ts (SPEC-step23.md §4 / §8.2, patch-op animation SPEC-step26.md
 * §2/§4): selectConversation adopting the workflow into store/flow.ts,
 * sendMessage's SSE-driven happy path (including per-op optimistic apply +
 * highlight bookkeeping + reconcile-always-wins), the 409 turn-in-progress
 * guard, stop, and removeConversation's active-conversation cleanup. Mocks
 * `api/client.ts` the same way test/store.test.ts does for store/flow.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEventHandlers } from '../src/api/client.ts';
import type { ChatMessage, Conversation, ConversationSummary, Workflow } from '../src/api/types.ts';
import {
  CANVAS_MIN_WIDTH,
  CHAT_MIN_WIDTH,
  layoutModeFromRatio,
  modeRatio,
  nextMode,
  resolveSplitRatio,
} from '../src/store/chat.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    postChatMessage: vi.fn(),
    stopTurn: vi.fn(),
    openTurnEvents: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';

function resetStores(): void {
  useChatStore.setState({
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
    opHighlights: {},
    splitRatio: 1,
    splitAnimating: false,
    focusComposerNonce: 0,
  });
  useFlowStore.setState({
    workflow: { version: 1, id: 'wf-initial', name: 'Initial', nodes: [], edges: [] },
    selectedNodeId: null,
    dirty: true,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    validationIssues: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
});

const sampleWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Conv workflow', nodes: [], edges: [] };

const sampleConversation: Conversation = {
  id: 'c1',
  workflowId: 'wf1',
  title: 'Conv 1',
  createdAt: 1,
  updatedAt: 2,
  lastSeenChangeId: null,
};

const sampleSummary: ConversationSummary = { ...sampleConversation, nodeCount: 0 };

describe('selectConversation', () => {
  it('loads the conversation, adopts its workflow into the flow store (dirty=false), and resets chat error/turn state', async () => {
    const messages: ChatMessage[] = [
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'done', createdAt: 1 },
    ];
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages,
      workflow: sampleWorkflow,
      version: 3,
    });

    await useChatStore.getState().selectConversation('c1');

    expect(api.getConversation).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
    expect(useChatStore.getState().activeTitle).toBe('Conv 1');
    expect(useChatStore.getState().messages).toEqual(messages);
    expect(useChatStore.getState().workflowVersion).toBe(3);

    // adoptWorkflow's reset semantics (SPEC-step23.md §3) took effect.
    expect(useFlowStore.getState().workflow).toEqual(sampleWorkflow);
    expect(useFlowStore.getState().dirty).toBe(false);
  });
});

describe('newConversation', () => {
  it('creates a conversation, prepends it to the list, and selects it', async () => {
    vi.mocked(api.createConversation).mockResolvedValue(sampleConversation);
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: sampleWorkflow,
      version: 0,
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).toHaveBeenCalled();
    expect(useChatStore.getState().conversations[0]?.id).toBe('c1');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });
});

describe('sendMessage', () => {
  it('happy path: placeholder assistant message goes pending -> done, workflow adopted, version set, turnState back to idle after done', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });

    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([sampleSummary]);

    await useChatStore.getState().sendMessage('  xin chào  ');

    expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'xin chào');
    const afterStart = useChatStore.getState();
    expect(afterStart.turnState).toBe('streaming');
    expect(afterStart.activeTurnMessageId).toBe('a1');
    expect(afterStart.messages).toHaveLength(2);
    expect(afterStart.messages[0]).toMatchObject({ id: 'u1', role: 'user', content: 'xin chào', status: 'done' });
    expect(afterStart.messages[1]).toMatchObject({ id: 'a1', role: 'assistant', status: 'pending' });

    handlers.onThinking?.({ note: 'đang nghĩ' });
    expect(useChatStore.getState().messages[1]?.status).toBe('streaming');

    const updatedWorkflow: Workflow = { ...sampleWorkflow, name: 'Updated by AI' };
    handlers.onMessage?.({ content: 'Đã xong', workflow: updatedWorkflow, version: 7, changeId: 42 });

    const afterMessage = useChatStore.getState();
    expect(afterMessage.messages[1]).toMatchObject({ content: 'Đã xong', status: 'done', changeId: 42 });
    expect(afterMessage.workflowVersion).toBe(7);
    expect(useFlowStore.getState().workflow.name).toBe('Updated by AI');

    handlers.onDone?.();
    await vi.waitFor(() => {
      expect(useChatStore.getState().turnState).toBe('idle');
    });
    expect(useChatStore.getState().activeTurnMessageId).toBeNull();
    expect(api.listConversations).toHaveBeenCalled();
  });

  // SPEC-step26.md §4.2 — onMessage's reconcile (adoptWorkflow) always wins
  // over whatever store/flow.ts's applyOptimisticOp built up locally from
  // this turn's own patch-op events.
  it("onMessage's reconcile overwrites the optimistic workflow built up from this turn's own patch-op events", async () => {
    useFlowStore.setState({
      workflow: { version: 1, id: 'wf1', name: 'wf', nodes: [], edges: [] },
      dirty: false,
    });
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u2', assistantMessageId: 'a2' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);

    await useChatStore.getState().sendMessage('test');
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'optimistic-only', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 1,
    });
    expect(useFlowStore.getState().workflow.nodes.map((n) => n.id)).toEqual(['optimistic-only']);

    const serverWorkflow: Workflow = {
      version: 1,
      id: 'wf1',
      name: 'Server truth',
      nodes: [{ id: 'server-node', type: 'input.text', params: {} }],
      edges: [],
    };
    handlers.onMessage?.({ content: 'done', workflow: serverWorkflow, version: 2, changeId: 1 });

    expect(useFlowStore.getState().workflow.nodes.map((n) => n.id)).toEqual(['server-node']);
  });

  it("move-node ops both move the node and set an 'updated' highlight (not 'added')", async () => {
    useFlowStore.setState({
      workflow: {
        version: 1,
        id: 'wf1',
        name: 'wf',
        nodes: [{ id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } }],
        edges: [],
      },
      dirty: false,
    });
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u2', assistantMessageId: 'a2' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);

    await useChatStore.getState().sendMessage('test');
    handlers.onPatchOp?.({ op: { op: 'move-node', nodeId: 'n1', position: { x: 50, y: 60 } }, index: 0, total: 1 });

    expect(useFlowStore.getState().workflow.nodes[0]?.position).toEqual({ x: 50, y: 60 });
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(useChatStore.getState().opHighlights.n1).toMatchObject({ kind: 'updated' });
  });

  it('an error event marks the assistant message as error and sets chatError', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u3', assistantMessageId: 'a3' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);

    await useChatStore.getState().sendMessage('test');
    handlers.onError?.({ message: 'Model lỗi' });

    const state = useChatStore.getState();
    expect(state.messages[1]).toMatchObject({ status: 'error', error: 'Model lỗi' });
    expect(state.chatError).toBe('Model lỗi');
  });

  it('409 (turn-in-progress) sets chatError without appending any message, and resolves false', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockRejectedValue(new api.ApiError(409, 'turn-in-progress'));

    const sent = await useChatStore.getState().sendMessage('test');

    expect(sent).toBe(false);
    expect(useChatStore.getState().chatError).toBe('AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.');
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().turnState).toBe('idle');
  });

  it('resolves true on a successful send (before the turn even resolves)', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    vi.mocked(api.openTurnEvents).mockImplementation(() => vi.fn());

    const sent = await useChatStore.getState().sendMessage('test');
    expect(sent).toBe(true);
  });

  it('bumps chatErrorNonce every time a 409 fires, even with the identical message text twice in a row', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockRejectedValue(new api.ApiError(409, 'turn-in-progress'));

    await useChatStore.getState().sendMessage('test');
    const nonceAfterFirst = useChatStore.getState().chatErrorNonce;
    expect(nonceAfterFirst).toBeGreaterThan(0);
    expect(useChatStore.getState().chatError).toBe('AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.');

    await useChatStore.getState().sendMessage('test again');
    expect(useChatStore.getState().chatError).toBe('AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.');
    expect(useChatStore.getState().chatErrorNonce).toBeGreaterThan(nonceAfterFirst);
  });

  it('a race: switching to a different conversation while postChatMessage is in flight does not append the stale send onto the new conversation, nor touch its turnState', async () => {
    // conversation A is active when the send starts.
    useChatStore.setState({ activeConversationId: 'c1', messages: [{ id: 'a-existing', conversationId: 'c1', role: 'user', content: 'old', status: 'done', createdAt: 0 }] });

    let resolvePost!: (value: { userMessageId: string; assistantMessageId: string }) => void;
    vi.mocked(api.postChatMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );

    const sendPromise = useChatStore.getState().sendMessage('hello from A');

    // While the request for A is still in flight, the user switches to a
    // different conversation B (mirrors ConversationRail's selectConversation).
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c2', workflowId: 'wf2', title: 'Conv B', createdAt: 1, updatedAt: 2, lastSeenChangeId: null },
      messages: [{ id: 'b-existing', conversationId: 'c2', role: 'user', content: 'hi from B', status: 'done', createdAt: 5 }],
      workflow: { ...sampleWorkflow, id: 'wf2', name: 'B workflow' },
      version: 1,
    });
    await useChatStore.getState().selectConversation('c2');
    expect(useChatStore.getState().activeConversationId).toBe('c2');
    expect(useChatStore.getState().messages).toEqual([
      { id: 'b-existing', conversationId: 'c2', role: 'user', content: 'hi from B', status: 'done', createdAt: 5 },
    ]);

    // Now A's postChatMessage finally resolves.
    resolvePost({ userMessageId: 'ua', assistantMessageId: 'aa' });
    const sent = await sendPromise;

    expect(sent).toBe(true); // the message really was accepted server-side
    // B's messages/turnState must be untouched by A's stale continuation.
    expect(useChatStore.getState().activeConversationId).toBe('c2');
    expect(useChatStore.getState().messages).toEqual([
      { id: 'b-existing', conversationId: 'c2', role: 'user', content: 'hi from B', status: 'done', createdAt: 5 },
    ]);
    expect(useChatStore.getState().turnState).toBe('idle');
    expect(useFlowStore.getState().workflow.name).toBe('B workflow');
    // No SSE subscription was ever opened for the now-abandoned A turn.
    expect(api.openTurnEvents).not.toHaveBeenCalled();
  });

  it('a stale turn\'s onDone does not clobber a different, genuinely-in-progress turn\'s turnState after the user switched conversations', async () => {
    // Defense-in-depth for the same isDisplayed() guard (mirrors
    // store/flow.ts's run(): "gate every handler, not just the reachable
    // ones"): normally selectConversation's stopActiveTurnSubscription()
    // closes A's EventSource before this could happen, but `onDone` must
    // stay safe even if a last event for A's connection still lands after
    // the user has switched away and started a genuinely new turn on B.
    // Turn A starts and its SSE stream opens while A is displayed.
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValueOnce({ userMessageId: 'ua', assistantMessageId: 'aa' });
    let handlersA: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementationOnce((_conv, _msg, h) => {
      handlersA = h;
      return vi.fn();
    });
    await useChatStore.getState().sendMessage('from A');
    expect(useChatStore.getState().turnState).toBe('streaming');

    // The user switches to conversation B (resets turnState to idle for B)
    // and then sends their own message, which starts streaming for real.
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c2', workflowId: 'wf2', title: 'Conv B', createdAt: 1, updatedAt: 2, lastSeenChangeId: null },
      messages: [],
      workflow: { ...sampleWorkflow, id: 'wf2' },
      version: 1,
    });
    await useChatStore.getState().selectConversation('c2');

    vi.mocked(api.postChatMessage).mockResolvedValueOnce({ userMessageId: 'ub', assistantMessageId: 'ab' });
    let handlersB: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementationOnce((_conv, _msg, h) => {
      handlersB = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);
    await useChatStore.getState().sendMessage('from B');
    expect(useChatStore.getState().turnState).toBe('streaming');
    expect(useChatStore.getState().activeTurnMessageId).toBe('ab');

    // A's (stale, backgrounded) turn finishes now — its `onDone` must NOT
    // reset turnState/activeTurnMessageId, because B's own turn is still
    // genuinely streaming.
    handlersA.onDone?.();

    expect(useChatStore.getState().turnState).toBe('streaming');
    expect(useChatStore.getState().activeTurnMessageId).toBe('ab');

    // B's own onDone still works normally afterwards.
    handlersB.onDone?.();
    await vi.waitFor(() => {
      expect(useChatStore.getState().turnState).toBe('idle');
    });
  });

  it('no-ops when there is no active conversation', async () => {
    useChatStore.setState({ activeConversationId: null, messages: [] });
    await useChatStore.getState().sendMessage('test');
    expect(api.postChatMessage).not.toHaveBeenCalled();
  });

  it('no-ops on blank content', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    await useChatStore.getState().sendMessage('   ');
    expect(api.postChatMessage).not.toHaveBeenCalled();
  });
});

describe('stopActiveTurn', () => {
  it('calls stopTurn with the active conversation/message ids', async () => {
    useChatStore.setState({ activeConversationId: 'c1', activeTurnMessageId: 'a1' });
    vi.mocked(api.stopTurn).mockResolvedValue({ stopped: true });

    await useChatStore.getState().stopActiveTurn();

    expect(api.stopTurn).toHaveBeenCalledWith('c1', 'a1');
  });

  it('no-ops when there is no active turn', async () => {
    useChatStore.setState({ activeConversationId: 'c1', activeTurnMessageId: null });
    await useChatStore.getState().stopActiveTurn();
    expect(api.stopTurn).not.toHaveBeenCalled();
  });
});

describe('removeConversation', () => {
  it('removes it from the list; if it was active, clears chat state and calls newWorkflow()', async () => {
    useChatStore.setState({
      conversations: [sampleSummary],
      activeConversationId: 'c1',
      activeTitle: 'Conv 1',
      messages: [{ id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', status: 'done', createdAt: 1 }],
    });
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined);

    await useChatStore.getState().removeConversation('c1');

    expect(api.deleteConversation).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().conversations).toEqual([]);
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
    // newWorkflow() resets the flow store to a fresh, undirtied workflow.
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(useFlowStore.getState().workflow.nodes).toEqual([]);
  });

  it('removing a non-active conversation only trims the list', async () => {
    useChatStore.setState({
      conversations: [sampleSummary, { ...sampleSummary, id: 'c2' }],
      activeConversationId: 'c2',
    });
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined);

    await useChatStore.getState().removeConversation('c1');

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['c2']);
    expect(useChatStore.getState().activeConversationId).toBe('c2');
  });
});

// SPEC-step24.md §2/§6 — the split-layout state: pure helpers first (no
// store needed), then setSplitRatio's clamp/snap/animate/persist behavior,
// then the two auto-behaviors that call it from elsewhere in this store.
describe('layout — pure functions', () => {
  it('layoutModeFromRatio: >=0.99 chat, <=0.01 canvas, else split', () => {
    expect(layoutModeFromRatio(1)).toBe('chat');
    expect(layoutModeFromRatio(0.995)).toBe('chat');
    expect(layoutModeFromRatio(0.5)).toBe('split');
    expect(layoutModeFromRatio(0.01)).toBe('canvas');
    expect(layoutModeFromRatio(0)).toBe('canvas');
  });

  it('nextMode cycles chat -> split -> canvas -> chat forward, and reverses with dir=-1', () => {
    expect(nextMode('chat', 1)).toBe('split');
    expect(nextMode('split', 1)).toBe('canvas');
    expect(nextMode('canvas', 1)).toBe('chat');
    expect(nextMode('chat', -1)).toBe('canvas');
    expect(nextMode('canvas', -1)).toBe('split');
    expect(nextMode('split', -1)).toBe('chat');
  });

  it('modeRatio returns the canonical splitRatio for each mode', () => {
    expect(modeRatio('chat')).toBe(1);
    expect(modeRatio('split')).toBe(0.5);
    expect(modeRatio('canvas')).toBe(0);
  });

  it('resolveSplitRatio clamps to [0,1] when containerWidth is unknown', () => {
    expect(resolveSplitRatio(1.4)).toBe(1);
    expect(resolveSplitRatio(-0.2)).toBe(0);
    expect(resolveSplitRatio(0.5)).toBe(0.5);
  });

  it('resolveSplitRatio snaps fully closed when a pane would fall under its min-width', () => {
    const containerWidth = 1000;
    // ratio 0.05 -> chat share 50px < CHAT_MIN_WIDTH (320) -> snap to 0
    expect(resolveSplitRatio(0.05, containerWidth)).toBe(0);
    // ratio 0.95 -> canvas share 50px < CANVAS_MIN_WIDTH (420) -> snap to 1
    expect(resolveSplitRatio(0.95, containerWidth)).toBe(1);
    // both panes stay above their minimums -> untouched
    expect(resolveSplitRatio(0.5, containerWidth)).toBe(0.5);
    // comfortably above the chat-side threshold (CHAT_MIN_WIDTH + 20px) -> not snapped
    // (kept a few px away from the exact boundary — a boundary ratio like
    // CHAT_MIN_WIDTH/containerWidth round-trips through float multiplication
    // and can land a fraction of a px either side of the threshold)
    const safeAboveChatMin = (CHAT_MIN_WIDTH + 20) / containerWidth;
    expect(resolveSplitRatio(safeAboveChatMin, containerWidth)).toBe(safeAboveChatMin);
    // comfortably below it -> snapped closed
    const safeBelowChatMin = (CHAT_MIN_WIDTH - 20) / containerWidth;
    expect(resolveSplitRatio(safeBelowChatMin, containerWidth)).toBe(0);
    // symmetric check on the canvas side
    const safeAboveCanvasMin = 1 - (CANVAS_MIN_WIDTH + 20) / containerWidth;
    expect(resolveSplitRatio(safeAboveCanvasMin, containerWidth)).toBe(safeAboveCanvasMin);
    const safeBelowCanvasMin = 1 - (CANVAS_MIN_WIDTH - 20) / containerWidth;
    expect(resolveSplitRatio(safeBelowCanvasMin, containerWidth)).toBe(1);
  });

  it('resolveSplitRatio never snaps an already-fully-open pane, even in a container smaller than the other pane\'s minimum', () => {
    expect(resolveSplitRatio(1, 100)).toBe(1);
    expect(resolveSplitRatio(0, 100)).toBe(0);
  });
});

describe('setSplitRatio / layoutMode (SPEC-step24.md §2)', () => {
  it('updates splitRatio; layoutMode() derives the current mode from it', () => {
    useChatStore.getState().setSplitRatio(0.5);
    expect(useChatStore.getState().splitRatio).toBe(0.5);
    expect(useChatStore.getState().layoutMode()).toBe('split');
  });

  it('clamps out-of-range ratios to [0,1]', () => {
    useChatStore.getState().setSplitRatio(2);
    expect(useChatStore.getState().splitRatio).toBe(1);
    useChatStore.getState().setSplitRatio(-1);
    expect(useChatStore.getState().splitRatio).toBe(0);
  });

  it('snaps to 0 when containerWidth would leave the chat pane under its min-width', () => {
    useChatStore.getState().setSplitRatio(0.05, { containerWidth: 1000 });
    expect(useChatStore.getState().splitRatio).toBe(0);
  });

  it('{ animate: true } sets splitAnimating and clears it after SPLIT_ANIMATE_MS (300ms)', () => {
    vi.useFakeTimers();
    try {
      useChatStore.getState().setSplitRatio(0.5, { animate: true });
      expect(useChatStore.getState().splitAnimating).toBe(true);
      vi.advanceTimersByTime(300);
      expect(useChatStore.getState().splitAnimating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plain drag (no animate) never sets splitAnimating', () => {
    useChatStore.getState().setSplitRatio(0.6);
    expect(useChatStore.getState().splitAnimating).toBe(false);
  });

  // Regression (SPEC-step24.md implementation review): a plain drag call
  // landing while a *previous* animated call's 300ms window is still open
  // (double-click-to-reset, a ModeToggle click, or either auto-behavior in
  // this file, all followed within 300ms by the user grabbing the divider)
  // must immediately clear `splitAnimating` — otherwise ChatPane/CanvasPane
  // keep applying their CSS transition to a drag that must track the
  // pointer with zero lag, until the stale timer happens to fire on its own.
  it('a plain drag interrupts an in-flight animated transition, clearing splitAnimating immediately', () => {
    vi.useFakeTimers();
    try {
      useChatStore.getState().setSplitRatio(0.6, { animate: true });
      expect(useChatStore.getState().splitAnimating).toBe(true);

      // A drag pointermove lands mid-transition (well before the 300ms
      // animate-clear timer would fire on its own).
      vi.advanceTimersByTime(50);
      useChatStore.getState().setSplitRatio(0.55, { containerWidth: 1000 });
      expect(useChatStore.getState().splitRatio).toBeCloseTo(0.55);
      expect(useChatStore.getState().splitAnimating).toBe(false);

      // The stale timer must have been cancelled, not merely raced — letting
      // it fire late should be a no-op (no unrelated flip back to `true`,
      // no clobbering of a ratio set by further drag moves in between).
      useChatStore.getState().setSplitRatio(0.5, { containerWidth: 1000 });
      vi.advanceTimersByTime(300);
      expect(useChatStore.getState().splitAnimating).toBe(false);
      expect(useChatStore.getState().splitRatio).toBeCloseTo(0.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the resolved ratio to localStorage 200ms after the call (throttled)', () => {
    // A real `window.localStorage` (jsdom's or the host Node runtime's) is
    // swapped out for a plain in-memory mock — store/chat.ts's own
    // `persistSplitRatio` wraps every access in try/catch specifically
    // because real localStorage availability varies by environment, which
    // makes a spy on the real one an unreliable way to assert "was it
    // called with X" here; a mock removes that variable entirely.
    vi.useFakeTimers();
    const backing: Record<string, string> = {};
    const mockStorage: Storage = {
      getItem: vi.fn((key: string) => backing[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        backing[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete backing[key];
      }),
      clear: vi.fn(() => {
        for (const key of Object.keys(backing)) delete backing[key];
      }),
      key: vi.fn(() => null),
      length: 0,
    };
    const original = window.localStorage;
    Object.defineProperty(window, 'localStorage', { value: mockStorage, configurable: true });
    try {
      useChatStore.getState().setSplitRatio(0.3);
      vi.advanceTimersByTime(200);
      expect(mockStorage.setItem).toHaveBeenCalledWith('ff.splitRatio', '0.3');
    } finally {
      Object.defineProperty(window, 'localStorage', { value: original, configurable: true });
      vi.useRealTimers();
    }
  });
});

describe('layout auto-behaviors', () => {
  it('selectConversation auto-splits to 0.5 when the workflow has nodes and layout is chat-only', async () => {
    useChatStore.setState({ splitRatio: 1 });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: { ...sampleWorkflow, nodes: [{ id: 'n1', type: 'input.text', params: {} }] },
      version: 1,
    });

    await useChatStore.getState().selectConversation('c1');

    expect(useChatStore.getState().splitRatio).toBe(0.5);
  });

  it('selectConversation does NOT auto-split when the layout is already split/canvas', async () => {
    useChatStore.setState({ splitRatio: 0 });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: { ...sampleWorkflow, nodes: [{ id: 'n1', type: 'input.text', params: {} }] },
      version: 1,
    });

    await useChatStore.getState().selectConversation('c1');

    expect(useChatStore.getState().splitRatio).toBe(0);
  });

  it('selectConversation does NOT auto-split an empty workflow', async () => {
    useChatStore.setState({ splitRatio: 1 });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: sampleWorkflow,
      version: 1,
    });

    await useChatStore.getState().selectConversation('c1');

    expect(useChatStore.getState().splitRatio).toBe(1);
  });

  // SPEC-step26.md §2.1/§4.4 — superseded the SPEC-step24.md §2 interim
  // heuristic above (auto-split on `onMessage`'s non-null `changeId`): the
  // trigger now lives on the turn's first `patch-op` event instead — see
  // the dedicated `onPatchOp` describe block below for the full coverage
  // (index-0-only, chat-mode-only, guarded by conversation).
});

// SPEC-step26.md §2/§4.1 — onPatchOp: optimistic applyPatch (in order,
// dirty stays false), PatchError skipped silently, highlight bookkeeping
// per op kind (+ cleared on done), the stale-conversation guard, and the
// turn's-first-op auto-split trigger (chat-mode-only, index-0-only).
describe('onPatchOp (SPEC-step26.md §2)', () => {
  beforeEach(() => {
    useFlowStore.setState({
      workflow: { version: 1, id: 'wf1', name: 'wf', nodes: [], edges: [] },
      dirty: false,
    });
  });

  /** Starts a turn (default splitRatio left as whatever the caller already set) and returns its SSE handlers. */
  async function startTurn(): Promise<TurnEventHandlers> {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);
    await useChatStore.getState().sendMessage('test');
    return handlers;
  }

  it('applies ops in order onto the flow workflow, without setting dirty (2 add-node ops -> 2 nodes)', async () => {
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 2,
    });
    // n2 has no position -> gets the deterministic temporary grid slot for index 1.
    handlers.onPatchOp?.({ op: { op: 'add-node', node: { id: 'n2', type: 'input.text', params: {} } }, index: 1, total: 2 });

    const workflow = useFlowStore.getState().workflow;
    expect(workflow.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(workflow.nodes[1]?.position).toEqual({ x: 460, y: 120 });
    expect(useFlowStore.getState().dirty).toBe(false);
  });

  it('a PatchError op (references a node that never got created) is skipped silently — console.warn, no throw, workflow unaffected', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = await startTurn();

    expect(() =>
      handlers.onPatchOp?.({ op: { op: 'update-node', nodeId: 'missing', params: {} }, index: 0, total: 1 }),
    ).not.toThrow();

    expect(useFlowStore.getState().workflow.nodes).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sets a highlight per op kind, and clears every highlight once the turn is done', async () => {
    const handlers = await startTurn();

    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 3,
    });
    expect(useChatStore.getState().opHighlights.n1).toMatchObject({ kind: 'added' });

    handlers.onPatchOp?.({ op: { op: 'update-node', nodeId: 'n1', params: { value: 'x' } }, index: 1, total: 3 });
    expect(useChatStore.getState().opHighlights.n1).toMatchObject({ kind: 'updated' });

    handlers.onPatchOp?.({
      op: { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n1', port: 'text' } } },
      index: 2,
      total: 3,
    });
    expect(useChatStore.getState().opHighlights.e1).toMatchObject({ kind: 'edge-added' });

    handlers.onDone?.();
    expect(useChatStore.getState().opHighlights).toEqual({});
  });

  it('a remove-* op clears any highlight for that id instead of setting one', async () => {
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 2,
    });
    expect(useChatStore.getState().opHighlights.n1).toBeDefined();

    handlers.onPatchOp?.({ op: { op: 'remove-node', nodeId: 'n1' }, index: 1, total: 2 });
    expect(useChatStore.getState().opHighlights.n1).toBeUndefined();
    expect(useFlowStore.getState().workflow.nodes).toEqual([]);
  });

  it('guards a stale conversation: patch-op events for a conversation the user navigated away from do not touch the (now different) displayed workflow', async () => {
    const handlers = await startTurn(); // c1 active, wf1 displayed

    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c2', workflowId: 'wf2', title: 'B', createdAt: 1, updatedAt: 2, lastSeenChangeId: null },
      messages: [],
      workflow: { version: 1, id: 'wf2', name: 'B', nodes: [], edges: [] },
      version: 1,
    });
    await useChatStore.getState().selectConversation('c2');

    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 1,
    });

    expect(useFlowStore.getState().workflow.id).toBe('wf2');
    expect(useFlowStore.getState().workflow.nodes).toEqual([]);
  });

  it("the turn's first patch-op auto-splits to 0.4 when the layout is chat-only", async () => {
    useChatStore.setState({ splitRatio: 1 });
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 1,
    });
    expect(useChatStore.getState().splitRatio).toBe(0.4);
  });

  it('does NOT auto-split when the layout is already split or canvas', async () => {
    useChatStore.setState({ splitRatio: 0.5 });
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 1,
    });
    expect(useChatStore.getState().splitRatio).toBe(0.5);

    useChatStore.setState({ splitRatio: 0 });
    handlers.onPatchOp?.({ op: { op: 'add-node', node: { id: 'n2', type: 'input.text', params: {} } }, index: 0, total: 1 });
    expect(useChatStore.getState().splitRatio).toBe(0);
  });

  it('only the first op (index 0) of a turn triggers the split, not later ones', async () => {
    useChatStore.setState({ splitRatio: 1 });
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 2,
    });
    expect(useChatStore.getState().splitRatio).toBe(0.4);

    // Pretend the user flipped back to chat-only mid-turn — a later op must
    // NOT re-trigger the split.
    useChatStore.setState({ splitRatio: 1 });
    handlers.onPatchOp?.({ op: { op: 'add-node', node: { id: 'n2', type: 'input.text', params: {} } }, index: 1, total: 2 });
    expect(useChatStore.getState().splitRatio).toBe(1);
  });
});

describe('requestFocusComposer (SPEC-step24.md §5)', () => {
  it('bumps focusComposerNonce every call', () => {
    const before = useChatStore.getState().focusComposerNonce;
    useChatStore.getState().requestFocusComposer();
    expect(useChatStore.getState().focusComposerNonce).toBe(before + 1);
    useChatStore.getState().requestFocusComposer();
    expect(useChatStore.getState().focusComposerNonce).toBe(before + 2);
  });
});
