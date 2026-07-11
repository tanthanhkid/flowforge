/**
 * JSON view panel (SPEC-step6.md §2): raw-JSON editor for the current
 * workflow, opened as a wide overlay from the Toolbar's "{} JSON" button.
 *
 * The textarea holds a local "draft" string that stays in sync with the
 * store's `workflow` (re-serialized on every change) UNTIL the user starts
 * typing — from then on the draft is considered user-owned and won't be
 * clobbered by external workflow changes (e.g. a node drag on the canvas
 * behind this overlay) until Apply or Reset.
 *
 * Apply: `JSON.parse` failure -> inline parse error, store untouched. Parse
 * success -> `setWorkflowJson(parsed)` (graph updates, dirty=true), then a
 * non-blocking `POST /api/workflows/validate` to surface issues (warnings,
 * not blocking — the apply already happened).
 *
 * Reset: discards the draft and re-serializes the store's current workflow.
 *
 * Neo-brutalist pass (SPEC-step18.md §5.6): shares `ui/Modal.tsx` for the
 * shell. `ui/Modal.tsx`'s title is hardcoded `text-ink` (black), so a black
 * `headerColor` would render an invisible black-on-black title — instead
 * the Modal keeps its default accent header (readable) and a separate
 * "terminal" strip right above the textarea supplies the spec's "header
 * đen" console feel. The textarea itself is the deliberate dark spot
 * ("phòng máy") — `#0D0D0D` background, lime-on-black mono text.
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { ValidationIssue, Workflow } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { Modal } from '../ui/Modal.tsx';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

function isWorkflowLike(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    Array.isArray((value as { edges?: unknown }).edges)
  );
}

export interface JsonViewProps {
  onClose: () => void;
}

export function JsonView({ onClose }: JsonViewProps) {
  const workflow = useFlowStore((s) => s.workflow);
  const setWorkflowJson = useFlowStore((s) => s.setWorkflowJson);

  const [draft, setDraft] = useState(() => JSON.stringify(workflow, null, 2));
  const [touched, setTouched] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [validating, setValidating] = useState(false);

  // Sync the draft from the store whenever the workflow changes elsewhere —
  // but only while the user hasn't started editing this draft themselves.
  useEffect(() => {
    if (!touched) {
      setDraft(JSON.stringify(workflow, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  function handleChange(value: string): void {
    setDraft(value);
    setTouched(true);
    setParseError(null);
  }

  async function handleApply(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setParseError(errorMessage(err));
      return;
    }
    if (!isWorkflowLike(parsed)) {
      setParseError('JSON hợp lệ nhưng thiếu "nodes"/"edges" — không phải workflow.');
      return;
    }

    setParseError(null);
    setWorkflowJson(parsed);
    setTouched(false);
    setIssues([]);

    setValidating(true);
    try {
      const res = await api.validateWorkflow(parsed);
      setIssues(res.issues);
    } catch {
      // Non-blocking: the apply already happened; a failed validate call
      // (e.g. network hiccup) just means no warnings are shown.
    } finally {
      setValidating(false);
    }
  }

  function handleReset(): void {
    setDraft(JSON.stringify(workflow, null, 2));
    setTouched(false);
    setParseError(null);
    setIssues([]);
  }

  return (
    <Modal
      title="{} JSON view"
      onClose={onClose}
      className="h-[85vh] w-[720px]! max-w-[92vw]!"
      data-testid="json-view-modal"
    >
      <div className="flex h-full flex-col gap-2">
        <div className="flex shrink-0 items-center border-2 border-ink bg-ink px-2.5 py-1.5">
          <span className="truncate font-mono-data text-[11px] font-bold text-status-success">
            $ workflow.json — sửa trực tiếp rồi bấm Apply để cập nhật canvas
          </span>
        </div>

        <textarea
          aria-label="workflow json"
          data-testid="json-view-textarea"
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          spellCheck={false}
          className={`min-h-[45vh] flex-1 resize-none border-2 bg-[#0D0D0D] p-2 font-mono-data text-[11px] text-[#B6FF3B] caret-[#B6FF3B] focus:outline-none ${
            parseError ? 'border-status-error' : 'border-ink'
          }`}
        />

        {parseError && (
          <p data-testid="json-view-error" className="shrink-0 text-[11px] font-bold text-status-error">
            {parseError}
          </p>
        )}

        {issues.length > 0 && (
          <ul className="flex max-h-24 shrink-0 flex-col gap-1 overflow-y-auto border-2 border-ink bg-bg p-1.5">
            {issues.map((issue, i) => (
              <li
                key={`${issue.code}-${i}`}
                className="border-l-4 pl-1.5 font-mono-data text-[11px] font-bold text-ink"
                style={{ borderColor: 'var(--color-status-running)' }}
              >
                ⚠ [{issue.code}] {issue.message}
              </li>
            ))}
          </ul>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="primary" data-testid="json-view-apply" onClick={() => void handleApply()} disabled={validating}>
            {validating ? 'Applying…' : 'Apply'}
          </Button>
          <Button variant="secondary" onClick={handleReset}>
            Reset
          </Button>
        </div>
      </div>
    </Modal>
  );
}
