/**
 * SPEC-step32.md B1/B2/B4 additions to store/chat.ts: `sendMessage`'s
 * optional `attachments` param (forwarded to `postChatMessage`, mirrored
 * onto the optimistic user message), the per-turn diff accumulator
 * (`onPatchOp` counts -> finalized onto the assistant message at
 * `onMessage`), the pure `formatDiffChip` chip-label formatter, and
 * `onMessage`'s AI-title mirroring into `activeTitle`/`conversations`.
 * Mocks `api/client.ts` the same way test/chat-store.test.ts does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEventHandlers } from '../src/api/client.ts';
import type { ChatAttachment, ChatDiffCounts, Conversation, ConversationSummary, Workflow } from '../src/api/types.ts';
import { formatDiffChip, useChatStore } from '../src/store/chat.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    postChatMessage: vi.fn(),
    openTurnEvents: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
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
    workflow: { version: 1, id: 'wf1', name: 'wf', nodes: [], edges: [] },
    selectedNodeId: null,
    dirty: false,
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

/** Starts a turn and returns its SSE handlers, same pattern as test/chat-store.test.ts. */
async function startTurn(attachments?: ChatAttachment[]): Promise<TurnEventHandlers> {
  useChatStore.setState({ activeConversationId: 'c1', messages: [] });
  vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
  let handlers: TurnEventHandlers = {};
  vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
    handlers = h;
    return vi.fn();
  });
  vi.mocked(api.listConversations).mockResolvedValue([sampleSummary]);
  await useChatStore.getState().sendMessage('test', attachments);
  return handlers;
}

describe('sendMessage attachments (SPEC-step32.md B1)', () => {
  it('forwards attachments to postChatMessage and mirrors them onto the optimistic user message', async () => {
    const attachments = [{ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png' }];
    await startTurn(attachments);

    expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'test', attachments);
    const userMessage = useChatStore.getState().messages.find((m) => m.role === 'user');
    expect(userMessage?.attachments).toEqual(attachments);
  });

  it('omits the 3rd arg entirely (byte-identical 2-arg call) when no attachments are given', async () => {
    await startTurn();
    expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'test');
    const userMessage = useChatStore.getState().messages.find((m) => m.role === 'user');
    expect(userMessage?.attachments).toBeUndefined();
  });

  it('treats an empty attachments array the same as none (omitted arg, undefined on the message)', async () => {
    await startTurn([]);
    expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'test');
    const userMessage = useChatStore.getState().messages.find((m) => m.role === 'user');
    expect(userMessage?.attachments).toBeUndefined();
  });
});

describe('formatDiffChip (SPEC-step32.md B2)', () => {
  function counts(overrides: Partial<ChatDiffCounts>): ChatDiffCounts {
    return { addNode: 0, removeNode: 0, updateNode: 0, addEdge: 0, removeEdge: 0, moveNode: 0, ...overrides };
  }

  it('returns null when every count is 0', () => {
    expect(formatDiffChip(counts({}))).toBeNull();
  });

  it('formats the spec example exactly: +2 node · ~1 param · +3 nối', () => {
    expect(formatDiffChip(counts({ addNode: 2, updateNode: 1, addEdge: 3 }))).toBe('🔧 +2 node · ~1 param · +3 nối');
  });

  it('shows remove-node/remove-edge counts too, in node/param/edge order', () => {
    expect(formatDiffChip(counts({ addNode: 1, removeNode: 2, updateNode: 0, addEdge: 0, removeEdge: 1 }))).toBe(
      '🔧 +1 node · -2 node · -1 nối',
    );
  });

  it('shows moveNode alone as ↔N vị trí only when nothing else changed', () => {
    expect(formatDiffChip(counts({ moveNode: 3 }))).toBe('🔧 ↔3 vị trí');
  });

  it('suppresses moveNode entirely when any other kind of change is present', () => {
    expect(formatDiffChip(counts({ addNode: 1, moveNode: 5 }))).toBe('🔧 +1 node');
  });
});

