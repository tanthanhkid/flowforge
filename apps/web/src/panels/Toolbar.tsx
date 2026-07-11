/**
 * Top toolbar (SPEC-step4.md §4): editable workflow name, Save (disabled
 * when !dirty), Validate (issue list, click -> select the offending node),
 * ▶ Run (disabled while running, spinner + status while running), New, a
 * button to open the WorkflowList overlay, and (SPEC-step5.md §6) a
 * "✨ Describe" panel that turns a natural-language description into a
 * whole workflow via POST /api/agent/generate-workflow.
 */
import { useEffect, useState, type ChangeEvent } from 'react';
import { ApiError, generateWorkflowFromDescription } from '../api/client.ts';
import type { ValidationIssue } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';

/** SPEC-step15.md §3: debounce delay before refreshing the 💰 estimate after a workflow edit. */
const ESTIMATE_DEBOUNCE_MS = 800;

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
  const showNodePreviews = useFlowStore((s) => s.showNodePreviews);
  const toggleNodePreviews = useFlowStore((s) => s.toggleNodePreviews);
  const costEstimate = useFlowStore((s) => s.costEstimate);
  const refreshEstimate = useFlowStore((s) => s.refreshEstimate);
  const autoLayout = useFlowStore((s) => s.autoLayout);

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

  // ---- 💰 cost estimate (SPEC-step15.md §3) ------------------------------
  const [showEstimate, setShowEstimate] = useState(false);

  // Debounced refresh (800ms after the workflow's own content last changed,
  // not after every keystroke's render) — silent-fail is handled inside
  // refreshEstimate() itself, so no try/catch needed here.
  const workflowJson = JSON.stringify(workflow);
  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshEstimate();
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowJson]);

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
      // SPEC-step16.md §3: run the client's precise auto-layout right after
      // a successful ✨ generate — the agent's own positions (server
      // `agent/layout.ts`) are only a coarse pre-validation nudge, not
      // collision-free against NodeCard's actual fixed-size box, so left
      // alone the generated graph re-creates the "nodes overlapping, edges
      // chéo loạn" bug this step fixes. Runs immediately with whatever
      // fallback sizes are available rather than waiting for nodes to
      // render/measure first (spec: "không cần đợi đo").
      autoLayout();
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
          data-testid="cost-estimate"
          onClick={() => setShowEstimate((v) => !v)}
          title="Ước tính chi phí chạy workflow"
          className="rounded border border-slate-300 px-3 py-1 text-xs"
        >
          {costEstimate
            ? `💰 ~$${costEstimate.totalUsd.toFixed(2)}${costEstimate.unknownCount > 0 ? ' +?' : ''}`
            : '💰 ~$0.00'}
        </button>
        {showEstimate && costEstimate && (
          <div className="absolute left-0 top-full z-10 mt-1 w-80 rounded border border-slate-200 bg-white p-2 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold">Ước tính chi phí</span>
              <button type="button" onClick={() => setShowEstimate(false)} className="text-xs text-slate-400">
                ✕
              </button>
            </div>
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {costEstimate.nodes.map((n) => (
                <li key={n.nodeId} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-slate-600">
                    {n.nodeId} <span className="text-slate-400">({n.type})</span>
                    <br />
                    <span className="text-[11px] text-slate-400">{n.basis}</span>
                  </span>
                  <span className="whitespace-nowrap text-right font-medium">
                    {n.usd === null ? '?' : `$${n.usd.toFixed(4)}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs font-semibold">Tổng: ~${costEstimate.totalUsd.toFixed(2)}</p>
            <p className="mt-1 text-[11px] text-slate-400">{costEstimate.disclaimer}</p>
          </div>
        )}
      </div>

      <button
        type="button"
        data-testid="auto-layout-btn"
        onClick={autoLayout}
        title="Tự động sắp xếp lại vị trí node (không chồng nhau)"
        className="rounded border border-slate-300 px-3 py-1 text-xs"
      >
        🪄 Sắp xếp
      </button>

      <button
        type="button"
        data-testid="preview-toggle-btn"
        onClick={toggleNodePreviews}
        title="Bật/tắt preview trên tất cả node"
        aria-pressed={showNodePreviews}
        className={`rounded border px-3 py-1 text-xs ${
          showNodePreviews ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-500'
        }`}
      >
        👁 Preview
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
