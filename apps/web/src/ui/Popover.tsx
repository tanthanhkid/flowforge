/**
 * SPEC-step18.md §3 — shared dropdown/popover panel, replacing the 4
 * hand-rolled `absolute … border … shadow-lg` divs (Validate issues, cost
 * estimate, ✨ Describe, node ✨ edit).
 *
 * Fix (post-review, critical): the original version rendered `position:
 * absolute` as a plain in-flow descendant of its trigger's `relative`
 * wrapper. Toolbar.tsx's header needs `overflow-x-auto` (spec §5.1, "khi
 * hẹp") — but per the CSS overflow spec, an element with `overflow-x` set
 * to anything other than `visible` forces its computed `overflow-y` to
 * `auto` too (the two axes can't be `auto`+`visible` on the same box). That
 * silently turned the header into a 56px-tall *vertical* scroll container
 * as a side effect, which clips every descendant past its box — including
 * all three toolbar popovers (Validate issues, 💰 estimate, ✨ Describe),
 * making them completely invisible to a real user (confirmed live: the
 * popover DOM renders, but outside the header's clipped box, and
 * `elementFromPoint` at its center returns something else entirely).
 *
 * Fix: portal the popover panel straight to `document.body` and position it
 * with `position: fixed`, computed from the trigger's own
 * `getBoundingClientRect()` (passed in as `anchorRef`) — this escapes *any*
 * ancestor's overflow/scroll clipping entirely, not just this one header's.
 * React's synthetic event system still bubbles portal content up through
 * the *React* tree (not the DOM tree), so an ancestor's `onClick`
 * (`stopPropagation`, etc.) keeps working exactly as before.
 */
import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface PopoverProps {
  children: ReactNode;
  className?: string;
  /** The trigger element the popover is anchored under (its bottom-left/right corner, in viewport coordinates). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Horizontal anchor edge against the trigger. Defaults to `left`. */
  align?: 'left' | 'right';
}

interface AnchorRect {
  top: number;
  left: number;
  right: number;
}

export function Popover({ children, className = '', anchorRef, align = 'left' }: PopoverProps) {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  // Re-measure synchronously before paint (avoids a visible jump from 0,0)
  // and again on resize/scroll anywhere in the document — the anchor can sit
  // inside a scrollable ancestor (e.g. the toolbar's own overflow-x-auto).
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom, left: r.left, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  if (!rect) return null;

  return createPortal(
    <div
      className={`fixed z-20 mt-1.5 border-2 border-ink bg-paper shadow-hard-5 ${className}`}
      style={align === 'right' ? { top: rect.top, right: rect.right } : { top: rect.top, left: rect.left }}
    >
      {children}
    </div>,
    document.body,
  );
}
