/**
 * SPEC-step18.md §3 — shared modal shell (WorkflowList, SettingsPage,
 * JsonView migrate to this in a later phase). Backdrop is flat
 * `bg-black/60` with no blur (spec: "KHÔNG blur"); panel is a hard-edged
 * white card with a full-width colored header strip (`headerColor` prop,
 * default accent yellow) carrying an uppercase display-font title and a
 * square close button that inverts colors on hover.
 *
 * Deliberately minimal props — title/onClose/headerColor/children is the
 * whole surface area; layout sizing (`max-w-*` etc.) is left to the
 * caller via `className` on the panel.
 */
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose: () => void;
  /** Header strip background — CSS color string. Defaults to `var(--color-accent)`. */
  headerColor?: string;
  children: ReactNode;
  /** Extra classes for the panel element (e.g. width/height constraints). */
  className?: string;
  /** Forwarded to the backdrop element, for tests that need to locate the modal. */
  'data-testid'?: string;
}

export function Modal({ title, onClose, headerColor, children, className = '', ...rest }: ModalProps) {
  const testId = rest['data-testid'];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Post-review fix (major): closing on a plain `onClick={onClose}` on the
  // backdrop breaks the moment a user drag-selects text *inside* the panel
  // (e.g. JsonView's textarea) and releases the mouse outside it, over the
  // backdrop. Per the UI Events spec, when mousedown and mouseup land on
  // different elements, the browser's synthesized `click` targets their
  // *nearest common ancestor* — here, the backdrop itself (an ancestor of
  // everything) — bypassing the panel's own `stopPropagation()` entirely
  // (the click never targets the panel, so that handler never runs) and
  // silently closing the modal mid-selection, discarding an unsaved draft.
  // A plain `event.target === event.currentTarget` check on `click` alone
  // does NOT catch this: in exactly this scenario `target` genuinely *is*
  // the backdrop. The fix requires remembering where `mousedown` started
  // too, and only closing when BOTH mousedown and click targeted the
  // backdrop directly (a real, non-dragging click on the backdrop).
  const mouseDownOnBackdrop = useRef(false);

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>): void {
    mouseDownOnBackdrop.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    if (mouseDownOnBackdrop.current && event.target === event.currentTarget) {
      onClose();
    }
    mouseDownOnBackdrop.current = false;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      data-testid={testId}
    >
      <div
        className={`flex max-h-[90vh] w-full max-w-lg flex-col border-4 border-ink bg-paper shadow-hard-8 ${className}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b-4 border-ink px-4 py-2"
          style={{ backgroundColor: headerColor ?? 'var(--color-accent)' }}
        >
          <h2 className="truncate font-display text-sm uppercase tracking-wide text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink bg-paper text-xs font-bold text-ink hover:bg-ink hover:text-accent"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
