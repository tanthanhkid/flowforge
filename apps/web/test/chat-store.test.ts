/**
 * store/chat.ts (SPEC-step23.md §4 / §8.2): selectConversation adopting the
 * workflow into store/flow.ts, sendMessage's SSE-driven happy path, the 409
 * turn-in-progress guard, stop, and removeConversation's active-conversation
 * cleanup. Mocks `api/client.ts` the same way test/store.test.ts does for
 * store/flow.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEventHandlers } from '../src/api/client.ts';
import type { ChatMessage, Conversation, ConversationSummary, Workflow } from '../src/api/types.ts';

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

  it('ignores patch-op events in this step (no-op, no crash) — SPEC-step25.md territory', async () => {
    useChatStore.setState({ activeConversationId: 'c1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u2', assistantMessageId: 'a2' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    vi.mocked(api.listConversations).mockResolvedValue([]);

    await useChatStore.getState().sendMessage('test');
    expect(() =>
      handlers.onPatchOp?.({ op: { op: 'move-node', nodeId: 'n1', position: { x: 0, y: 0 } }, index: 0, total: 1 }),
    ).not.toThrow();
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
