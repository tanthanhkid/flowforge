/**
 * Run history for the current workflow (SPEC-step4.md §4): lists past runs
 * (status icon + time), click to `openRun` a past run's node states/outputs
 * back onto the canvas.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { RunSummary } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

const STATUS_ICON: Record<string, string> = {
  running: '⏳',
  success: '✅',
  error: '❌',
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
    <div className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Run history</h2>
        <button type="button" onClick={() => void refresh()} className="text-xs text-blue-600 hover:underline">
          Refresh
        </button>
      </div>

      {loading && runs.length === 0 && <p className="text-xs text-slate-400">Loading…</p>}
      {!loading && runs.length === 0 && <p className="text-xs text-slate-400">Chưa có run nào.</p>}

      <ul className="flex flex-col gap-1">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              data-testid="run-history-item"
              onClick={() => void openRun(run.id)}
              className={`flex w-full items-center justify-between rounded border px-2 py-1 text-left text-xs hover:bg-slate-50 ${
                run.id === runId ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
              }`}
            >
              <span>
                {STATUS_ICON[run.status] ?? '•'} {run.status}
              </span>
              <span className="text-slate-400">{formatTime(run.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
