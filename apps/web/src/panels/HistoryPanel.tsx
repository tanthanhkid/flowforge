/**
 * SPEC-step27.md §5 — the 4th right-panel tab ("Lịch sử"): the full,
 * un-compressed change log for the current workflow (`GET
 * /api/workflows/:id/changes`, SPEC-step22.md §5) — both AI-authored and
 * manual ("tay") rows, newest first (the server returns `id ASC`, reversed
 * here). Cosmetic (`move-node`) rows are hidden by default — a toggle
 * reveals them — same reasoning `changeDigest.ts` already applies
 * server-side when deciding what the AI needs to see.
 *
 * Refetches whenever `workflowVersion` changes (SPEC-step22.md §6's
 * optimistic-concurrency counter): that already bumps on every successful
 * manual-change queue entry (`manualLog.ts`), every AI turn's `message`
 * event, AND this panel's own `revertChange` call below — covering spec §5's
 * "load... sau mỗi change mới của chính client (queue thành công / onDone
 * turn AI)" without a dedicated nonce, since anything that actually persists
 * a change already bumps this counter.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { WorkflowChangeSummary } from '../api/types.ts';
import { useChatStore } from '../store/chat.ts';
import { useFlowStore } from '../store/flow.ts';
import { toast } from '../ui/Toast.tsx';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2 phút trước" style relative time (spec §5) — no existing helper in the codebase to reuse. */
function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < MINUTE_MS) return 'vừa xong';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} phút trước`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} giờ trước`;
  return `${Math.floor(diff / DAY_MS)} ngày trước`;
}

export function HistoryPanel() {
  const workflowId = useFlowStore((s) => s.workflow.id);
  const workflowVersion = useChatStore((s) => s.workflowVersion);
  const turnState = useChatStore((s) => s.turnState);
  const adoptWorkflow = useFlowStore((s) => s.adoptWorkflow);

  const [changes, setChanges] = useState<WorkflowChangeSummary[]>([]);
  const [includeCosmetic, setIncludeCosmetic] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revertingId, setRevertingId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listChanges(workflowId, { includeCosmetic })
      .then((res) => {
        if (!cancelled) setChanges(res);
      })
      .catch(() => {
        // Silent fail (mirrors RunsPanel/ResultsPanel's own fetch effects) —
        // the panel just keeps showing whatever it last had (or the empty
        // state on first load).
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion, includeCosmetic]);

  const isStreaming = turnState === 'streaming';

  async function handleRevert(changeId: number): Promise<void> {
    if (isStreaming) return;
    if (!window.confirm('Khôi phục về trạng thái TRƯỚC thay đổi này?')) return;
    setRevertingId(changeId);
    try {
      const res = await api.revertChange(workflowId, changeId);
      adoptWorkflow(res.workflow);
      useChatStore.setState({ workflowVersion: res.version });
      toast('Đã khôi phục');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không khôi phục được', 'error');
    } finally {
      setRevertingId(null);
    }
  }

  // Server returns `id ASC` (oldest first) — spec §5 wants newest on top.
  const ordered = [...changes].reverse();

  return (
    <div data-testid="history-panel" className="flex flex-col gap-3 p-3 text-sm text-ink">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-xs uppercase tracking-wide text-ink">Lịch sử thay đổi</h2>
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-bold text-ink-soft">
          <input
            type="checkbox"
            data-testid="history-cosmetic-toggle"
            checked={includeCosmetic}
            onChange={(event) => setIncludeCosmetic(event.target.checked)}
          />
          hiện thay đổi vị trí
        </label>
      </div>

      {loading && ordered.length === 0 && <p className="text-xs text-ink-soft">Đang tải…</p>}
      {!loading && ordered.length === 0 && (
        <p className="text-xs text-ink-soft">Chưa có thay đổi nào được ghi.</p>
      )}

      <ul className="flex flex-col gap-2">
        {ordered.map((change) => (
          <li
            key={change.id}
            data-testid="history-item"
            className="flex flex-col gap-1.5 border-2 border-ink bg-paper px-3 py-2 shadow-hard-2 [border-bottom-style:dashed]"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-ink">
                <span aria-hidden>{change.source === 'ai' ? '🤖' : '✋'}</span>
                <span>{change.summary}</span>
                {change.scope === 'cosmetic' && (
                  <span className="border border-ink bg-bg px-1 font-mono-data text-[10px] font-bold uppercase text-ink-soft">
                    vị trí
                  </span>
                )}
              </span>
              <span className="shrink-0 font-mono-data text-[11px] text-ink-soft">
                {formatRelativeTime(change.createdAt)}
              </span>
            </div>
            {change.scope === 'structural' && (
              <button
                type="button"
                data-testid="history-revert"
                disabled={isStreaming || revertingId === change.id}
                title={isStreaming ? 'AI đang xử lý' : undefined}
                onClick={() => void handleRevert(change.id)}
                className="w-fit border-2 border-ink bg-bg px-2 py-1 text-[11px] font-bold text-ink shadow-hard-2 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                ↺ Khôi phục
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