describe('onPatchOp diff accumulator -> onMessage finalize (SPEC-step32.md B2)', () => {
  it('counts ops per kind over the turn and assigns them onto the assistant message at onMessage', async () => {
    const handlers = await startTurn();
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 4,
    });
    handlers.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n2', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 1,
      total: 4,
    });
    handlers.onPatchOp?.({ op: { op: 'update-node', nodeId: 'n1', params: { x: 1 } }, index: 2, total: 4 });
    handlers.onPatchOp?.({
      op: { op: 'add-edge', edge: { id: 'e1', from: { node: 'n1', port: 'text' }, to: { node: 'n2', port: 'text' } } },
      index: 3,
      total: 4,
    });

    handlers.onMessage?.({ content: 'done', workflow: sampleWorkflow, version: 2, changeId: 1 });

    const assistantMessage = useChatStore.getState().messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.diff).toEqual({
      addNode: 2,
      removeNode: 0,
      updateNode: 1,
      addEdge: 1,
      removeEdge: 0,
      moveNode: 0,
    });
  });

  it('a turn with zero patch-ops finalizes an all-zero diff (chip-hiding is the UI\'s job, not the store\'s)', async () => {
    const handlers = await startTurn();
    handlers.onMessage?.({ content: 'no changes, just chat', workflow: sampleWorkflow, version: 1, changeId: null });

    const assistantMessage = useChatStore.getState().messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.diff).toEqual({
      addNode: 0,
      removeNode: 0,
      updateNode: 0,
      addEdge: 0,
      removeEdge: 0,
      moveNode: 0,
    });
  });

  it('each sendMessage call starts its own fresh accumulator (a 2nd turn does not carry over the 1st\'s counts)', async () => {
    const handlersA = await startTurn();
    handlersA.onPatchOp?.({
      op: { op: 'add-node', node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } } },
      index: 0,
      total: 1,
    });
    handlersA.onMessage?.({ content: 'first', workflow: sampleWorkflow, version: 1, changeId: 1 });
    handlersA.onDone?.();
    await vi.waitFor(() => expect(useChatStore.getState().turnState).toBe('idle'));

    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u2', assistantMessageId: 'a2' });
    let handlersB: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlersB = h;
      return vi.fn();
    });
    await useChatStore.getState().sendMessage('second');
    handlersB.onMessage?.({ content: 'second done', workflow: sampleWorkflow, version: 2, changeId: null });

    const secondAssistant = useChatStore.getState().messages.find((m) => m.id === 'a2');
    expect(secondAssistant?.diff).toEqual({
      addNode: 0,
      removeNode: 0,
      updateNode: 0,
      addEdge: 0,
      removeEdge: 0,
      moveNode: 0,
    });
  });
});

describe("onMessage's AI title (SPEC-step32.md B4)", () => {
  it('updates activeTitle and the matching conversations list entry when the message carries a title', async () => {
    useChatStore.setState({ conversations: [sampleSummary] });
    const handlers = await startTurn();

    handlers.onMessage?.({ content: 'done', workflow: sampleWorkflow, version: 1, changeId: null, title: 'Video mèo con' });

    expect(useChatStore.getState().activeTitle).toBe('Video mèo con');
    expect(useChatStore.getState().conversations.find((c) => c.id === 'c1')?.title).toBe('Video mèo con');
  });

  it('leaves activeTitle/conversations untouched when the message carries no title', async () => {
    useChatStore.setState({ activeTitle: 'Conv 1', conversations: [sampleSummary] });
    const handlers = await startTurn();

    handlers.onMessage?.({ content: 'done', workflow: sampleWorkflow, version: 1, changeId: null });

    expect(useChatStore.getState().activeTitle).toBe('Conv 1');
    expect(useChatStore.getState().conversations.find((c) => c.id === 'c1')?.title).toBe('Conv 1');
  });
});
