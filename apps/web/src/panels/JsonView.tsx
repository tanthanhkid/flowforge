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
 */
import { useEffect, useState } from 'react';
import * as api from '../api/client.ts';
import type { ValidationIssue, Workflow } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[720px] flex-col rounded bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{'{} JSON view'}</h2>
          <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <textarea
          aria-label="workflow json"
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          spellCheck={false}
          className={`min-h-[50vh] flex-1 resize-none rounded border p-2 font-mono text-xs ${
            parseError ? 'border-red-500' : 'border-slate-300'
          }`}
        />

        {parseError && <p className="mt-1 text-xs text-red-600">{parseError}</p>}

        {issues.length > 0 && (
          <ul className="mt-2 flex max-h-24 flex-col gap-1 overflow-y-auto">
            {issues.map((issue, i) => (
              <li key={`${issue.code}-${i}`} className="text-xs text-amber-600">
                [{issue.code}] {issue.message}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={validating}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {validating ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
