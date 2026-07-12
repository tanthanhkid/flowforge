/**
 * ChatPane.tsx (SPEC-step23.md §6/§8.4): message bubbles by role/status,
 * Enter-to-send vs Shift+Enter-newline, the Gửi/■ Dừng button swap, the two
 * empty states, and the suggestion chips filling (not sending) the composer.
 * Mocks `api/client.ts` so the real `store/chat.ts` actions run against a
 * fake network, same pattern as test/conversation-rail.test.tsx.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    postChatMessage: vi.fn(),
    stopTurn: vi.fn(),
    openTurnEvents: vi.fn(),
    listConversations: vi.fn(),
    renameConversation: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import type { ChatMessage, Workflow } from '../src/api/types.ts';
import { ChatPane } from '../src/panels/ChatPane.tsx';
import { useChatStore } from '../src/store/chat.ts';

afterEach(() => {
  cleanup();
});

function resetStore(overrides: Partial<ReturnType<typeof useChatStore.getState>> = {}): void {
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
    splitRatio: 1,
    splitAnimating: false,
    focusComposerNonce: 0,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

const workflow: Workflow = { version: 1, id: 'wf1', name: 'x', nodes: [], edges: [] };

describe('ChatPane — empty states', () => {
  // SPEC-step24.md §4 — the app's actual "trang chủ": no conversation
  // selected at all, at the default chat-first splitRatio (1.0). Renders
  // the pure landing hero (headline + composer + chips) rather than a bare
  // "create a conversation" button — typing + sending claims a conversation
  // on the fly (DESIGN-ai-native.md §II.2).
  it('no active conversation, chat mode (default): shows the landing hero; sending creates a conversation on the fly', async () => {
    vi.mocked(api.createConversation).mockResolvedValue({
      id: 'c1',
      workflowId: 'wf1',
      title: '',
      createdAt: 1,
      updatedAt: 1,
      lastSeenChangeId: null,
    });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c1', workflowId: 'wf1', title: '', createdAt: 1, updatedAt: 1, lastSeenChangeId: null },
      messages: [],
      workflow,
      version: 0,
    });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    vi.mocked(api.openTurnEvents).mockImplementation(() => vi.fn());

    render(<ChatPane />);
    expect(screen.getByTestId('chat-hero')).toBeInTheDocument();
    expect(screen.getByText('Mô tả workflow bạn muốn tạo')).toBeInTheDocument();
    // The hero's own chip row (spec: "chip gợi ý bên dưới").
    expect(screen.getAllByTestId('chat-suggestion-chip')).toHaveLength(3);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Tạo video TikTok' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await vi.waitFor(() => {
      expect(api.createConversation).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'Tạo video TikTok');
    });
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });

  // SPEC-step24.md §4 — too narrow for the full hero treatment (e.g. the
  // user is in split mode with no conversation selected, perhaps after
  // deleting the active one) — falls back to the pre-step24 plain prompt.
  it('no active conversation, non-chat mode: falls back to the plain "choose or create" prompt', async () => {
    resetStore({ splitRatio: 0.5 });
    vi.mocked(api.createConversation).mockResolvedValue({
      id: 'c1',
      workflowId: 'wf1',
      title: '',
      createdAt: 1,
      updatedAt: 1,
      lastSeenChangeId: null,
    });
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c1', workflowId: 'wf1', title: '', createdAt: 1, updatedAt: 1, lastSeenChangeId: null },
      messages: [],
      workflow,
      version: 0,
    });

    render(<ChatPane />);
    expect(screen.getByText('Chọn hoặc tạo cuộc trò chuyện để bắt đầu')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-hero')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-empty-new-conversation'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeConversationId).toBe('c1');
    });
  });

  it('active conversation with 0 messages: shows 3 suggestion chips; clicking one fills the composer without sending', () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [] });
    render(<ChatPane />);

    const chips = screen.getAllByTestId('chat-suggestion-chip');
    expect(chips).toHaveLength(3);

    fireEvent.click(chips[0]!);
    expect(screen.getByTestId('chat-input')).toHaveValue(chips[0]!.textContent);
    expect(api.postChatMessage).not.toHaveBeenCalled();
  });
});

describe('ChatPane — message bubbles', () => {
  it('renders bubbles by role/status: user, assistant pending (spinner), assistant error', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'xin chào', status: 'done', createdAt: 1 },
      { id: 'm2', conversationId: 'c1', role: 'assistant', content: '', status: 'pending', createdAt: 2 },
      {
        id: 'm3',
        conversationId: 'c1',
        role: 'assistant',
        content: '',
        status: 'error',
        error: 'Model lỗi',
        createdAt: 3,
      },
    ];
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages });
    render(<ChatPane />);

    const bubbles = screen.getAllByTestId('chat-message');
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toHaveAttribute('data-role', 'user');
    expect(bubbles[0]).toHaveTextContent('xin chào');
    expect(bubbles[1]).toHaveAttribute('data-status', 'pending');
    expect(bubbles[1]).toHaveTextContent('AI đang xử lý…');
    expect(bubbles[2]).toHaveAttribute('data-status', 'error');
    expect(bubbles[2]).toHaveTextContent('Model lỗi');
  });
});

describe('ChatPane — composer', () => {
  beforeEach(() => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    vi.mocked(api.openTurnEvents).mockImplementation(() => vi.fn());
  });

  it('Enter sends the message and clears the composer', async () => {
    render(<ChatPane />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Tạo video TikTok' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'Tạo video TikTok');
    });
    // Composer clearing now waits on sendMessage's resolved (`sent`) value
    // (SPEC-step23.md follow-up fix: it must NOT clear on a 409), so it
    // lands one tick after the `postChatMessage` call itself is observed.
    await vi.waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('Shift+Enter inserts a newline instead of sending', () => {
    render(<ChatPane />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'dòng 1' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(api.postChatMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue('dòng 1');
  });

  it('clicking Gửi sends via the store', async () => {
    render(<ChatPane />);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await vi.waitFor(() => {
      expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'hello');
    });
  });

  it('while streaming, the send button becomes ■ Dừng and calls stopActiveTurn on click', async () => {
    vi.mocked(api.stopTurn).mockResolvedValue({ stopped: true });
    resetStore({
      activeConversationId: 'c1',
      activeTitle: 'Conv 1',
      messages: [],
      turnState: 'streaming',
      activeTurnMessageId: 'a1',
    });
    render(<ChatPane />);

    const button = screen.getByTestId('chat-send');
    expect(button).toHaveTextContent('Dừng');
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(api.stopTurn).toHaveBeenCalledWith('c1', 'a1');
    });
  });

  it('shows chatError above the composer and hides it once the user types again', () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [], chatError: 'Lỗi mạng' });
    render(<ChatPane />);
    expect(screen.getByText('Lỗi mạng')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'a' } });
    expect(screen.queryByText('Lỗi mạng')).not.toBeInTheDocument();
  });

  it('re-shows the error banner for a SECOND 409 with the identical message text, even after the user hid the first one by typing', async () => {
    const message = 'AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.';
    vi.mocked(api.postChatMessage).mockRejectedValue(new api.ApiError(409, 'turn-in-progress'));
    render(<ChatPane />);

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'first try' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await screen.findByText(message);

    // Typing again hides the banner (existing "tự ẩn khi gõ tiếp" behavior).
    fireEvent.change(input, { target: { value: 'first try, more' } });
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    // A second send hits the exact same 409 message string. Before the fix,
    // Object.is-equal repeats of `chatError` never re-ran the effect that
    // un-hides the banner, so it stayed hidden here.
    fireEvent.click(screen.getByTestId('chat-send'));
    await screen.findByText(message);
  });

  it('does not clear the composer on a 409 (turn-in-progress) — the typed content must survive so the user can retry', async () => {
    vi.mocked(api.postChatMessage).mockRejectedValue(new api.ApiError(409, 'turn-in-progress'));
    render(<ChatPane />);

    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'nội dung chưa gửi được' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await vi.waitFor(() => {
      expect(useChatStore.getState().chatError).toBe('AI đang xử lý lượt trước — đợi xong rồi gửi tiếp.');
    });
    expect(input).toHaveValue('nội dung chưa gửi được');
  });
});

describe('ChatPane — rename', () => {
  it('clicking ✏️ opens an inline input; Enter commits via renameActive', async () => {
    vi.mocked(api.renameConversation).mockResolvedValue({
      id: 'c1',
      workflowId: 'wf1',
      title: 'Tên mới',
      createdAt: 1,
      updatedAt: 2,
      lastSeenChangeId: null,
    });

    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [] });
    render(<ChatPane />);

    fireEvent.click(screen.getByTestId('chat-rename-btn'));
    const input = screen.getByTestId('chat-rename-input');
    fireEvent.change(input, { target: { value: 'Tên mới' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(api.renameConversation).toHaveBeenCalledWith('c1', 'Tên mới');
    });
  });
});
