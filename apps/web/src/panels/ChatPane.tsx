/**
 * ChatPane (SPEC-step23.md §6, SPEC-step24.md §4): the persistent chat
 * column between ConversationRail and CanvasPane (split via SplitDivider).
 * Its own outer width is `flexGrow: splitRatio` (CanvasPane mirrors it with
 * `1 - splitRatio`) so the two panes always sum to the chat+divider+canvas
 * span's full width, proportioned exactly by `splitRatio` — `flexBasis: 0` +
 * `min-w-0` let it shrink all the way to 0px (a bare `w-*` class or `flex: 1
 * 1 auto` would refuse to shrink past its content's intrinsic width).
 * `overflow: hidden` keeps this pane always mounted (composer text/scroll
 * position survive a mode switch) rather than unmounting at 0 width.
 *
 * SPEC-step24.md §4 "landing hero": when the layout is full chat-width
 * (`splitRatio >= 0.99`) AND there's nothing to show yet (no conversation
 * selected at all), this renders a big centered headline + composer + chip
 * row instead of the narrow default. Typing into that composer and hitting
 * Send/Enter creates a conversation on the fly (`newConversation()` then
 * `sendMessage()`) — DESIGN-ai-native.md §II.2's "gõ mô tả đầu tiên, bấm gửi
 * -> tạo conversation ngay" — rather than requiring a separate "+ Cuộc trò
 * chuyện mới" click first. Everything else (an already-selected
 * conversation, empty or not) keeps the pre-step24 layout, just with an
 * extra `mx-auto max-w-*` centering wrapper while in chat mode.
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { uploadFile } from '../api/client.ts';
import type { ChatAttachment } from '../api/types.ts';
import { formatDiffChip, layoutModeFromRatio, useChatStore } from '../store/chat.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { toast } from '../ui/Toast.tsx';

/** SPEC-step23.md §6 — composer auto-grows from 1 to at most 4 lines. */
const MAX_TEXTAREA_ROWS = 4;

/** SPEC-step23.md §2 "Trang chủ chat" — 3 quick-start chips (fill, don't auto-send). */
const SUGGESTIONS = [
  'Viết caption Facebook rồi tạo ảnh minh hoạ bằng fal.ai',
  'Tạo video TikTok ngắn kèm giọng đọc tiếng Việt (Vbee)',
  'Đọc kịch bản thành giọng nói lồng tiếng, ghép nhạc nền',
];

/** SPEC-step32.md B1 — composer attachment cap, mirrors the server's own `max 3`. */
const MAX_ATTACHMENTS = 3;
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * SPEC-step32.md B1 — one composer attachment in flight or done uploading.
 * `id` is a local-only key (never sent to the server); only `done` items
 * with a `path` are eligible to actually go out on send.
 */
interface PendingAttachment {
  id: string;
  status: 'uploading' | 'done';
  filename?: string;
  mime?: string;
  path?: string;
}

function textareaRows(value: string): number {
  const lines = value.split('\n').length;
  return Math.min(MAX_TEXTAREA_ROWS, Math.max(1, lines));
}

let nextAttachmentLocalId = 1;

