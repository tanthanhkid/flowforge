/**
 * Top toolbar (SPEC-step4.md §4): editable workflow name, Save (disabled
 * when !dirty), Validate (issue list, click -> select the offending node),
 * ▶ Run (disabled while running, spinner + status while running), New, and
 * a button to open the WorkflowList overlay.
 */
import { useState, type ChangeEvent } from 'react';
import { useFlowStore } from '../store/flow.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export interface ToolbarProps {
  onOpenWorkflowList: () => void;
}

export function Toolbar({ onOpenWorkflowList }: ToolbarProps) {
  const workflow = useFlowStore((s) => s.workflow);
  const dirty = useFlowStore((s) => s.dirty);
  const runStatus = useFlowStore((s) => s.runStatus);
  const validationIssues = useFlowStore((s) => s.validationIssues);
  const forceNodeIds = useFlowStore((s) => s.forceNodeIds);
  const setWorkflowJson = useFlowStore((s) => s.setWorkflowJson);
  const saveWorkflow = useFlowStore((s) => s.saveWorkflow);
  const newWorkflow = useFlowStore((s) => s.newWorkflow);
  const run = useFlowStore((s) => s.run);
  const validate = useFlowStore((s) => s.validate);
  const selectNode = useFlowStore((s) => s.selectNode);
  const clearForceNodes = useFlowStore((s) => s.clearForceNodes);

  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  // Surfaces errors that aren't validation issues (network failure, 404 for
  // a workflow that no longer exists on the server, etc.) — previously these
  // escaped `void handleX()` as unhandled promise rejections with zero UI
  // feedback, making Save/Run look like dead buttons.
  const [lastError, setLastError] = useState<string | null>(null);

  const isRunning = runStatus === 'running';

  async function handleSave(): Promise<void> {
    setSaving(true);
    setLastError(null);
    try {
      await saveWorkflow();
    } catch (err) {
      setLastError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleValidate(): Promise<void> {
    setValidating(true);
    setLastError(null);
    try {
      await validate();
      setShowIssues(true);
    } catch (err) {
      setLastError(errorMessage(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleRun(): Promise<void> {
    setLastError(null);
    const force = forceNodeIds.length > 0 ? forceNodeIds : undefined;
    try {
      const started = await run(force);
      if (!started) {
        // run() already stored the server's validation issues in the store
        // — show the same issue popup the Validate button uses, otherwise
        // clicking ▶ Run on an invalid workflow looks like a dead button.
        setShowIssues(true);
        return;
      }
      // Only clear the force-rerun selection once a run actually started —
      // clearing it after a rejected/aborted run silently loses the user's
      // "force re-run this node" choice for nothing.
      clearForceNodes();
    } catch (err) {
      setLastError(errorMessage(err));
    }
  }

  function handleNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setWorkflowJson({ ...workflow, name: event.target.value });
  }

  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2">
      <input
        value={workflow.name}
        onChange={handleNameChange}
        placeholder="Workflow name"
        className="w-56 rounded border border-transparent px-2 py-1 text-sm font-medium hover:border-slate-200 focus:border-slate-300 focus:outline-none"
      />

      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={!dirty || saving}
        className="rounded border border-slate-300 px-3 py-1 text-xs disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => void handleValidate()}
          disabled={validating}
          className="rounded border border-slate-300 px-3 py-1 text-xs disabled:opacity-40"
        >
          {validating ? 'Validating…' : 'Validate'}
        </button>
        {showIssues && (
          <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded border border-slate-200 bg-white p-2 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold">
                {validationIssues.length === 0 ? 'OK — no issues' : `${validationIssues.length} issue(s)`}
              </span>
              <button type="button" onClick={() => setShowIssues(false)} className="text-xs text-slate-400">
                ✕
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {validationIssues.map((issue, i) => (
                <li key={`${issue.code}-${i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (issue.nodeId) selectNode(issue.nodeId);
                    }}
                    className="w-full rounded px-1 py-0.5 text-left text-xs text-red-600 hover:bg-red-50"
                  >
                    [{issue.code}] {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => void handleRun()}
        disabled={isRunning}
        className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {isRunning && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />}
        {isRunning ? 'Running…' : '▶ Run'}
      </button>

      {runStatus && <span className="text-xs text-slate-400">status: {runStatus}</span>}

      {lastError && (
        <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-600" role="alert">
          {lastError}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={newWorkflow} className="rounded border border-slate-300 px-3 py-1 text-xs">
          New
        </button>
        <button type="button" onClick={onOpenWorkflowList} className="rounded border border-slate-300 px-3 py-1 text-xs">
          Workflows
        </button>
      </div>
    </header>
  );
}
