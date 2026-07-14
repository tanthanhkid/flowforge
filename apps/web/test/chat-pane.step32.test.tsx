/**
 * ChatPane.tsx SPEC-step32.md B1/B2/B4 additions: the 📎 attach button/hidden
 * input, pending-attachment chips (uploading spinner -> done thumbnail, ✕
 * remove, ≤3 cap + toast, Gửi disabled mid-upload), a user bubble's own
 * attachment thumbnails, the diff chip under a done assistant bubble (label
 * + split/fit-view CTA), and the AI title mirrored into the header the
 * instant `onMessage` carries one. Mocks `api/client.ts` + `ui/Toast.tsx`,
 * same pattern as test/chat-pane.test.tsx / test/manual-log.test.ts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    uploadFile: vi.fn(),
  };
});

vi.mock('../src/ui/Toast.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/Toast.tsx')>();
  return { ...actual, toast: vi.fn() };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import type { TurnEventHandlers } from '../src/api/client.ts';
import type { ChatMessage, UploadResult } from '../src/api/types.ts';
import { ChatPane } from '../src/panels/ChatPane.tsx';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';
import { toast } from '../src/ui/Toast.tsx';

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

/** A promise the test controls the resolution of, to observe the "uploading" state. */
function deferredUpload(): { promise: Promise<UploadResult>; resolve: (v: UploadResult) => void } {
  let resolve!: (v: UploadResult) => void;
  const promise = new Promise<UploadResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pngFile(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('ChatPane — composer attachments (SPEC-step32.md B1)', () => {
  beforeEach(() => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [] });
  });

  it('clicking 📎 opens the hidden file input', () => {
    render(<ChatPane />);
    const input = screen.getByTestId('chat-attach-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.click(screen.getByTestId('chat-attach-btn'));

    expect(clickSpy).toHaveBeenCalled();
  });

  it('the hidden input accepts multiple png/jpeg/webp/gif files', () => {
    render(<ChatPane />);
    const input = screen.getByTestId('chat-attach-input');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
    expect(input).toHaveAttribute('multiple');
  });

  it('shows a spinner chip while uploading, then swaps to an image thumbnail once uploadFile resolves', async () => {
    const deferred = deferredUpload();
    vi.mocked(api.uploadFile).mockReturnValue(deferred.promise);
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pngFile('cat.png')] } });

    const chip = await screen.findByTestId('chat-attach-chip');
    expect(within(chip).getByRole('status')).toBeInTheDocument();
    expect(within(chip).queryByRole('img')).not.toBeInTheDocument();

    deferred.resolve({ path: 'uploads/cat.png', filename: 'cat.png', mime: 'image/png', size: 1, kind: 'image' });

    await waitFor(() => {
      expect(within(chip).getByRole('img')).toHaveAttribute('src', '/artifacts/uploads/cat.png');
    });
  });

  it('caps at 3 attachments per selection batch, toasts, and only uploads the ones that fit', async () => {
    vi.mocked(api.uploadFile).mockImplementation(
      (file: File) =>
        Promise.resolve({ path: `uploads/${file.name}`, filename: file.name, mime: 'image/png', size: 1, kind: 'image' as const }),
    );
    render(<ChatPane />);

    const files = [pngFile('a.png'), pngFile('b.png'), pngFile('c.png'), pngFile('d.png')];
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files } });

    await waitFor(() => expect(screen.getAllByTestId('chat-attach-chip')).toHaveLength(3));
    expect(api.uploadFile).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('tối đa 3'), 'error');
  });

  it('clicking ✕ removes a pending attachment chip', async () => {
    vi.mocked(api.uploadFile).mockResolvedValue({ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png', size: 1, kind: 'image' });
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pngFile('a.png')] } });
    await screen.findByTestId('chat-attach-chip');

    fireEvent.click(screen.getByLabelText('Gỡ đính kèm'));

    expect(screen.queryByTestId('chat-attach-chip')).not.toBeInTheDocument();
  });

  it('disables Gửi while any attachment is still uploading, re-enabling once it resolves', async () => {
    const deferred = deferredUpload();
    vi.mocked(api.uploadFile).mockReturnValue(deferred.promise);
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pngFile('a.png')] } });
    await screen.findByTestId('chat-attach-chip');

    expect(screen.getByTestId('chat-send')).toBeDisabled();

    deferred.resolve({ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png', size: 1, kind: 'image' });
    await waitFor(() => expect(screen.getByTestId('chat-send')).not.toBeDisabled());
  });

  it('sends with the uploaded attachments and renders a thumbnail under the resulting user bubble', async () => {
    vi.mocked(api.uploadFile).mockResolvedValue({ path: 'uploads/cat.png', filename: 'cat.png', mime: 'image/png', size: 1, kind: 'image' });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    vi.mocked(api.openTurnEvents).mockImplementation(() => vi.fn());
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pngFile('cat.png')] } });
    const chip = await screen.findByTestId('chat-attach-chip');
    await waitFor(() => expect(within(chip).getByRole('img')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'dùng ảnh này' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    await waitFor(() => {
      expect(api.postChatMessage).toHaveBeenCalledWith('c1', 'dùng ảnh này', [
        { path: 'uploads/cat.png', filename: 'cat.png', mime: 'image/png' },
      ]);
    });

    const thumb = await screen.findByTestId('chat-message-attachment');
    expect(thumb).toHaveAttribute('src', '/artifacts/uploads/cat.png');
    // The composer's own pending-attachment row is cleared once the send goes through.
    expect(screen.queryByTestId('chat-attach-chip')).not.toBeInTheDocument();
  });

  it('clears pending attachments when switching to a different conversation without sending', async () => {
    vi.mocked(api.uploadFile).mockResolvedValue({ path: 'uploads/a.png', filename: 'a.png', mime: 'image/png', size: 1, kind: 'image' });
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-attach-input'), { target: { files: [pngFile('a.png')] } });
    const chip = await screen.findByTestId('chat-attach-chip');
    await waitFor(() => expect(within(chip).getByRole('img')).toBeInTheDocument());

    // ChatPane never unmounts across a conversation switch — mirror that by
    // just flipping the store's activeConversationId, same as
    // `selectConversation` would (no send happened in between).
    act(() => {
      useChatStore.setState({ activeConversationId: 'c2', activeTitle: 'Conv 2', messages: [] });
    });

    expect(screen.queryByTestId('chat-attach-chip')).not.toBeInTheDocument();
  });
});

