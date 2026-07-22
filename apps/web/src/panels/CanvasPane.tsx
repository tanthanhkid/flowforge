/**
 * CanvasPane (SPEC-step24.md §4): `<Sidebar/> + <main FlowCanvas/> + <aside
 * 3-tab Params/Runs/Kết quả>`, lifted wholesale out of `App.tsx`'s pre-
 * step24 layout — internals unchanged (SPEC-step18.md §5.5's "bìa hồ sơ"
 * tab styling included).
 *
 * The one new thing this file owns: visibility. This pane is ALWAYS
 * mounted, even at `splitRatio = 1.0` (chat-only) — never conditionally
 * rendered — so React Flow's instance/viewport survives a mode switch
 * instead of remounting (which would replay its initial fit/measurement
 * from scratch every time). `visibility: hidden` (not `display: none`) is
 * how it hides: a `display: none` ancestor reports zero size to React
 * Flow's ResizeObserver-based node measurement, permanently wrong-footing
 * it once the pane reappears — `visibility: hidden` keeps layout flow (and
 * the ResizeObserver) alive while simply not painting anything. Actual
 * width collapse to ~0px happens via `flex-grow` (see `App.tsx`), not here.
 *
 * When the pane flips from hidden back to visible (chat-only -> split or
 * canvas-only), `requestFitView()` re-centers the canvas — the same "🪄 Sắp
 * xếp" action already uses (SPEC-step18.md §4/§7.3) — since React Flow's own
 * one-shot `fitView` prop only ever fires once, at mount, and here that
 * first mount can happen while this pane is still 0px wide (chat-only is
 * the landing default), which leaves React Flow's internal viewport fit
 * against a degenerate container. Fired TWICE: once immediately (covers
 * `prefers-reduced-motion`, where the width class below never actually
 * transitions — the flex-grow change is instant) and once again after
 * `SPLIT_ANIMATE_MS` (covers the normal animated case, where the pane is
 * still mid-transition at 0-ish width the instant it flips `visible`, so an
 * immediate-only refit would fit against that same wrong, still-shrunk
 * size). Refitting an already-correctly-fit view is harmless, so calling it
 * twice is simpler and more robust than trying to line this up exactly with
 * a CSS `transitionend` event.
 */
import { useEffect, useRef } from 'react';
import { FlowCanvas } from '../canvas/FlowCanvas.tsx';
import { Sidebar } from '../canvas/Sidebar.tsx';
import { layoutModeFromRatio, SPLIT_ANIMATE_MS, useChatStore } from '../store/chat.ts';
import { useFlowStore } from '../store/flow.ts';
import { CutPlanReview } from './CutPlanReview.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { ParamsPanel } from './ParamsPanel.tsx';
import { ResultsPanel } from './ResultsPanel.tsx';
import { RunsPanel } from './RunsPanel.tsx';

/** "Bìa hồ sơ" tab classes (SPEC-step18.md §5.5) — fused-border trick: active tab's bottom border is recolored to match, not removed, so height doesn't shift under border-box sizing. */
function rightTabClass(active: boolean): string {
  const base =
    'flex-1 border-r-2 border-b-[3px] border-ink px-2 py-2.5 text-center font-display text-[11px] uppercase tracking-wide text-ink transition-colors last:border-r-0';
  return active ? `${base} bg-accent border-b-accent` : `${base} bg-bg hover:bg-paper`;
}

export function CanvasPane() {
  const splitRatio = useChatStore((s) => s.splitRatio);
  // Only during an *animated* setSplitRatio call (ModeToggle click,
  // SplitDivider double-click, the auto-behaviors in store/chat.ts) — a
  // live drag must track the pointer with zero transition lag, so the CSS
  // transition class below is applied conditionally, not unconditionally.
  const splitAnimating = useChatStore((s) => s.splitAnimating);
  const visible = layoutModeFromRatio(splitRatio) !== 'chat';
  const rightTab = useFlowStore((s) => s.rightTab);
  const setRightTab = useFlowStore((s) => s.setRightTab);
  const requestFitView = useFlowStore((s) => s.requestFitView);

  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (!wasVisibleRef.current && visible) {
      requestFitView();
      const timer = setTimeout(requestFitView, SPLIT_ANIMATE_MS + 50);
      wasVisibleRef.current = visible;
      return () => clearTimeout(timer);
    }
    wasVisibleRef.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, requestFitView]);

  return (
    <section
      data-testid="canvas-pane"
      className={`flex min-w-0 flex-1 overflow-hidden ${
        splitAnimating ? 'motion-safe:transition-[flex-grow] motion-safe:duration-300 motion-safe:ease-out' : ''
      }`}
      style={{ flexGrow: 1 - splitRatio, flexBasis: 0, visibility: visible ? 'visible' : 'hidden' }}
    >
      <Sidebar />

      {/* SPEC-step33.md §33e-1 — `relative` so `<CutPlanReview>` (an
          `absolute inset-4` overlay, only rendered while a run is parked at
          an `'awaiting'` gate) positions itself against this pane rather
          than the page. */}
      <main className="relative min-w-0 flex-1">
        <FlowCanvas />
        <CutPlanReview />
      </main>

      <aside data-testid="right-panel" className="flex w-80 shrink-0 flex-col border-l-[3px] border-ink bg-paper">
        <div className="flex shrink-0">
          <button type="button" onClick={() => setRightTab('params')} className={rightTabClass(rightTab === 'params')}>
            Params
          </button>
          <button
            type="button"
            data-testid="runs-tab"
            onClick={() => setRightTab('runs')}
            className={rightTabClass(rightTab === 'runs')}
          >
            Runs
          </button>
          <button
            type="button"
            data-testid="results-tab"
            onClick={() => setRightTab('results')}
            className={rightTabClass(rightTab === 'results')}
          >
            Kết quả
          </button>
          <button
            type="button"
            data-testid="history-tab"
            onClick={() => setRightTab('history')}
            className={rightTabClass(rightTab === 'history')}
          >
            Lịch sử
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rightTab === 'params' && <ParamsPanel />}
          {rightTab === 'runs' && <RunsPanel />}
          {rightTab === 'results' && <ResultsPanel />}
          {rightTab === 'history' && <HistoryPanel />}
        </div>
      </aside>
    </section>
  );
}
