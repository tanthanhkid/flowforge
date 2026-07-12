/**
 * ModeToggle (SPEC-step24.md §3): a 3-button segmented control living in the
 * Toolbar, always visible — the explicit, discoverable alternative to
 * dragging `SplitDivider` (§4) or the ⌘\ / ⌘⇧\ shortcut (`App.tsx`). Each
 * button sets `splitRatio` straight to its canonical value (1.0 / 0.5 / 0.0)
 * with `{ animate: true }`, exactly like `SplitDivider`'s own double-click
 * does — Toggle and divider are two entry points into the same one piece of
 * state, never fighting each other.
 */
import { layoutModeFromRatio, useChatStore, type LayoutMode } from '../store/chat.ts';

const MODES: ReadonlyArray<{ key: LayoutMode; label: string; ratio: number; testId: string }> = [
  { key: 'chat', label: 'Chat', ratio: 1, testId: 'mode-chat' },
  { key: 'split', label: 'Chia đôi', ratio: 0.5, testId: 'mode-split' },
  { key: 'canvas', label: 'Canvas', ratio: 0, testId: 'mode-canvas' },
];

export function ModeToggle() {
  const splitRatio = useChatStore((s) => s.splitRatio);
  const turnState = useChatStore((s) => s.turnState);
  const setSplitRatio = useChatStore((s) => s.setSplitRatio);
  const mode = layoutModeFromRatio(splitRatio);

  // SPEC-step24.md §3 — a turn keeps running server-side even while the
  // chat pane is fully hidden (canvas-only); without some signal here the
  // user would have no way to know a reply is on its way until they
  // happen to reopen chat themselves.
  const showStreamingBadge = turnState === 'streaming' && mode === 'canvas';

  return (
    <div
      role="group"
      aria-label="Chế độ hiển thị"
      className="flex shrink-0 border-2 border-ink shadow-hard-2"
    >
      {MODES.map(({ key, label, ratio, testId }, i) => {
        const active = mode === key;
        return (
          <button
            key={key}
            type="button"
            data-testid={testId}
            aria-pressed={active}
            onClick={() => setSplitRatio(ratio, { animate: true })}
            className={`relative px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide text-ink transition-colors ${
              active ? 'bg-accent' : 'bg-paper hover:bg-bg'
            } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
          >
            {label}
            {key === 'chat' && showStreamingBadge && (
              <span
                aria-hidden="true"
                data-testid="mode-chat-badge"
                className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-ink bg-status-error"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
