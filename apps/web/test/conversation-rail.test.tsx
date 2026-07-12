/**
 * ConversationRail.tsx (SPEC-step23.md §5/§8.3): the conversation list —
 * active-row highlight, ⚠ badge on a failed last run, debounced search
 * calling `loadConversations`, delete-with-confirm, and collapse toggle.
 * Mocks `api/client.ts` (not the store's own actions) so the real
 * `store/chat.ts` logic runs, same pattern as test/store.test.ts /
 * test/model-picker.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    listConversations: vi.fn(),
    deleteConversation: vi.fn(),
    getConversation: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import type { ConversationSummary } from '../src/api/types.ts';
import { ConversationRail } from '../src/panels/ConversationRail.tsx';
import { useChatStore } from '../src/store/chat.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function resetStore(conversations: ConversationSummary[] = [], overrides: Partial<ReturnType<typeof useChatStore.getState>> = {}): void {
  useChatStore.setState({
    conversations,
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
    ...overrides,
  });
}

const c1: ConversationSummary = {
  id: 'c1',
  workflowId: 'wf1',
  title: 'Video TikTok mèo',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 3,
};
const c2: ConversationSummary = {
  id: 'c2',
  workflowId: 'wf2',
  title: 'Đọc kịch bản Vbee',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 1,
  lastRunStatus: 'error',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConversationRail — list rendering', () => {
  beforeEach(() => {
    resetStore([c1, c2]);
  });

  it('renders each conversation with title, node count, and highlights the active one', () => {
    resetStore([c1, c2], { activeConversationId: 'c2' });
    render(<ConversationRail />);

    const items = screen.getAllByTestId('conversation-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Video TikTok mèo');
    expect(items[0]).toHaveTextContent('3 node');
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[0]).toHaveAttribute('data-active', 'false');
  });

  it('shows a ⚠ badge only for the conversation whose last run errored', () => {
    render(<ConversationRail />);
    const items = screen.getAllByTestId('conversation-item');
    expect(items[0]!.querySelector('[data-testid="conversation-error-badge"]')).toBeNull();
    expect(items[1]!.querySelector('[data-testid="conversation-error-badge"]')).not.toBeNull();
  });

  it('falls back to "Chưa đặt tên" for an empty title', () => {
    resetStore([{ ...c1, title: '' }]);
    render(<ConversationRail />);
    expect(screen.getByTestId('conversation-item')).toHaveTextContent('Chưa đặt tên');
  });

  it('clicking an item calls selectConversation with its id', async () => {
    const workflow = { version: 1 as const, id: 'wf1', name: 'x', nodes: [], edges: [] };
    vi.mocked(api.getConversation).mockResolvedValue({
      conversation: { id: 'c1', workflowId: 'wf1', title: 'Video TikTok mèo', createdAt: 1, updatedAt: 2, lastSeenChangeId: null },
      messages: [],
      workflow,
      version: 0,
    });
    render(<ConversationRail />);
    fireEvent.click(screen.getByText('Video TikTok mèo'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().activeConversationId).toBe('c1');
    });
  });
});

describe('ConversationRail — search debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore([c1, c2]);
    vi.mocked(api.listConversations).mockResolvedValue([]);
  });

  it('debounces 300ms before calling loadConversations with the typed query', async () => {
    render(<ConversationRail />);

    fireEvent.change(screen.getByTestId('conversation-search'), { target: { value: 'mèo' } });
    expect(api.listConversations).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(api.listConversations).toHaveBeenCalledWith('mèo');
  });

  it('mirrors the debounced query into store.search, so it matches whatever the rail actually just fetched', async () => {
    render(<ConversationRail />);
    expect(useChatStore.getState().search).toBe('');

    fireEvent.change(screen.getByTestId('conversation-search'), { target: { value: 'mèo' } });
    // Not set on every keystroke — only once the debounced fetch it's meant
    // to describe actually fires (a later turn's onDone reads `store.search`
    // to decide which filter to refetch with; it should reflect the list
    // that's currently displayed, not one still mid-debounce).
    expect(useChatStore.getState().search).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(useChatStore.getState().search).toBe('mèo');
  });
});

describe('ConversationRail — delete + collapse', () => {
  beforeEach(() => {
    resetStore([c1]);
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined);
  });

  it('delete asks for confirmation and only calls the API when confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConversationRail />);

    fireEvent.click(screen.getByTestId('conversation-delete-btn'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.deleteConversation).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId('conversation-delete-btn'));
    await vi.waitFor(() => {
      expect(api.deleteConversation).toHaveBeenCalledWith('c1');
    });
  });

  it('toggling collapse shrinks the rail to just the toggle + new-conversation icon buttons', () => {
    render(<ConversationRail />);
    expect(screen.getByTestId('conversation-search')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('rail-toggle'));

    expect(useChatStore.getState().railCollapsed).toBe(true);
    expect(screen.queryByTestId('conversation-search')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-conversation')).toBeInTheDocument();
  });
});
