/**
 * CutPlanReview (SPEC-step33.md §33e-1) — the human-in-the-loop review gate
 * for the "video → short" pipeline: `video.selectMoments` proposes a
 * `CutPlan` (a list of `CutMoment`), the engine parks the run in the
 * `'awaiting'` state (server 33c) instead of continuing on to
 * `broll.generate`/`video.assembleShort`, and this panel lets the user
 * edit/delete moments before approving (`resumeAwaiting`, which re-sends
 * the (possibly edited) plan as the node's resolved output) or aborting the
 * whole run (`cancelAwaiting`).
 *
 * Mounted as an overlay on top of `<FlowCanvas>` inside `CanvasPane`'s
 * `<main>` (rather than as a 5th right-panel tab): a pending gate blocks
 * the *run*, not just one panel's view, so it should be impossible to miss
 * regardless of which right-panel tab happens to be selected — and unlike
 * the right panel, it stays visible even while the user is looking at
 * Params/Runs/Kết quả/Lịch sử for a *different* node. Rendered only when
 * `awaitingGate` is set; `null` otherwise (so mounting it unconditionally
 * in the parent is cheap and simple).
 *
 * Local edit state (`moments`) is seeded from `awaitingGate.plan.moments`
 * and only re-seeded when the gate's `(runId, nodeId)` identity changes —
 * NOT on every store update — so editing a field doesn't get clobbered by
 * an unrelated `nodeRuns` update elsewhere in the same run.
 *
 * Post-review fix (LOW) — `start`/`end` are edited as raw strings
 * (`EditableMoment`), not numbers: a controlled number input that snaps
 * back to its old value the instant the field is cleared (the previous
 * `parseNumberInput`-falls-back-to-old-value approach) makes retyping a
 * value impossible to do by clearing-then-typing. Coercion to `number`
 * happens only where it's actually needed — the end<=start validation
 * below and the plan handed to `resumeAwaiting`.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import type { CutMoment } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';

type EditableMoment = Omit<CutMoment, 'start' | 'end'> & { start: string; end: string };

function toEditable(moments: CutMoment[]): EditableMoment[] {
  return moments.map((m) => ({ ...m, start: String(m.start), end: String(m.end) }));
}

/** `NaN` for blank/unparseable input — deliberately NOT falling back to the previous value (post-review fix, see file doc-comment). */
function toNumber(raw: string): number {
  return raw.trim().length === 0 ? Number.NaN : Number(raw);
}

