/**
 * SplitDivider.tsx (SPEC-step24.md §4/§6.6): hidden (`w-0`, no pointer
 * handlers) outside split mode, double-click resets to 0.5 (animated), and
 * dragging (pointer down/move/up) updates `splitRatio` in real time using
 * its DOM siblings' bounding rects (not its own parent's — the rail sits
 * there too and must not count towards the ratio).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitDivider } from '../src/panels/SplitDivider.tsx';
import { useChatStore } from '../src/store/chat.ts';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useChatStore.setState({ splitRatio: 0.5, splitAnimating: false });
});

/** Renders the divider between two stand-in siblings sized like ChatPane/CanvasPane, with a mocked layout (jsdom never actually lays anything out). */
function renderWithSiblings() {
  const utils = render(
    <div>
      <div data-testid="prev-pane" />
      <SplitDivider />
      <div data-testid="next-pane" />
    </div>,
  );
  const prev = screen.getByTestId('prev-pane');
  const next = screen.getByTestId('next-pane');
  // chat+divider+canvas span: 0..1000px, prev (chat) occupies 0..500, next
  // (canvas) 500..1000 — mirrors an even split so drag math has a stable
  // baseline to compute deltas from.
  vi.spyOn(prev, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 500,
    width: 500,
    top: 0,
    bottom: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  });
  vi.spyOn(next, 'getBoundingClientRect').mockReturnValue({
    left: 500,
    right: 1000,
    width: 500,
    top: 0,
    bottom: 100,
    height: 100,
    x: 500,
    y: 0,
    toJSON() {
      return this;
    },
  });
  return utils;
}

describe('SplitDivider', () => {
  it('renders hidden (no pointer handlers, w-0) when the layout is chat-only or canvas-only', () => {
    useChatStore.setState({ splitRatio: 1 });
    render(<SplitDivider />);
    expect(screen.queryByTestId('split-divider')).not.toBeInTheDocument();
  });

  it('renders the active w-2 bar when the layout is split', () => {
    useChatStore.setState({ splitRatio: 0.5 });
    render(<SplitDivider />);
    expect(screen.getByTestId('split-divider')).toBeInTheDocument();
  });

  it('double-click resets to 0.5 with animate:true', () => {
    useChatStore.setState({ splitRatio: 0.3 });
    render(<SplitDivider />);
    fireEvent.doubleClick(screen.getByTestId('split-divider'));
    expect(useChatStore.getState().splitRatio).toBe(0.5);
    expect(useChatStore.getState().splitAnimating).toBe(true);
  });

  it('dragging (pointer down/move/up) updates splitRatio in real time, without animating', () => {
    renderWithSiblings();
    const divider = screen.getByTestId('split-divider');

    // setPointerCapture/releasePointerCapture aren't implemented in jsdom.
    Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn(), writable: true });
    Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn(), writable: true });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    // Drag to x=400 within a 0..1000 span -> ratio 0.4 (comfortably clear of
    // both min-widths at this container size — CHAT_MIN_WIDTH=320,
    // CANVAS_MIN_WIDTH=420 — so resolveSplitRatio's snap doesn't kick in).
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 400 });

    expect(useChatStore.getState().splitRatio).toBeCloseTo(0.4);
    expect(useChatStore.getState().splitAnimating).toBe(false);

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 400 });
  });

  it('pointermove before pointerdown is a no-op (not yet dragging)', () => {
    renderWithSiblings();
    const divider = screen.getByTestId('split-divider');
    Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn(), writable: true });

    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 900 });

    expect(useChatStore.getState().splitRatio).toBe(0.5);
  });

  it('pointermove after pointerup no longer updates the ratio', () => {
    renderWithSiblings();
    const divider = screen.getByTestId('split-divider');
    Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn(), writable: true });
    Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn(), writable: true });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 250 });
    const ratioAfterUp = useChatStore.getState().splitRatio;

    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 900 });
    expect(useChatStore.getState().splitRatio).toBe(ratioAfterUp);
  });

  // Regression for the "ghost drag" bug (SPEC-step24.md implementation
  // review): a drag that snaps the ratio to 0/1 *mid-drag* (past a
  // min-width threshold) flips `mode` away from 'split' before any
  // `pointerup` fires — this component never unmounts, so without resetting
  // `draggingRef` on that mode change, a later *hover* (no pointerdown) once
  // back in split mode would resume resizing both panes.
  it('a drag that snaps the layout out of split resets dragging state — no ghost-drag on return to split', () => {
    renderWithSiblings();
    const divider = screen.getByTestId('split-divider');
    Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn(), writable: true });
    Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn(), writable: true });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    // clientX=250 in the 0..1000 span -> ratio 0.25 -> chatPx=250 < CHAT_MIN_WIDTH (320)
    // -> resolveSplitRatio snaps to 0 -> mode leaves 'split' mid-drag.
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 250 });
    expect(useChatStore.getState().splitRatio).toBe(0);
    // The component collapsed to the handler-less w-0 div — same physical
    // DOM node (React reconciles in place), but the testid/handlers are gone.
    expect(screen.queryByTestId('split-divider')).not.toBeInTheDocument();

    // No pointerup ever reaches a JS handler (mirrors the real bug: the
    // collapsed div has none) — fired on the stale `divider` reference to
    // show that even a "late" pointerup landing on the old node doesn't
    // matter for the fix (the ref reset already happened synchronously via
    // `useLayoutEffect`, not via this pointerup).
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 250 });

    // User cycles back to split (ModeToggle / ⌘\). Wrapped in `act` so the
    // resulting React re-render (SplitDivider is subscribed to `splitRatio`)
    // flushes before the assertions below run.
    act(() => {
      useChatStore.setState({ splitRatio: 0.5 });
    });
    const dividerAfter = screen.getByTestId('split-divider');

    // A plain hover (pointermove with no new pointerdown) must be a no-op —
    // before the fix, the stale `draggingRef.current === true` made this
    // resume dragging without any click at all.
    fireEvent.pointerMove(dividerAfter, { pointerId: 1, clientX: 800 });
    expect(useChatStore.getState().splitRatio).toBe(0.5);
  });

  it('pointercancel resets dragging state (an interrupted touch drag does not leave a stuck ref)', () => {
    renderWithSiblings();
    const divider = screen.getByTestId('split-divider');
    Object.defineProperty(divider, 'setPointerCapture', { value: vi.fn(), writable: true });
    Object.defineProperty(divider, 'releasePointerCapture', { value: vi.fn(), writable: true });

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 400 });
    expect(useChatStore.getState().splitRatio).toBeCloseTo(0.4);

    fireEvent.pointerCancel(divider, { pointerId: 1 });

    // Further movement without a new pointerdown must not resize anything.
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 900 });
    expect(useChatStore.getState().splitRatio).toBeCloseTo(0.4);
  });
});
