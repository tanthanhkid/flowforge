/**
 * "Kết quả" tab (SPEC-step9.md §2) — the results surface the user actually
 * looks for after a run: no dedicated place existed before this (outputs
 * were only visible as tiny inline node previews), even though they were
 * already durably stored in `node_runs.outputs_json` + `data/artifacts/`.
 *
 * Two blocks:
 *  - "Kết quả cuối": outputs of every `output.collect` node in the workflow
 *    (or, when the workflow has none, every leaf node — one with no
 *    outgoing edge) that finished successfully. Shown large: full-width
 *    media in a "polaroid" frame with a real ⬇ download link, text in a
 *    monospace scroll box with a 📋 Copy button.
 *  - "Tất cả node" (collapsed by default): every successful node, compact.
 *    This is also the scroll target when a NodeCard's inline preview is
 *    clicked (store `scrollToNodeId`) — it's a superset of "Kết quả cuối"'s
 *    nodes, so every node the user could click on the canvas has an id here.
 *
 * A run that produced any node error shows a red banner at the top instead
 * of silently only showing whatever partial outputs exist.
 *
 * SPEC-step18.md §4/7.5 — root-cause fix for "tab Kết quả báo 'Chưa có run
 * nào' dù DB có run": when this panel mounts (or the current workflow
 * changes) without a *live* run already loaded into the store, it asks the
 * store to load the workflow's most recent run (`ensureLatestRunLoaded`,
 * store/flow.ts) — reusing `openRun`'s own snapshot-fetching logic — without
 * switching tabs, since the user is already looking at this one.
 */
import { useEffect, useState } from 'react';
import type { MediaValue, PortValue } from '../api/types.ts';
import { basename, isMediaValue, mediaSrc, Preview } from '../preview/Preview.tsx';
import { useFlowStore } from '../store/flow.ts';

interface LeafItem {
  keyPath: string;
  value: PortValue;
}

/**
 * Flattens a node output down to its media/text/primitive leaves, keeping a
 * dotted key path (`output.collect`'s single `results` output is itself an
 * object keyed by `in1..in4` — this walks into that one extra level, and any
 * further nesting, without special-casing that node type).
 */
function collectLeafItems(value: PortValue, keyPath: string): LeafItem[] {
  if (value === undefined || value === null) return [];
  if (isMediaValue(value)) return [{ keyPath, value }];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ keyPath, value }];
  }
  if (Array.isArray(value)) return [{ keyPath, value }];
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => collectLeafItems(v, `${keyPath}.${k}`));
  }
  return [{ keyPath, value }];
}

// "Pill" shape (rounded-[4px]) is the one deliberate border-radius exception
// (spec §5.5, alongside round status dots) in an otherwise square UI.
const PILL_BUTTON_CLASS =
  'inline-flex w-fit items-center gap-1 rounded-[4px] border-2 border-ink bg-paper px-2.5 py-1 text-[11px] font-bold text-ink transition-colors hover:bg-accent';

function MediaResult({ keyPath, value }: { keyPath: string; value: MediaValue }) {
  const src = mediaSrc(value);
  if (!src) {
    return (
      <p className="text-[11px] text-status-error">
        {keyPath}: thiếu path/url ({value.kind})
      </p>
    );
  }
  // Only the server's own /artifacts route understands ?download=1 — an
  // external MediaValue.url (no local path) is passed through as-is.
  const downloadHref = src.startsWith('/artifacts/') ? `${src}?download=1` : src;
  const filename = value.path ? basename(value.path) : (src.split('/').pop() ?? src);
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono-data text-[11px] text-ink-soft">{keyPath}</span>
      {/* "Polaroid" frame — thick black border + paper mat around the media itself (spec §5.5). */}
      <div className="w-fit max-w-full border-4 border-ink bg-paper p-2 shadow-hard-3">
        {value.kind === 'image' && <img src={src} alt="" className="max-h-96 w-full object-contain" />}
        {value.kind === 'video' && <video src={src} controls className="max-h-96 w-full" />}
        {value.kind === 'audio' && <audio src={src} controls className="w-64 max-w-full" />}
      </div>
      <a href={downloadHref} download={filename} data-testid="result-download-link" className={PILL_BUTTON_CLASS}>
        ⬇ Tải về <span className="font-mono-data font-normal text-ink-soft">{filename}</span>
      </a>
    </div>
  );
}

function TextResult({ keyPath, value }: { keyPath: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable/denied — button stays clickable, just no
      // "Copied" confirmation; not worth surfacing as an error.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-data text-[11px] text-ink-soft">{keyPath}</span>
        <button type="button" data-testid="result-copy-btn" onClick={() => void handleCopy()} className={PILL_BUTTON_CLASS}>
          {copied ? 'Copied' : '📋 Copy'}
        </button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-2 border-ink bg-bg p-2 font-mono-data text-[11px] text-ink">
        {value}
      </pre>
    </div>
  );
}

