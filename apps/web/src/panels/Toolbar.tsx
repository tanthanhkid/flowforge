/**
 * Top toolbar (SPEC-step4.md §4): editable workflow name, Save (disabled
 * when !dirty), Validate (issue list, click -> select the offending node),
 * ▶ Run (disabled while running, spinner + status while running), New, a
 * button to open the WorkflowList overlay, and (SPEC-step5.md §6) a
 * "✨ Describe" panel that turns a natural-language description into a
 * whole workflow via POST /api/agent/generate-workflow.
 */
import { useState, type ChangeEvent } from 'react';
import { ApiError, generateWorkflowFromDescription } from '../api/client.ts';
import type { ValidationIssue } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export interface ToolbarProps {
  onOpenWorkflowList: () => void;
  onOpenJsonView: () => void;
  onOpenSettings: () => void;
}

export function Toolbar({ onOpenWorkflowList, onOpenJsonView, onOpenSettings }: ToolbarProps) {
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

  // ---- ✨ Describe panel (SPEC-step5.md §6) ------------------------------
  const [showDescribe, setShowDescribe] = useState(false);
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [describeIssues, setDescribeIssues] = useState<ValidationIssue[]>([]);

  const isRunning = runStatus === 'running';

  async function handleGenerate(): Promise<void> {
    // Overwriting an in-progress edit the user hasn't saved yet is
    // destructive — confirm first (spec §6: "nếu workflow hiện tại dirty
    // thì confirm trước khi ghi đè").
    if (dirty && !window.confirm('Workflow hiện tại chưa lưu sẽ bị ghi đè. Tiếp tục?')) {
      return;
    }
    setGenerating(true);
    setDescribeError(null);
    setDescribeIssues([]);
    try {
      const result = await generateWorkflowFromDescription(description);
      setWorkflowJson(result.workflow);
      setShowDescribe(false);
      setDescription('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setDescribeIssues(err.issues ?? []);
      } else {
        setDescribeError(errorMessage(err));
      }
    } finally {
      setGenerating(false);
    }
  }

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

  // "Run ⚡ bỏ cache" (SPEC-step6.md §3): force every node in the workflow,
  // independent of whatever the user queued via forceNodeIds (that queue is
  // left untouched — this is a one-off "skip the cache entirely" run).
  async function handleRunForceAll(): Promise<void> {
    setLastError(null);
    const allNodeIds = workflow.nodes.map((n) => n.id);
    try {
      const started = await run(allNodeIds);
      if (!started) {
        setShowIssues(true);
      }
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
        data-testid="save-btn"
        onClick={() => void handleSave()}
        disabled={!dirty || saving}
        className="rounded border border-slate-300 px-3 py-1 text-xs disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      <div className="relative">
        <button
          type="button"
          data-testid="validate-btn"
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
        data-testid="run-btn"
        onClick={() => void handleRun()}
        disabled={isRunning}
        className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {isRunning && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />}
        {isRunning ? 'Running…' : '▶ Run'}
      </button>

      <button
        type="button"
        data-testid="run-force-btn"
        onClick={() => void handleRunForceAll()}
        disabled={isRunning}
        title="Chạy lại toàn bộ node, bỏ qua cache"
        className="rounded border border-amber-400 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 disabled:opacity-50"
      >
        Run ⚡ bỏ cache
      </button>

      <div className="relative">
        <button
          type="button"
          data-testid="describe-btn"
          onClick={() => setShowDescribe((v) => !v)}
          className="rounded border border-slate-300 px-3 py-1 text-xs"
        >
          ✨ Describe
        </button>
        {showDescribe && (
          <div className="absolute left-0 top-full z-10 mt-1 w-80 rounded border border-slate-200 bg-white p-2 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold">Tạo workflow từ mô tả</span>
              <button type="button" onClick={() => setShowDescribe(false)} className="text-xs text-slate-400">
                ✕
              </button>
            </div>
            <textarea
              data-testid="describe-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mô tả workflow bạn muốn tạo…"
              rows={4}
              className="mb-2 w-full rounded border border-slate-200 p-1 text-xs"
            />
            <button
              type="button"
              data-testid="describe-generate"
              onClick={() => void handleGenerate()}
              disabled={generating || description.trim().length < 3}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {generating && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {generating ? 'Generating…' : 'Generate'}
            </button>
            {describeError && <p className="mt-1 text-xs text-red-600">{describeError}</p>}
            {describeIssues.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {describeIssues.map((issue, i) => (
                  <li key={`${issue.code}-${i}`} className="text-xs text-red-600">
                    [{issue.code}] {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {runStatus && <span className="text-xs text-slate-400">status: {runStatus}</span>}

      {lastError && (
        <span className="rounded bg-red-50 px-2 py-1 text-xs text-red-600" role="alert">
          {lastError}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          data-testid="json-view-btn"
          onClick={onOpenJsonView}
          className="rounded border border-slate-300 px-3 py-1 text-xs"
        >
          {'{} JSON'}
        </button>
        <button type="button" onClick={newWorkflow} className="rounded border border-slate-300 px-3 py-1 text-xs">
          New
        </button>
        <button type="button" onClick={onOpenWorkflowList} className="rounded border border-slate-300 px-3 py-1 text-xs">
          Workflows
        </button>
        <button
          type="button"
          data-testid="settings-btn"
          onClick={onOpenSettings}
          title="Settings"
          className="rounded border border-slate-300 px-3 py-1 text-xs"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
