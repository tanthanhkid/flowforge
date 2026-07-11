/**
 * Workflow list overlay (SPEC-step4.md §4): open/create/delete workflows.
 * Neo-brutalist pass (SPEC-step18.md §5.6, fix #8): shares `ui/Modal.tsx`
 * for the shell, adds a name filter (`data-testid="workflow-search"`), and
 * shrinks Delete down to a small square ✕ that only turns red on hover —
 * so it reads as a secondary, deliberate action rather than sitting flush
 * next to the primary "open" click target.
 */
import { useEffect, useMemo, useState } from 'react';
import * as api from '../api/client.ts';
import type { WorkflowSummary } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { Modal } from '../ui/Modal.tsx';

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
  const [query, setQuery] = useState('');

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((wf) => (wf.name || '').toLowerCase().includes(q));
  }, [items, query]);

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
    <Modal title="📁 Workflows" onClose={onClose} className="w-[420px] max-w-[92vw]" data-testid="workflow-list-modal">
      <div className="flex flex-col gap-3">
        <Button variant="primary" onClick={handleNew} className="w-full justify-center">
          + New workflow
        </Button>

        <input
          type="text"
          data-testid="workflow-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="🔍 Tìm workflow theo tên…"
          className="border-2 border-ink bg-bg px-2 py-1.5 text-[11px] font-bold text-ink placeholder:text-ink-soft focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
        />

        {loading && <p className="text-[11px] font-bold text-ink-soft">Loading…</p>}
        {error && <p className="text-[11px] font-bold text-status-error">{error}</p>}

        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {filtered.map((wf) => (
            <li
              key={wf.id}
              className={`flex items-center gap-2 border-2 border-ink px-2 py-1.5 shadow-hard-2 transition-transform duration-100 motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 hover:shadow-hard-3 ${
                wf.id === currentId ? 'bg-accent' : 'bg-paper'
              }`}
            >
              <button
                type="button"
                onClick={() => void handleOpen(wf.id)}
                className="flex-1 truncate text-left text-xs font-bold text-ink"
              >
                {wf.name || '(untitled)'}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(wf.id)}
                aria-label={`Xoá ${wf.name || '(untitled)'}`}
                data-testid="workflow-delete-btn"
                className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink bg-paper text-[11px] font-bold text-ink hover:bg-status-error hover:text-paper"
              >
                ✕
              </button>
            </li>
          ))}
          {!loading && filtered.length === 0 && items.length > 0 && (
            <li className="text-[11px] font-bold text-ink-soft">Không tìm thấy workflow nào khớp.</li>
          )}
          {!loading && items.length === 0 && (
            <li className="text-[11px] font-bold text-ink-soft">Chưa có workflow nào.</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