describe('ChatPane — diff chip (SPEC-step32.md B2)', () => {
  const doneMessage: ChatMessage = {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Đã xong',
    status: 'done',
    createdAt: 1,
    diff: { addNode: 2, removeNode: 0, updateNode: 1, addEdge: 3, removeEdge: 0, moveNode: 0 },
  };

  it('renders under a done assistant bubble with the formatted label', () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [doneMessage] });
    render(<ChatPane />);

    expect(screen.getByTestId('chat-diff-chip')).toHaveTextContent('🔧 +2 node · ~1 param · +3 nối');
  });

  it('does not render when diff is all-zero or absent from the message', () => {
    resetStore({
      activeConversationId: 'c1',
      activeTitle: 'Conv 1',
      messages: [
        { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'chỉ chat', status: 'done', createdAt: 1 },
        {
          id: 'a2',
          conversationId: 'c1',
          role: 'assistant',
          content: 'zero diff',
          status: 'done',
          createdAt: 2,
          diff: { addNode: 0, removeNode: 0, updateNode: 0, addEdge: 0, removeEdge: 0, moveNode: 0 },
        },
      ],
    });
    render(<ChatPane />);

    expect(screen.queryByTestId('chat-diff-chip')).not.toBeInTheDocument();
  });

  it('does not render on a still-streaming assistant message even if it somehow carries a diff', () => {
    resetStore({
      activeConversationId: 'c1',
      activeTitle: 'Conv 1',
      messages: [{ ...doneMessage, status: 'streaming' }],
    });
    render(<ChatPane />);

    expect(screen.queryByTestId('chat-diff-chip')).not.toBeInTheDocument();
  });

  it('clicking it splits chat-only to 0.5 (animated) and always bumps the canvas fit-view nonce', () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [doneMessage], splitRatio: 1 });
    const fitViewNonceBefore = useFlowStore.getState().fitViewNonce;
    render(<ChatPane />);

    fireEvent.click(screen.getByTestId('chat-diff-chip'));

    expect(useChatStore.getState().splitRatio).toBe(0.5);
    expect(useChatStore.getState().splitAnimating).toBe(true);
    expect(useFlowStore.getState().fitViewNonce).toBe(fitViewNonceBefore + 1);
  });

  it('clicking it while already split only re-fits the view, leaving splitRatio untouched', () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Conv 1', messages: [doneMessage], splitRatio: 0.4 });
    const fitViewNonceBefore = useFlowStore.getState().fitViewNonce;
    render(<ChatPane />);

    fireEvent.click(screen.getByTestId('chat-diff-chip'));

    expect(useChatStore.getState().splitRatio).toBe(0.4);
    expect(useFlowStore.getState().fitViewNonce).toBe(fitViewNonceBefore + 1);
  });
});

describe("ChatPane — AI title mirrors immediately via SSE onMessage (SPEC-step32.md B4)", () => {
  it('updates the header title the instant onMessage carries one, without waiting for onDone', async () => {
    resetStore({ activeConversationId: 'c1', activeTitle: 'Chưa đặt tên', messages: [] });
    vi.mocked(api.postChatMessage).mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a1' });
    let handlers: TurnEventHandlers = {};
    vi.mocked(api.openTurnEvents).mockImplementation((_conv, _msg, h) => {
      handlers = h;
      return vi.fn();
    });
    render(<ChatPane />);

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'tạo video mèo' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(api.postChatMessage).toHaveBeenCalled());

    handlers.onMessage?.({
      content: 'ok',
      workflow: { version: 1, id: 'wf1', name: 'wf', nodes: [], edges: [] },
      version: 1,
      changeId: null,
      title: 'Video mèo con',
    });

    expect(await screen.findByText('Video mèo con')).toBeInTheDocument();
  });
});
