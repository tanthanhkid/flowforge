/**
 * Top toolbar (SPEC-step4.md §4): editable workflow name, Save (disabled
 * when !dirty), Validate (issue list, click -> select the offending node),
 * ▶ Run (disabled while running, spinner + status while running), New, and
 * (SPEC-step5.md §6) a "✨ Describe" panel that turns a natural-language
 * description into a whole workflow via POST /api/agent/generate-workflow.
 *
 * SPEC-step18.md §5.1 — re-themed neo-brutalist: groups separated by 2px
 * vertical black dividers (wordmark+name | New·Save | Validate·💰 |
 * Run·⚡Run bỏ cache | 🪄 Sắp xếp·👁 Preview | ✨ Describe | {} JSON | spacer |
 * ⚙), built from the shared `ui/` primitives. SPEC-step23.md §7 removed the
 * "Workflows" button/`onOpenWorkflowList` prop — `ConversationRail` (a
 * sibling of this toolbar in `App.tsx`) is the full replacement for the old
 * `WorkflowList.tsx` modal.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ApiError, generateWorkflowFromDescription } from '../api/client.ts';
import type { ValidationIssue } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { Popover } from '../ui/Popover.tsx';
import { Spinner } from '../ui/Spinner.tsx';

/** SPEC-step15.md §3: debounce delay before refreshing the 💰 estimate after a workflow edit. */
const ESTIMATE_DEBOUNCE_MS = 800;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/**
 * SPEC-step18.md §5.1/§7.6 — 💰 badge background by fee tier (chữ đen trên
 * cả 3, explicit in spec — overrides the general "trắng trên nền bão hoà
 * đậm" rule §6.3 for this one chip): lime < $0.05 ≤ vàng < $0.5 ≤ đỏ.
 */
function costBadgeClass(usd: number): string {
  if (usd < 0.05) return 'bg-cat-image';
  if (usd < 0.5) return 'bg-accent';
  return 'bg-status-error';
}

/** Shared square close (✕) button for the toolbar's popovers. */
function PopoverCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Đóng"
      className="flex h-5 w-5 shrink-0 items-center justify-center border-2 border-ink bg-paper text-[10px] font-bold text-ink hover:bg-ink hover:text-accent"
    >
      ✕
    </button>
  );
}

/** 2px vertical black bar that groups toolbar clusters (spec §5.1). */
function ToolbarDivider() {
  return <div aria-hidden="true" className="my-2 w-0.5 shrink-0 self-stretch bg-ink/85" />;
}

export interface ToolbarProps {
  onOpenJsonView: () => void;
  onOpenSettings: () => void;
}

