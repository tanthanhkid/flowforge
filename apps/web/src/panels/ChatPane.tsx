/**
 * ChatPane (SPEC-step23.md §6): the persistent chat column sitting between
 * ConversationRail and the canvas's own Sidebar — INTERIM layout (fixed
 * `w-96`, no SplitDivider/Mode Toggle yet, that's SPEC-step24). Sends and
 * receives a full turn end-to-end via `store/chat.ts`, but does not animate
 * per patch-op yet (SPEC-step25).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useChatStore } from '../store/chat.ts';
import { Button } from '../ui/Button.tsx';
import { Spinner } from '../ui/Spinner.tsx';

/** SPEC-step23.md §6 — composer auto-grows from 1 to at most 4 lines. */
const MAX_TEXTAREA_ROWS = 4;

/** SPEC-step23.md §2 "Trang chủ chat" — 3 quick-start chips (fill, don't auto-send). */
const SUGGESTIONS = [
  'Viết caption Facebook rồi tạo ảnh minh hoạ bằng fal.ai',
  'Tạo video TikTok ngắn kèm giọng đọc tiếng Việt (Vbee)',
  'Đọc kịch bản thành giọng nói lồng tiếng, ghép nhạc nền',
];

function textareaRows(value: string): number {
  const lines = value.split('\n').length;
  return Math.min(MAX_TEXTAREA_ROWS, Math.max(1, lines));
}

export function ChatPane() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeTitle = useChatStore((s) => s.activeTitle);
  const messages = useChatStore((s) => s.messages);
  const turnState = useChatStore((s) => s.turnState);
  const chatError = useChatStore((s) => s.chatError);
  const chatErrorNonce = useChatStore((s) => s.chatErrorNonce);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopActiveTurn = useChatStore((s) => s.stopActiveTurn);
  const renameActive = useChatStore((s) => s.renameActive);
  const newConversation = useChatStore((s) => s.newConversation);

  const [composer, setComposer] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Lets a fresh chatError show, but hides itself the moment the user starts
  // typing again (spec: "tự ẩn khi gõ tiếp") without needing a store action.
  const [errorHidden, setErrorHidden] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Depends on `chatErrorNonce`, NOT `chatError` itself: the store bumps
    // the nonce every time a *new* error occurs, even if its text is
    // identical to the last one (e.g. two 409 "turn in progress" bumps in a
    // row across tabs). Keying off `chatError` would miss that case — React
    // bails out of re-running an effect whose dependency compares equal via
    // `Object.is`, and two equal strings do.
    setErrorHidden(false);
  }, [chatErrorNonce]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function startRename(): void {
    setRenameValue(activeTitle);
    setRenaming(true);
  }

  function commitRename(): void {
    setRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed.length > 0 && trimmed !== activeTitle) {
      void renameActive(trimmed);
    }
  }

  function handleComposerChange(value: string): void {
    setComposer(value);
    setErrorHidden(true);
  }

  function handleSend(): void {
    const trimmed = composer.trim();
    if (turnState !== 'idle' || !activeConversationId || trimmed.length < 1) return;
    // Only clear the composer once we know the message was actually sent —
    // `sendMessage` resolves `false` (without throwing) on a 409
    // "turn in progress" (the client's own `turnState` guard above can lose
    // a race against the server, e.g. another tab). Clearing synchronously
    // before that result comes back used to permanently drop whatever the
    // user had typed on that path, with only a generic error banner shown.
    void sendMessage(trimmed).then((sent) => {
      if (sent) setComposer('');
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  if (!activeConversationId) {
    return (
      <div
        data-testid="chat-pane"
        className="flex w-96 shrink-0 flex-col items-center justify-center gap-3 border-r-[3px] border-ink bg-bg p-6 text-center"
      >
        <p className="font-display text-sm uppercase tracking-wide text-ink">
          Chọn hoặc tạo cuộc trò chuyện để bắt đầu
        </p>
        <Button
          type="button"
          variant="primary"
          data-testid="chat-empty-new-conversation"
          onClick={() => void newConversation()}
        >
          + Cuộc trò chuyện mới
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="chat-pane" className="flex w-96 shrink-0 flex-col border-r-[3px] border-ink bg-bg">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-ink bg-paper px-3 py-2">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              }
            }}
            aria-label="Tên cuộc trò chuyện"
            data-testid="chat-rename-input"
            className="min-w-0 flex-1 border-2 border-ink bg-bg px-1.5 py-1 text-xs font-bold text-ink focus:outline-none"
          />
        ) : (
          <span className="truncate text-xs font-bold text-ink">{activeTitle || 'Chưa đặt tên'}</span>
        )}
        <button
          type="button"
          onClick={startRename}
          aria-label="Đổi tên cuộc trò chuyện"
          data-testid="chat-rename-btn"
          className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink bg-paper text-xs hover:bg-accent"
        >
          ✏️
        </button>
      </div>

      <div ref={listRef} data-testid="chat-message-list" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-bold text-ink-soft">Thử mô tả workflow bạn muốn tạo:</p>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                data-testid="chat-suggestion-chip"
                onClick={() => setComposer(suggestion)}
                className="border-2 border-ink bg-paper px-2 py-1.5 text-left text-[11px] font-medium text-ink shadow-hard-2 hover:bg-accent"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => {
          const isUser = message.role === 'user';
          const isPending = message.status === 'pending' || message.status === 'streaming';
          const isError = message.status === 'error';
          return (
            <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div
                data-testid="chat-message"
                data-role={message.role}
                data-status={message.status}
                className={`max-w-[85%] border-2 border-ink px-2.5 py-1.5 text-xs font-medium ${
                  isUser ? 'bg-accent text-ink' : isError ? 'bg-status-error/15 text-status-error shadow-hard-2' : 'bg-paper text-ink shadow-hard-2'
                }`}
              >
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-ink-soft">
                    <Spinner /> AI đang xử lý…
                  </span>
                ) : (
                  message.error || message.content || (isError ? 'Đã xảy ra lỗi.' : '')
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t-2 border-ink bg-paper p-2.5" data-testid="chat-composer">
        {chatError && !errorHidden && <p className="mb-1.5 text-[11px] font-bold text-status-error">{chatError}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={composer}
            onChange={(event) => handleComposerChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={textareaRows(composer)}
            placeholder="Mô tả workflow hoặc yêu cầu chỉnh sửa…"
            aria-label="Soạn tin nhắn"
            data-testid="chat-input"
            className="min-w-0 flex-1 resize-none border-2 border-ink bg-bg px-2 py-1.5 text-xs font-medium text-ink placeholder:text-ink-soft focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
          />
          {turnState === 'streaming' ? (
            <Button type="button" variant="danger" data-testid="chat-send" onClick={() => void stopActiveTurn()}>
              ■ Dừng
            </Button>
          ) : (
            <Button
              type="button"
              variant="ai"
              data-testid="chat-send"
              onClick={handleSend}
              disabled={composer.trim().length < 1}
            >
              Gửi
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
