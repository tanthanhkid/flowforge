/**
 * Run history for the current workflow (SPEC-step4.md §4): lists past runs
 * (status icon + time), click to `openRun` a past run's node states/outputs
 * back onto the canvas.
 *
 * SPEC-step18.md §5.5 — each run renders as a "torn ticket": solid 2px black
 * border on 3 sides + a dashed bottom edge (the "tear"), a status dot in the
 * matching token color (statusColors.ts), a mono timestamp, and a pink
 * (cat-video) border when it's the run currently open.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { RunStatus, RunSummary } from '../api/types.ts';
import { STATUS_COLORS } from '../canvas/statusColors.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';

const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  success: '✅',
  error: '❌',
};

const STATUS_DOT_COLOR: Record<RunStatus, string> = {
  running: STATUS_COLORS.running,
  success: STATUS_COLORS.success,
  error: STATUS_COLORS.error,
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function RunsPanel() {
  const workflowId = useFlowStore((s) => s.workflow.id);
  const runId = useFlowStore((s) => s.runId);
  const runStatus = useFlowStore((s) => s.runStatus);
  const openRun = useFlowStore((s) => s.openRun);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const list = await api.listRuns({ workflowId });
      setRuns(list);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workflowId]);

  // A run just finished (or a new one started) — refresh the history list.
  useEffect(() => {
    if (runStatus === 'success' || runStatus === 'error') {
      void refresh();
    }
  }, [runStatus, runId]);

  return (
    <div className="flex flex-col gap-3 p-3 text-sm text-ink">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xs uppercase tracking-wide text-ink">Run history</h2>
        <Button type="button" variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      {loading && runs.length === 0 && <p className="text-xs text-ink-soft">Loading…</p>}
      {!loading && runs.length === 0 && <p className="text-xs text-ink-soft">Chưa có run nào.</p>}

      <ul className="flex flex-col gap-2">
        {runs.map((run) => {
          const active = run.id === runId;
          return (
            <li key={run.id}>
              <button
                type="button"
                data-testid="run-history-item"
                onClick={() => void openRun(run.id)}
                className={`flex w-full items-center justify-between gap-2 border-2 bg-paper px-3 py-2 text-left transition-colors [border-bottom-style:dashed] hover:bg-bg ${
                  active ? 'border-cat-video shadow-hard-3' : 'border-ink shadow-hard-2'
                }`}
              >
                <span className="flex items-center gap-2 text-xs font-bold text-ink">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 border-ink"
                    style={{ backgroundColor: STATUS_DOT_COLOR[run.status] }}
                  />
                  {STATUS_ICON[run.status] ?? '•'} {run.status}
                </span>
                <span className="font-mono-data text-[11px] text-ink-soft">{formatTime(run.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