export function Toolbar({ onOpenJsonView, onOpenSettings }: ToolbarProps) {
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
  const requestFitView = useFlowStore((s) => s.requestFitView);
  const showDescribe = useFlowStore((s) => s.describeOpen);
  const toggleDescribe = useFlowStore((s) => s.toggleDescribe);
  const closeDescribe = useFlowStore((s) => s.closeDescribe);

  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  // Surfaces errors that aren't validation issues (network failure, 404 for
  // a workflow that no longer exists on the server, etc.) — previously these
  // escaped `void handleX()` as unhandled promise rejections with zero UI
  // feedback, making Save/Run look like dead buttons.
  const [lastError, setLastError] = useState<string | null>(null);

  // ---- ✨ Describe panel (SPEC-step5.md §6) ------------------------------
  // `showDescribe`/toggle/close now live in the store (see `describeOpen`
  // above) — the empty-canvas CTA in FlowCanvas.tsx needs to *open* this
  // panel without toggling it closed if it's already open.
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [describeIssues, setDescribeIssues] = useState<ValidationIssue[]>([]);

  // ---- 💰 cost estimate (SPEC-step15.md §3) ------------------------------
  const [showEstimate, setShowEstimate] = useState(false);

  // Anchors for the 3 portaled popovers below (SPEC-step18.md §5.1 fix,
  // post-review critical finding) — Popover.tsx positions itself via
  // `getBoundingClientRect()` on these, not via CSS `absolute` nesting, so
  // it isn't clipped by this header's `overflow-x-auto`.
  const validateBtnWrapRef = useRef<HTMLDivElement>(null);
  const estimateBtnWrapRef = useRef<HTMLDivElement>(null);
  const describeBtnWrapRef = useRef<HTMLDivElement>(null);

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
      closeDescribe();
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

  // SPEC-step18.md §5.1/§7.3 — after 🪄 Sắp xếp recomputes positions, recenter
  // the canvas on the freshly laid-out graph via the store's fit-view nonce.
  function handleAutoLayout(): void {
    autoLayout();
    requestFitView();
  }

  function handleNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setWorkflowJson({ ...workflow, name: event.target.value });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b-[3px] border-ink bg-paper px-3">
      {/* Group 1: wordmark + workflow name */}
      <span className="-skew-x-[8deg] shrink-0 select-none border-2 border-ink bg-accent px-2.5 py-1.5 font-display text-sm uppercase tracking-wide text-ink shadow-hard-3">
        FLOWFORGE
      </span>
      <input
        value={workflow.name}
        onChange={handleNameChange}
        placeholder="Workflow name"
        aria-label="Tên workflow"
        className="h-9 w-48 shrink-0 border-2 border-ink bg-paper px-2 text-xs font-bold text-ink shadow-hard-2 placeholder:font-normal placeholder:text-ink-soft focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
      />

      <ToolbarDivider />

      {/* Group 2: New · Save */}
      <Button type="button" onClick={newWorkflow}>
        New
      </Button>
      <Button type="button" data-testid="save-btn" onClick={() => void handleSave()} disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>

      <ToolbarDivider />

      {/* Group 3: Validate · 💰 cost estimate */}
      <div ref={validateBtnWrapRef} className="relative shrink-0">
        <Button type="button" data-testid="validate-btn" onClick={() => void handleValidate()} disabled={validating}>
          {validating ? 'Validating…' : 'Validate'}
        </Button>
        {showIssues && (
          <Popover anchorRef={validateBtnWrapRef} className="w-72 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono-data text-xs font-bold text-ink">
                {validationIssues.length === 0 ? 'OK — no issues' : `${validationIssues.length} issue(s)`}
              </span>
              <PopoverCloseButton onClick={() => setShowIssues(false)} />
            </div>
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {validationIssues.map((issue, i) => (
                <li key={`${issue.code}-${i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (issue.nodeId) selectNode(issue.nodeId);
                    }}
                    className="w-full border-2 border-transparent px-1.5 py-1 text-left text-xs font-medium text-status-error hover:border-ink hover:bg-bg"
                  >
                    [{issue.code}] {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          </Popover>
        )}
      </div>
      <div ref={estimateBtnWrapRef} className="relative shrink-0">
        <button
          type="button"
          data-testid="cost-estimate"
          onClick={() => setShowEstimate((v) => !v)}
          title="Ước tính chi phí chạy workflow"
          className={`border-2 border-ink px-2.5 py-1.5 font-mono-data text-xs font-bold text-ink shadow-hard-2 transition-transform duration-100 motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 hover:shadow-hard-3 motion-safe:active:translate-x-0.5 motion-safe:active:translate-y-0.5 active:shadow-none ${costBadgeClass(
            costEstimate?.totalUsd ?? 0,
          )}`}
        >
          {costEstimate
            ? `💰 ~$${costEstimate.totalUsd.toFixed(2)}${costEstimate.unknownCount > 0 ? ' +?' : ''}`
            : '💰 ~$0.00'}
        </button>
        {showEstimate && costEstimate && (
          <Popover anchorRef={estimateBtnWrapRef} className="w-80 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono-data text-xs font-bold text-ink">Ước tính chi phí</span>
              <PopoverCloseButton onClick={() => setShowEstimate(false)} />
            </div>
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {costEstimate.nodes.map((n) => (
                <li key={n.nodeId} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-ink-soft">
                    {n.nodeId} <span className="text-ink-soft">({n.type})</span>
                    <br />
                    <span className="font-mono-data text-[11px] text-ink-soft">{n.basis}</span>
                  </span>
                  <span className="whitespace-nowrap text-right font-mono-data font-bold text-ink">
                    {n.usd === null ? '?' : `$${n.usd.toFixed(4)}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 font-mono-data text-xs font-bold text-ink">Tổng: ~${costEstimate.totalUsd.toFixed(2)}</p>
            <p className="mt-1 text-[11px] text-ink-soft">{costEstimate.disclaimer}</p>
          </Popover>
        )}
      </div>

      <ToolbarDivider />

      {/* Group 4: ▶ Run (to hơn) · ⚡ Run bỏ cache */}
      <Button
        type="button"
        data-testid="run-btn"
        variant="primary"
        onClick={() => void handleRun()}
        disabled={isRunning}
        className="!px-5 !py-2 !text-sm"
      >
        {isRunning && <Spinner label="Đang chạy" />}
        {isRunning ? 'Running…' : '▶ Run'}
      </Button>
      <Button
        type="button"
        data-testid="run-force-btn"
        variant="ghost"
        onClick={() => void handleRunForceAll()}
        disabled={isRunning}
        title="Chạy lại toàn bộ node, bỏ qua cache"
      >
        Run ⚡ bỏ cache
      </Button>

      <ToolbarDivider />

      {/* Group 5: 🪄 Sắp xếp · 👁 Preview */}
      <Button
        type="button"
        data-testid="auto-layout-btn"
        onClick={handleAutoLayout}
        title="Tự động sắp xếp lại vị trí node (không chồng nhau)"
      >
        🪄 Sắp xếp
      </Button>
      <Button
        type="button"
        data-testid="preview-toggle-btn"
        variant={showNodePreviews ? 'primary' : 'secondary'}
        onClick={toggleNodePreviews}
        title="Bật/tắt preview trên tất cả node"
        aria-pressed={showNodePreviews}
      >
        👁 Preview
      </Button>

      <ToolbarDivider />

      {/* Group 6: ✨ Describe */}
      <div ref={describeBtnWrapRef} className="relative shrink-0">
        <Button type="button" data-testid="describe-btn" variant="ai" onClick={toggleDescribe}>
          ✨ Describe
        </Button>
        <span className="pointer-events-none absolute -right-2 -top-2 -rotate-[10deg] border-2 border-ink bg-cat-image px-1 py-0.5 font-mono-data text-[8px] font-black text-ink">
          AI
        </span>
        {showDescribe && (
          <Popover anchorRef={describeBtnWrapRef} className="w-80 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono-data text-xs font-bold text-ink">Tạo workflow từ mô tả</span>
              <PopoverCloseButton onClick={closeDescribe} />
            </div>
            <textarea
              data-testid="describe-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mô tả workflow bạn muốn tạo…"
              rows={4}
              className="mb-2 w-full border-2 border-ink bg-paper p-1.5 text-xs font-medium text-ink placeholder:text-ink-soft focus:border-cat-video focus:shadow-[2px_2px_0_var(--color-cat-video)] focus:outline-none"
            />
            <Button
              type="button"
              data-testid="describe-generate"
              variant="primary"
              onClick={() => void handleGenerate()}
              disabled={generating || description.trim().length < 3}
            >
              {generating && <Spinner label="Đang tạo" />}
              {generating ? 'Generating…' : 'Generate'}
            </Button>
            {describeError && <p className="mt-1 text-xs font-medium text-status-error">{describeError}</p>}
            {describeIssues.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {describeIssues.map((issue, i) => (
                  <li key={`${issue.code}-${i}`} className="text-xs font-medium text-status-error">
                    [{issue.code}] {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
      </div>

      {runStatus && (
        <span className="shrink-0 font-mono-data text-[11px] font-bold text-ink-soft">status: {runStatus}</span>
      )}
      {lastError && (
        <span
          role="alert"
          className="shrink-0 border-2 border-ink bg-status-error px-2 py-1 text-xs font-bold text-paper"
        >
          {lastError}
        </span>
      )}

      <ToolbarDivider />

      {/* Group 7: {} JSON */}
      <Button type="button" data-testid="json-view-btn" onClick={onOpenJsonView}>
        {'{} JSON'}
      </Button>

      <div className="min-w-2 flex-1" />

      {/* ⚙ Settings */}
      <Button type="button" data-testid="settings-btn" onClick={onOpenSettings} title="Settings">
        ⚙
      </Button>
    </header>
  );
}
