/**
 * ConversationRail (SPEC-step23.md §5): outermost left column of the app —
 * the list of conversations (each 1-1 with a workflow), replacing the old
 * `WorkflowList.tsx` modal entirely. Style/interaction pattern (search box,
 * ✕ delete with `window.confirm`, active-row highlight) mirrors
 * `WorkflowList.tsx` before it was deleted — see that file's git history for
 * reference.
 */
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chat.ts';
import { Button } from '../ui/Button.tsx';

/** SPEC-step23.md §5 — debounce the search box before refetching the list. */
const SEARCH_DEBOUNCE_MS = 300;

export function ConversationRail() {
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const railCollapsed = useChatStore((s) => s.railCollapsed);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const selectConversation = useChatStore((s) => s.selectConversation);
  const newConversation = useChatStore((s) => s.newConversation);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const toggleRail = useChatStore((s) => s.toggleRail);
  const setSearch = useChatStore((s) => s.setSearch);

  const [query, setQuery] = useState('');
  // Deliberately NOT a `useEffect(..., [query])` — that form also fires once
  // on mount (and, under StrictMode's dev-only double-invoke, can still fire
  // even behind a "skip the first run" ref guard), duplicating App.tsx's own
  // mount-time `loadConversations()` call with a second, unguarded one 300ms
  // later. That second fetch can race a `removeConversation` in the same
  // window: its optimistic removal gets silently clobbered by this refetch
  // resolving with a stale, pre-delete snapshot. Debouncing straight from the
  // input's onChange instead only ever fires from an actual keystroke.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleSearchChange(value: string): void {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Mirror the query into the store alongside the fetch it drives (not
      // on every keystroke) so `store.search` always matches whatever
      // filter the rail's list actually reflects — chat.ts's sendMessage
      // `onDone` refetches with `get().search`, and without this the store
      // never left its initial `''`, silently refetching the FULL list
      // (undoing the visible filter) the next time any turn finishes.
      setSearch(value);
      void loadConversations(value || undefined);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function handleDelete(id: string, title: string): Promise<void> {
    if (!window.confirm(`Xoá cuộc trò chuyện "${title || 'Chưa đặt tên'}"?`)) return;
    await removeConversation(id);
  }

  if (railCollapsed) {
    return (
      <div className="flex w-14 shrink-0 flex-col items-center gap-2 border-r-[3px] border-ink bg-paper py-3">
        <button
          type="button"
          onClick={toggleRail}
          aria-label="Mở rộng danh sách cuộc trò chuyện"
          data-testid="rail-toggle"
          className="flex h-8 w-8 items-center justify-center border-2 border-ink bg-paper text-sm font-bold text-ink hover:bg-accent"
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => void newConversation()}
          aria-label="Cuộc trò chuyện mới"
          data-testid="new-conversation"
          className="flex h-8 w-8 items-center justify-center border-2 border-ink bg-accent text-sm font-bold text-ink shadow-hard-2"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-64 shrink-0 flex-col border-r-[3px] border-ink bg-paper">
      <div className="flex items-center justify-between gap-2 border-b-2 border-ink px-3 py-2">
        <span className="truncate font-display text-xs uppercase tracking-wide text-ink">Cuộc trò chuyện</span>
        <button
          type="button"
          onClick={toggleRail}
          aria-label="Thu gọn danh sách cuộc trò chuyện"
          data-testid="rail-toggle"
          className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink bg-paper text-xs font-bold text-ink hover:bg-accent"
        >
          ‹
        </button>
      </div>

      <div className="flex flex-col gap-2 border-b-2 border-ink p-3">
        <Button
          type="button"
          variant="primary"
          data-testid="new-conversation"
          onClick={() => void newConversation()}
          className="w-full justify-center"
        >
          + Cuộc trò chuyện mới
        </Button>
        <input
          type="text"
          value={query}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder="🔍 Tìm..."
          aria-label="Tìm cuộc trò chuyện"
          data-testid="conversation-search"
          className="border-2 border-ink bg-bg px-2 py-1.5 text-[11px] font-bold text-ink placeholder:text-ink-soft focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
        />
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {conversations.map((c) => {
          const isActive = c.id === activeConversationId;
          return (
            <li
              key={c.id}
              data-testid="conversation-item"
              data-active={isActive}
              className={`flex items-center gap-2 border-2 border-ink px-2 py-1.5 shadow-hard-2 transition-transform duration-100 motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 hover:shadow-hard-3 ${
                isActive ? 'bg-accent' : 'bg-paper'
              }`}
            >
              <button type="button" onClick={() => void selectConversation(c.id)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1 truncate text-xs font-bold text-ink">
                  <span className="truncate">{c.title || 'Chưa đặt tên'}</span>
                  {c.lastRunStatus === 'error' && (
                    <span aria-label="Run gần nhất lỗi" data-testid="conversation-error-badge" className="text-status-error">
                      ⚠
                    </span>
                  )}
                </span>
                <span className="block truncate text-[10px] font-medium text-ink-soft">{c.nodeCount} node</span>
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(c.id, c.title)}
                aria-label={`Xoá ${c.title || 'Chưa đặt tên'}`}
                data-testid="conversation-delete-btn"
                className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink bg-paper text-[11px] font-bold text-ink hover:bg-status-error hover:text-paper"
              >
                ✕
              </button>
            </li>
          );
        })}
        {conversations.length === 0 && (
          <li className="p-2 text-[11px] font-bold text-ink-soft">Chưa có cuộc trò chuyện nào.</li>
        )}
      </ul>
    </div>
  );
}