function ResultItem({ keyPath, value }: LeafItem) {
  if (isMediaValue(value)) return <MediaResult keyPath={keyPath} value={value} />;
  if (typeof value === 'string') return <TextResult keyPath={keyPath} value={value} />;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return (
      <p className="text-xs text-ink">
        <span className="font-mono-data text-[11px] text-ink-soft">{keyPath}: </span>
        {String(value)}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono-data text-[11px] text-ink-soft">{keyPath}</span>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-2 border-ink bg-bg p-2 font-mono-data text-[11px] text-ink">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function ResultsPanel() {
  const workflow = useFlowStore((s) => s.workflow);
  const registry = useFlowStore((s) => s.registry);
  const runId = useFlowStore((s) => s.runId);
  const nodeRuns = useFlowStore((s) => s.nodeRuns);
  const scrollToNodeId = useFlowStore((s) => s.scrollToNodeId);
  const clearScrollToNode = useFlowStore((s) => s.clearScrollToNode);
  const ensureLatestRunLoaded = useFlowStore((s) => s.ensureLatestRunLoaded);

  const [allNodesOpen, setAllNodesOpen] = useState(false);

  const workflowId = workflow.id;

  // SPEC-step18.md §4/7.5 — no live run in the store (fresh page load, or a
  // workflow switch) but the workflow may well have runs in the DB already;
  // RunsPanel finds them independently via the same listRuns() call, which
  // is what made this read as a bug. Auto-load the latest one, tab untouched.
  useEffect(() => {
    if (runId) return;
    void ensureLatestRunLoaded();
  }, [workflowId, runId, ensureLatestRunLoaded]);

  // A NodeCard preview click (store.requestScrollToNode) lands here: force
  // the "Tất cả node" section open (its id lives there) and scroll to it.
  useEffect(() => {
    if (!scrollToNodeId) return;
    setAllNodesOpen(true);
    const targetId = scrollToNodeId;
    requestAnimationFrame(() => {
      document.getElementById(`result-node-${targetId}`)?.scrollIntoView({ block: 'center' });
    });
    clearScrollToNode();
  }, [scrollToNodeId, clearScrollToNode]);

  function titleFor(type: string): string {
    return registry.find((s) => s.type === type)?.title ?? type;
  }

  if (!runId) {
    return (
      <div data-testid="results-panel" className="p-4 text-xs text-ink-soft">
        Chưa có run nào — chạy workflow để xem kết quả tại đây.
      </div>
    );
  }

  const erroredEntries = Object.entries(nodeRuns).filter(([, r]) => r.state === 'error');
  const successNodes = workflow.nodes.filter((n) => nodeRuns[n.id]?.state === 'success');

  const hasCollectNode = workflow.nodes.some((n) => n.type === 'output.collect');
  const finalNodes = hasCollectNode
    ? successNodes.filter((n) => n.type === 'output.collect')
    : successNodes.filter((n) => !workflow.edges.some((e) => e.from.node === n.id));

  return (
    <div data-testid="results-panel" className="flex flex-col gap-4 p-3 text-sm text-ink">
      <p className="text-[11px] text-ink-soft">
        Kết quả lưu tại data/artifacts/ và lịch sử Runs — không mất khi reload.
      </p>

      {erroredEntries.length > 0 && (
        <div data-testid="results-error-banner" className="border-2 border-status-error bg-status-error/10 p-3 text-[11px] text-ink shadow-hard-2">
          <p className="mb-1.5 font-display text-xs uppercase tracking-wide text-status-error">Run có lỗi:</p>
          <ul className="flex flex-col gap-1">
            {erroredEntries.map(([nodeId, r]) => (
              <li key={nodeId}>
                <span className="font-mono-data text-ink">{nodeId}</span>: {r.error ?? 'Unknown error'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="font-display text-xs uppercase tracking-wide text-ink">Kết quả cuối</h2>
        {finalNodes.length === 0 && <p className="text-xs text-ink-soft">Chưa có kết quả cuối.</p>}
        {finalNodes.map((node) => {
          const run = nodeRuns[node.id];
          const items = Object.entries(run?.outputs ?? {}).flatMap(([outKey, v]) =>
            collectLeafItems(v, `${node.id}.${outKey}`),
          );
          return (
            <div key={node.id} className="flex flex-col gap-3 border-2 border-ink bg-paper p-3 shadow-hard-3">
              <p className="text-xs font-bold text-ink">
                {titleFor(node.type)} <span className="font-mono-data text-[11px] font-normal text-ink-soft">({node.id})</span>
              </p>
              {items.length === 0 && <p className="text-xs text-ink-soft">Không có output.</p>}
              {items.map((item) => (
                <ResultItem key={item.keyPath} keyPath={item.keyPath} value={item.value} />
              ))}
            </div>
          );
        })}
      </div>

      <details
        open={allNodesOpen}
        onToggle={(e) => setAllNodesOpen(e.currentTarget.open)}
        className="border-2 border-ink bg-paper"
      >
        <summary
          data-testid="results-all-nodes-toggle"
          className="cursor-pointer select-none px-3 py-2 font-display text-xs uppercase tracking-wide text-ink"
        >
          Tất cả node ({successNodes.length})
        </summary>
        <div className="flex flex-col gap-2 border-t-2 border-ink p-3">
          {successNodes.length === 0 && <p className="text-xs text-ink-soft">Chưa có node nào chạy thành công.</p>}
          {successNodes.map((node) => (
            <div
              key={node.id}
              id={`result-node-${node.id}`}
              data-testid="results-node-block"
              className="flex flex-col gap-1 border-2 border-ink/30 p-2"
            >
              <p className="text-[11px] font-bold text-ink-soft">
                {titleFor(node.type)} <span className="font-mono-data font-normal text-ink-soft">({node.id})</span>
              </p>
              {Object.entries(nodeRuns[node.id]?.outputs ?? {}).map(([k, v]) => (
                <Preview key={k} value={v} />
              ))}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
