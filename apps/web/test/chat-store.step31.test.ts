/**
 * store/chat.ts `newConversation` — SPEC-step31.md F4: repeated "+ Cuộc trò
 * chuyện mới" clicks must not rack up multiple empty ("Chưa đặt tên", 0 node)
 * conversations. Mocks `api/client.ts` the same way test/chat-store.test.ts
 * does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSummary, Workflow } from '../src/api/types.ts';

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
    postManualChange: vi.fn(),
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
  title: '',
  createdAt: 1,
  updatedAt: 2,
  lastSeenChangeId: null,
};

describe('newConversation (SPEC-step31.md F4)', () => {
  it('calling it twice in a row only ever POSTs once — the second call switches to the still-unused empty conversation instead', async () => {
    vi.mocked(api.createConversation).mockResolvedValue(sampleConversation);
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: sampleWorkflow,
      version: 0,
    });

    await useChatStore.getState().newConversation();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(useChatStore.getState().activeConversationId).toBe('c1');

    await useChatStore.getState().newConversation();

    expect(api.createConversation).toHaveBeenCalledTimes(1); // still just one call
    expect(useChatStore.getState().conversations).toHaveLength(1); // no rack-up
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });

  it('an already-active unused conversation is a pure no-op — no re-select round trip either', async () => {
    useChatStore.setState({
      conversations: [{ ...sampleConversation, nodeCount: 0 } as ConversationSummary],
      activeConversationId: 'c1',
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.getConversation).not.toHaveBeenCalled();
  });

  it('post-review fix — a stale nodeCount:0 on the ACTIVE conversation (real node added purely manually, no chat turn) is NOT treated as unused: a fresh conversation is created instead of dead-ending', async () => {
    useChatStore.setState({
      conversations: [{ ...sampleConversation, nodeCount: 0 } as ConversationSummary],
      activeConversationId: 'c1',
    });
    // `loadConversations()` never re-fetches after a purely manual canvas
    // edit (SPEC-step31.md F4 post-review fix) — simulate that staleness by
    // giving the live canvas a node the cached `nodeCount` doesn't know about.
    useFlowStore.setState({
      workflow: { version: 1, id: 'wf1', name: 'Conv workflow', nodes: [{ id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } }], edges: [] },
    });
    const created: Conversation = { ...sampleConversation, id: 'c2' };
    vi.mocked(api.createConversation).mockResolvedValue(created);
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: created,
      messages: [],
      workflow: { ...sampleWorkflow, id: 'wf2' },
      version: 0,
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().activeConversationId).toBe('c2');
  });

  it('an unused conversation that is NOT currently active is switched to (selectConversation), not recreated', async () => {
    useChatStore.setState({
      conversations: [{ ...sampleConversation, nodeCount: 0 } as ConversationSummary],
      activeConversationId: null,
    });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: sampleConversation,
      messages: [],
      workflow: sampleWorkflow,
      version: 0,
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).not.toHaveBeenCalled();
    expect(api.getConversation).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });

  it('a conversation with a title (even 0 nodes) does NOT count as unused — a fresh one is still created', async () => {
    useChatStore.setState({
      conversations: [{ ...sampleConversation, title: 'Đã đặt tên', nodeCount: 0 } as ConversationSummary],
      activeConversationId: null,
    });
    const created: Conversation = { ...sampleConversation, id: 'c2' };
    vi.mocked(api.createConversation).mockResolvedValue(created);
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: created,
      messages: [],
      workflow: { ...sampleWorkflow, id: 'wf2' },
      version: 0,
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().activeConversationId).toBe('c2');
  });

  it('a conversation with 0 title but >0 nodes does NOT count as unused — a fresh one is still created', async () => {
    useChatStore.setState({
      conversations: [{ ...sampleConversation, title: '', nodeCount: 3 } as ConversationSummary],
      activeConversationId: null,
    });
    const created: Conversation = { ...sampleConversation, id: 'c2' };
    vi.mocked(api.createConversation).mockResolvedValue(created);
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: created,
      messages: [],
      workflow: { ...sampleWorkflow, id: 'wf2' },
      version: 0,
    });

    await useChatStore.getState().newConversation();

    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().activeConversationId).toBe('c2');
  });
});
