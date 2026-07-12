/**
 * SplitDivider (SPEC-step24.md §4): the draggable bar between ChatPane and
 * CanvasPane. Only rendered "active" (visible, `w-2`) while the layout is
 * genuinely `split` — in chat-only/canvas-only mode there's nothing to drag
 * (use ModeToggle or ⌘\ to get back into split), so it collapses to `w-0`
 * instead of disappearing outright (an actual `{mode === 'split' && <..>}`
 * conditional would work equally well here, but rendering unconditionally
 * keeps this component's own mount lifecycle — and therefore its pointer
 * handlers — stable across mode changes).
 *
 * Drag math reads `previousElementSibling`/`nextElementSibling`'s own
 * `getBoundingClientRect()` (ChatPane and CanvasPane respectively, per
 * `App.tsx`'s fixed DOM order) rather than this divider's own parent's rect
 * — the immediate parent row also contains `ConversationRail`, a fixed-width
 * column that must NOT count towards the chat/canvas split's 0..1 ratio.
 */
import { useLayoutEffect, useRef } from 'react';
import { layoutModeFromRatio, useChatStore } from '../store/chat.ts';

export function SplitDivider() {
  const splitRatio = useChatStore((s) => s.splitRatio);
  const setSplitRatio = useChatStore((s) => s.setSplitRatio);
  const mode = layoutModeFromRatio(splitRatio);
  const draggingRef = useRef(false);

  // Fixes SPEC-step24.md's "ghost drag" regression: a drag that pushes
  // `splitRatio` past a min-width threshold makes `resolveSplitRatio` (in
  // `setSplitRatio`) snap the ratio to 0/1 *mid-drag*, which flips `mode`
  // away from 'split' — the branch below then swaps this component's own
  // render to the handler-less `w-0` div (no `onPointerUp`), so the pointerup
  // that follows never reaches a handler and `draggingRef.current` is left
  // stuck `true`. Because this component never unmounts (see the class
  // comment above), that stale ref survives until the user cycles back to
  // 'split' — at which point a mere pointer hover (no pointerdown) resumes
  // dragging both panes. Resetting the ref here, keyed on `mode` leaving
  // 'split', closes that window regardless of *why* it left split (a drag
  // snap, or an unrelated ModeToggle click while a stray pointerdown was
  // mid-flight) — `useLayoutEffect` (not `useEffect`) so it runs synchronously
  // in the same commit as the collapse, before the browser can dispatch
  // another pointer event to this element.
  useLayoutEffect(() => {
    if (mode !== 'split') {
      draggingRef.current = false;
    }
  }, [mode]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    const divider = event.currentTarget;
    const prev = divider.previousElementSibling as HTMLElement | null;
    const next = divider.nextElementSibling as HTMLElement | null;
    if (!prev || !next) return;
    const left = prev.getBoundingClientRect().left;
    const right = next.getBoundingClientRect().right;
    const width = right - left;
    if (width <= 0) return;
    const ratio = (event.clientX - left) / width;
    // A live drag never animates — it must track the pointer with zero
    // transition lag; the min-width snap (`resolveSplitRatio` inside
    // `setSplitRatio`) still applies via `containerWidth`.
    setSplitRatio(ratio, { containerWidth: width });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  // Defensive, alongside the `useLayoutEffect` above (not a substitute for
  // it): a `pointercancel` (OS interrupts an in-progress touch drag) or a
  // native loss of pointer capture with no matching `pointerup` would
  // otherwise leave `draggingRef.current` stuck `true` the same way the
  // mid-drag mode-collapse does.
  function handlePointerCancel(): void {
    draggingRef.current = false;
  }

  function handleDoubleClick(): void {
    setSplitRatio(0.5, { animate: true });
  }

  if (mode !== 'split') {
    return <div aria-hidden="true" className="w-0 shrink-0" />;
  }

  return (
    <div
      data-testid="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Kéo để chỉnh tỉ lệ chat / canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
      className="w-2 shrink-0 cursor-col-resize touch-none bg-ink hover:bg-accent"
    />
  );
}
