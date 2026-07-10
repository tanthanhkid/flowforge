/**
 * Workflow list overlay (SPEC-step4.md §4): open/create/delete workflows.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { WorkflowSummary } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

export interface WorkflowListProps {
  onClose: () => void;
}

export function WorkflowList({ onClose }: WorkflowListProps) {
  const currentId = useFlowStore((s) => s.workflow.id);
  const loadWorkflow = useFlowStore((s) => s.loadWorkflow);
  const newWorkflow = useFlowStore((s) => s.newWorkflow);

  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listWorkflows());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleOpen(id: string): Promise<void> {
    await loadWorkflow(id);
    onClose();
  }

  function handleNew(): void {
    newWorkflow();
    onClose();
  }

  async function handleDelete(id: string): Promise<void> {
    await api.deleteWorkflow(id);
    await refresh();
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="max-h-[70vh] w-96 overflow-y-auto rounded bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Workflows</h2>
          <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <button
          type="button"
          onClick={handleNew}
          className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
        >
          + New workflow
        </button>

        {loading && <p className="text-xs text-slate-400">Loading…</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}

        <ul className="flex flex-col gap-1">
          {items.map((wf) => (
            <li
              key={wf.id}
              className={`flex items-center justify-between rounded border px-2 py-1 text-xs ${
                wf.id === currentId ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
              }`}
            >
              <button type="button" onClick={() => void handleOpen(wf.id)} className="flex-1 truncate text-left">
                {wf.name || '(untitled)'}
              </button>
              <button type="button" onClick={() => void handleDelete(wf.id)} className="ml-2 text-red-500 hover:underline">
                Delete
              </button>
            </li>
          ))}
          {!loading && items.length === 0 && <li className="text-xs text-slate-400">Chưa có workflow nào.</li>}
        </ul>
      </div>
    </div>
  );
}