/** A moment is submittable only once both bounds parse to finite numbers and `end > start` (mirrors the server's `CutMomentSchema` refine — SPEC-step33.md §2). */
function momentIsValid(m: EditableMoment): boolean {
  const start = toNumber(m.start);
  const end = toNumber(m.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Post-review fix (MEDIUM/LOW) — Duyệt & cắt is blocked client-side (matching the server's own `CutPlanSchema`/`CutMomentSchema` validation) rather than round-tripping an invalid plan just to show the server's 400 back. */
function planInvalidReason(moments: EditableMoment[]): string | null {
  if (moments.length === 0) return 'Cần ít nhất một đoạn để tiếp tục.';
  const bad = moments.find((m) => !momentIsValid(m));
  if (bad) return `Đoạn "${bad.title || bad.id}": thời điểm kết thúc phải lớn hơn thời điểm bắt đầu.`;
  return null;
}

function errorMessage(err: unknown): string {
  // Post-review fix (LOW/MED) — a 400 from `resumeRun` carries the
  // server's per-issue `CutMomentSchema`/`CutPlanSchema` zod issues (e.g.
  // "CutMoment: 'end' phải lớn hơn 'start'.") in `.issues`; showing those
  // specific messages beats the generic top-level "output không hợp lệ
  // (không đúng CutPlan)" string.
  if (err instanceof ApiError) {
    if (err.issues && err.issues.length > 0) {
      return err.issues.map((issue) => issue.message).join(' ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Đã có lỗi xảy ra';
}

export function CutPlanReview() {
  const awaitingGate = useFlowStore((s) => s.awaitingGate);
  const resumeAwaiting = useFlowStore((s) => s.resumeAwaiting);
  const cancelAwaiting = useFlowStore((s) => s.cancelAwaiting);

  const [moments, setMoments] = useState<EditableMoment[]>(toEditable(awaitingGate?.plan.moments ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on identity only, see doc-comment above.
  useEffect(() => {
    setMoments(toEditable(awaitingGate?.plan.moments ?? []));
    setError(null);
  }, [awaitingGate?.runId, awaitingGate?.nodeId]);

  if (!awaitingGate) return null;

  function updateMoment(id: string, patch: Partial<EditableMoment>): void {
    setMoments((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function deleteMoment(id: string): void {
    setMoments((prev) => prev.filter((m) => m.id !== id));
  }

  const invalidReason = planInvalidReason(moments);

  async function handleApprove(): Promise<void> {
    if (invalidReason) {
      setError(invalidReason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const plan: { moments: CutMoment[] } = {
        moments: moments.map((m) => ({ ...m, start: toNumber(m.start), end: toNumber(m.end) })),
      };
      await resumeAwaiting(plan);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await cancelAwaiting();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="cutplan-review"
      className="absolute inset-4 z-10 flex flex-col overflow-hidden border-2 border-ink bg-paper shadow-hard-5"
    >
      <header className="shrink-0 border-b-2 border-ink bg-accent px-3 py-2">
        <h2 className="font-display text-sm uppercase tracking-wide text-ink">⏸ Chờ duyệt kế hoạch cắt</h2>
        <p className="mt-0.5 text-xs text-ink-soft">
          Xem/sửa các đoạn được chọn trước khi tiếp tục chạy (tạo b-roll + ghép video ngắn).
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {moments.length === 0 && <p className="text-xs text-ink-soft">Không còn đoạn nào — mọi đoạn đã bị xoá.</p>}
        <ul className="flex flex-col gap-2">
          {moments.map((m) => {
            const invalid = !momentIsValid(m);
            return (
              <li
                key={m.id}
                data-testid={`cutplan-moment-${m.id}`}
                className={`flex flex-col gap-1.5 border-2 bg-bg p-2 ${invalid ? 'border-status-error' : 'border-ink'}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    data-testid={`cutplan-title-${m.id}`}
                    value={m.title}
                    onChange={(e) => updateMoment(m.id, { title: e.target.value })}
                    className="min-w-0 flex-1 border-2 border-ink bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:border-cat-video"
                    aria-label={`Tiêu đề đoạn ${m.id}`}
                  />
                  <button
                    type="button"
                    data-testid={`cutplan-delete-${m.id}`}
                    onClick={() => deleteMoment(m.id)}
                    title="Xoá đoạn này"
                    aria-label={`Xoá đoạn ${m.id}`}
                    className="shrink-0 border-2 border-ink bg-paper px-2 py-1 text-xs font-bold text-status-error hover:bg-status-error hover:text-paper"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex gap-2">
                  <label className="flex flex-1 flex-col gap-0.5 text-[10px] font-bold uppercase text-ink-soft">
                    Bắt đầu (giây)
                    <input
                      type="number"
                      data-testid={`cutplan-start-${m.id}`}
                      value={m.start}
                      onChange={(e) => updateMoment(m.id, { start: e.target.value })}
                      className="border-2 border-ink bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:border-cat-video"
                    />
                  </label>
                  <label className="flex flex-1 flex-col gap-0.5 text-[10px] font-bold uppercase text-ink-soft">
                    Kết thúc (giây)
                    <input
                      type="number"
                      data-testid={`cutplan-end-${m.id}`}
                      value={m.end}
                      onChange={(e) => updateMoment(m.id, { end: e.target.value })}
                      className="border-2 border-ink bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:border-cat-video"
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-0.5 text-[10px] font-bold uppercase text-ink-soft">
                  B-roll prompt (bỏ trống = không chèn b-roll)
                  <input
                    data-testid={`cutplan-broll-${m.id}`}
                    value={m.brollPrompt ?? ''}
                    onChange={(e) => updateMoment(m.id, { brollPrompt: e.target.value === '' ? undefined : e.target.value })}
                    className="border-2 border-ink bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:border-cat-video"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      {error && <p className="shrink-0 border-t-2 border-ink bg-paper px-3 py-2 text-xs text-status-error">{error}</p>}

      <footer className="flex shrink-0 justify-end gap-2 border-t-2 border-ink bg-bg px-3 py-2">
        <Button type="button" variant="danger" data-testid="cutplan-cancel" onClick={() => void handleCancel()} disabled={busy}>
          Huỷ
        </Button>
        <Button
          type="button"
          variant="primary"
          data-testid="cutplan-approve"
          onClick={() => void handleApprove()}
          disabled={busy || invalidReason !== null}
          title={invalidReason ?? undefined}
        >
          Duyệt &amp; cắt
        </Button>
      </footer>
    </div>
  );
}