export function ChatPane() {
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeTitle = useChatStore((s) => s.activeTitle);
  const messages = useChatStore((s) => s.messages);
  const turnState = useChatStore((s) => s.turnState);
  const chatError = useChatStore((s) => s.chatError);
  const chatErrorNonce = useChatStore((s) => s.chatErrorNonce);
  const splitRatio = useChatStore((s) => s.splitRatio);
  // Only during an *animated* setSplitRatio call — a live divider drag must
  // track the pointer with zero transition lag (see CanvasPane.tsx).
  const splitAnimating = useChatStore((s) => s.splitAnimating);
  const focusComposerNonce = useChatStore((s) => s.focusComposerNonce);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopActiveTurn = useChatStore((s) => s.stopActiveTurn);
  const renameActive = useChatStore((s) => s.renameActive);
  const newConversation = useChatStore((s) => s.newConversation);
  // SPEC-step32.md B2 — the diff chip's CTA: an already-selected animated
  // `setSplitRatio` (chat-only -> split) plus an unconditional `requestFitView`
  // pulled straight from store/flow.ts (action call only, per spec — this
  // file never touches flow.ts itself).
  const setSplitRatio = useChatStore((s) => s.setSplitRatio);
  const requestFitView = useFlowStore((s) => s.requestFitView);

  const [composer, setComposer] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // Lets a fresh chatError show, but hides itself the moment the user starts
  // typing again (spec: "tự ẩn khi gõ tiếp") without needing a store action.
  const [errorHidden, setErrorHidden] = useState(false);
  // SPEC-step24.md §4 — true only while the hero composer's first send is
  // busy creating a conversation on the fly; guards against a double-click
  // firing `newConversation()` twice before the first one resolves.
  const [creatingConversation, setCreatingConversation] = useState(false);
  // SPEC-step32.md B1 — composer attachments, in upload order; cleared once
  // a send actually goes through (mirrors `composer` itself).
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const mode = layoutModeFromRatio(splitRatio);

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

  useEffect(() => {
    // SPEC-step24.md §5 — the empty-canvas onboarding CTA bumps this nonce
    // after switching into split mode; focus whichever composer textarea is
    // currently mounted. `focusComposerNonce === 0` is the store's initial
    // value (never requested yet) — skip so mount doesn't steal focus.
    if (focusComposerNonce === 0) return;
    textareaRef.current?.focus();
  }, [focusComposerNonce]);

  // SPEC-step32.md B1 fix — ChatPane never unmounts across a conversation
  // switch (it stays mounted the whole session, same as CanvasPane), so
  // `pendingAttachments` would otherwise survive a switch made WITHOUT
  // sending (attach in conversation A, click B in the rail, send in B ->
  // A's already-uploaded images silently attach to B's message). Clear on
  // every `activeConversationId` change, including the very first mount
  // (harmless no-op there since the array starts empty).
  useEffect(() => {
    setPendingAttachments([]);
  }, [activeConversationId]);

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

  // SPEC-step32.md B1 — uploads whatever was just picked (up to the
  // remaining room under MAX_ATTACHMENTS), one at a time; each item gets its
  // own local id so its chip can independently flip uploading -> done (or
  // disappear on error) without disturbing any sibling already in flight.
  async function handleAttachFiles(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    const room = MAX_ATTACHMENTS - pendingAttachments.length;
    if (files.length > room) {
      toast(`Chỉ đính kèm tối đa ${MAX_ATTACHMENTS} ảnh.`, 'error');
    }
    const toUpload = files.slice(0, Math.max(0, room));

    for (const file of toUpload) {
      const localId = String(nextAttachmentLocalId++);
      setPendingAttachments((prev) => [...prev, { id: localId, status: 'uploading', filename: file.name }]);
      try {
        const result = await uploadFile(file);
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.id === localId ? { ...a, status: 'done', path: result.path, filename: result.filename, mime: result.mime } : a,
          ),
        );
      } catch (err) {
        setPendingAttachments((prev) => prev.filter((a) => a.id !== localId));
        toast(err instanceof Error ? err.message : 'Tải ảnh lên thất bại', 'error');
      }
    }
  }

  function removeAttachment(id: string): void {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSend(): Promise<void> {
    const trimmed = composer.trim();
    const uploading = pendingAttachments.some((a) => a.status === 'uploading');
    if (turnState !== 'idle' || trimmed.length < 1 || creatingConversation || uploading) return;

    // SPEC-step24.md §4 — the landing hero's composer works with no
    // conversation selected yet: claim one now (this also adopts its
    // fresh `emptyWorkflow()` into the canvas pane), then fall through to
    // the normal send below using the store's now-current conversation id.
    if (!useChatStore.getState().activeConversationId) {
      setCreatingConversation(true);
      try {
        await newConversation();
      } finally {
        setCreatingConversation(false);
      }
      if (!useChatStore.getState().activeConversationId) return;
    }

    const attachments: ChatAttachment[] = pendingAttachments
      .filter((a) => a.status === 'done' && a.path)
      .map((a) => ({ path: a.path!, filename: a.filename, mime: a.mime }));

    // Only clear the composer once we know the message was actually sent —
    // `sendMessage` resolves `false` (without throwing) on a 409
    // "turn in progress" (the client's own `turnState` guard above can lose
    // a race against the server, e.g. another tab). Clearing synchronously
    // before that result comes back used to permanently drop whatever the
    // user had typed on that path, with only a generic error banner shown.
    void sendMessage(trimmed, attachments.length > 0 ? attachments : undefined).then((sent) => {
      if (sent) {
        setComposer('');
        setPendingAttachments([]);
      }
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  // SPEC-step32.md B2 — the diff chip's CTA: split open the canvas if the
  // layout is currently chat-only, then always re-fit the viewport so
  // whatever the turn just changed is actually in view.
  function handleDiffChipClick(): void {
    if (mode === 'chat') setSplitRatio(0.5, { animate: true });
    requestFitView();
  }

  const wrapperStyle = { flexGrow: splitRatio, flexBasis: 0 };
  const wrapperTransitionClass = splitAnimating
    ? 'motion-safe:transition-[flex-grow] motion-safe:duration-300 motion-safe:ease-out'
    : '';

  // SPEC-step32.md B1 — a send while any attachment is still uploading is
  // disallowed (its `path` isn't known yet), same spirit as the existing
  // `creatingConversation` guard.
  const uploadingAttachment = pendingAttachments.some((a) => a.status === 'uploading');

  const composerNode = (
    <>
      {chatError && !errorHidden && <p className="mb-1.5 text-[11px] font-bold text-status-error">{chatError}</p>}
      {pendingAttachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {pendingAttachments.map((a) => (
            <div
              key={a.id}
              data-testid="chat-attach-chip"
              className="relative flex h-12 w-12 items-center justify-center border-2 border-ink bg-paper"
            >
              {a.status === 'uploading' ? (
                <Spinner />
              ) : (
                <img src={`/artifacts/${a.path}`} alt={a.filename ?? 'đính kèm'} className="h-full w-full object-cover" />
              )}
              <button
                type="button"
                aria-label="Gỡ đính kèm"
                data-testid="chat-attach-remove"
                onClick={() => removeAttachment(a.id)}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center border-2 border-ink bg-bg text-[9px] leading-none hover:bg-accent"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label="Đính kèm ảnh"
          data-testid="chat-attach-btn"
          onClick={() => attachInputRef.current?.click()}
          className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-ink bg-paper text-sm hover:bg-accent"
        >
          📎
        </button>
        <input
          ref={attachInputRef}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          data-testid="chat-attach-input"
          className="hidden"
          onChange={(event) => void handleAttachFiles(event)}
        />
        <textarea
          ref={textareaRef}
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
            onClick={() => void handleSend()}
            disabled={composer.trim().length < 1 || creatingConversation || uploadingAttachment}
          >
            Gửi
          </Button>
        )}
      </div>
    </>
  );

  const chipsNode = (
    <>
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
    </>
  );

  // ---- Pure landing hero: no conversation selected at all, full chat width
  //      (the app's actual "trang chủ" — DESIGN-ai-native.md §II.2). ----
  if (!activeConversationId && mode === 'chat') {
    return (
      // No padding on THIS outer div — it's the one sized by `flexGrow:
      // splitRatio`, and a fixed padding here would put a hard floor under
      // how far it can ever shrink (a border-box element can never render
      // smaller than its own padding+border, no matter what width/flex-
      // basis/min-width says — the content box clamps at 0, but padding
      // never does). All spacing lives on the inner `chat-hero` div instead,
      // which is free to just get clipped by `overflow-hidden` above it.
      <div
        data-testid="chat-pane"
        style={wrapperStyle}
        className={`flex min-w-0 flex-col items-center justify-center overflow-hidden border-r-[3px] border-ink bg-bg ${wrapperTransitionClass}`}
      >
        <div data-testid="chat-hero" className="flex w-full max-w-2xl flex-col items-center gap-4 p-8">
          <h1 className="text-center font-display text-2xl uppercase tracking-wide text-ink">
            Mô tả workflow bạn muốn tạo
          </h1>
          <p className="text-center text-xs font-medium text-ink-soft">
            AI dựng node, nối cạnh và điền tham số giúp bạn — bạn vẫn chỉnh tay được sau đó.
          </p>
          <div className="w-full">{composerNode}</div>
          <div className="flex w-full flex-col gap-2">{chipsNode}</div>
        </div>
      </div>
    );
  }

  // ---- No conversation selected, but the pane isn't full chat-width (e.g.
  //      split): too narrow for the hero treatment — keep the plain prompt,
  //      same as before SPEC-step24.md. Padding lives on the inner div for
  //      the same reason as the hero branch above. ----
  if (!activeConversationId) {
    return (
      <div
        data-testid="chat-pane"
        style={wrapperStyle}
        className={`flex min-w-0 flex-col items-center justify-center overflow-hidden border-r-[3px] border-ink bg-bg ${wrapperTransitionClass}`}
      >
        <div className="flex flex-col items-center gap-3 p-6 text-center">
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
      </div>
    );
  }

  return (
    <div
      data-testid="chat-pane"
      style={wrapperStyle}
      className={`flex min-w-0 flex-col overflow-hidden border-r-[3px] border-ink bg-bg ${wrapperTransitionClass}`}
    >
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
        {messages.length === 0 ? (
          <div
            className={
              mode === 'chat'
                ? 'mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center gap-2 text-center'
                : 'flex flex-col gap-2'
            }
          >
            {chipsNode}
          </div>
        ) : (
          <div className={mode === 'chat' ? 'mx-auto flex w-full max-w-3xl flex-col gap-2' : 'flex flex-col gap-2'}>
            {messages.map((message) => {
              const isUser = message.role === 'user';
              const isPending = message.status === 'pending' || message.status === 'streaming';
              const isError = message.status === 'error';
              // SPEC-step32.md B2 — only render the chip when there's
              // something to show (formatDiffChip returns null on all-zero
              // counts), on a finished assistant turn.
              const diffLabel =
                !isUser && message.status === 'done' && message.diff ? formatDiffChip(message.diff) : null;
              return (
                <div key={message.id} className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
                  <div
                    data-testid="chat-message"
                    data-role={message.role}
                    data-status={message.status}
                    className={`max-w-[85%] border-2 border-ink px-2.5 py-1.5 text-xs font-medium ${
                      isUser
                        ? 'bg-accent text-ink'
                        : isError
                          ? 'bg-status-error/15 text-status-error shadow-hard-2'
                          : 'bg-paper text-ink shadow-hard-2'
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
                  {/* SPEC-step32.md B1 — thumbnails for a user message's attachments (own upload, or reloaded from the server). */}
                  {isUser && message.attachments && message.attachments.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.attachments.map((att, i) => (
                        <a
                          key={`${message.id}-att-${String(i)}`}
                          href={`/artifacts/${att.path}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={`/artifacts/${att.path}`}
                            alt={att.filename ?? 'đính kèm'}
                            data-testid="chat-message-attachment"
                            className="h-24 w-24 border-2 border-ink object-cover"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {diffLabel && (
                    <button
                      type="button"
                      data-testid="chat-diff-chip"
                      onClick={handleDiffChipClick}
                      className="border-2 border-ink bg-accent px-2 py-1 text-[11px] font-bold text-ink shadow-hard-2 hover:bg-accent/80"
                    >
                      {diffLabel}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t-2 border-ink bg-paper p-2.5" data-testid="chat-composer">
        {composerNode}
      </div>
    </div>
  );
}
