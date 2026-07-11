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
 *    media with a real ⬇ download link, text in a monospace scroll box with
 *    a 📋 Copy button.
 *  - "Tất cả node" (collapsed by default): every successful node, compact.
 *    This is also the scroll target when a NodeCard's inline preview is
 *    clicked (store `scrollToNodeId`) — it's a superset of "Kết quả cuối"'s
 *    nodes, so every node the user could click on the canvas has an id here.
 *
 * A run that produced any node error shows a red banner at the top instead
 * of silently only showing whatever partial outputs exist.
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

function MediaResult({ keyPath, value }: { keyPath: string; value: MediaValue }) {
  const src = mediaSrc(value);
  if (!src) {
    return (
      <p className="text-xs text-red-500">
        {keyPath}: thiếu path/url ({value.kind})
      </p>
    );
  }
  // Only the server's own /artifacts route understands ?download=1 — an
  // external MediaValue.url (no local path) is passed through as-is.
  const downloadHref = src.startsWith('/artifacts/') ? `${src}?download=1` : src;
  const filename = value.path ? basename(value.path) : (src.split('/').pop() ?? src);
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-slate-400">{keyPath}</span>
      {value.kind === 'image' && (
        <img src={src} alt="" className="w-full rounded border border-slate-200 object-contain" />
      )}
      {value.kind === 'video' && <video src={src} controls className="w-full rounded border border-slate-200" />}
      {value.kind === 'audio' && <audio src={src} controls className="w-full" />}
      <a
        href={downloadHref}
        download={filename}
        data-testid="result-download-link"
        className="inline-flex w-fit items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
      >
        ⬇ Tải về <span className="text-slate-400">{filename}</span>
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-slate-400">{keyPath}</span>
        <button
          type="button"
          data-testid="result-copy-btn"
          onClick={() => void handleCopy()}
          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
        >
          {copied ? 'Copied' : '📋 Copy'}
        </button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px]">
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
      <p className="text-xs">
        <span className="font-mono text-[10px] text-slate-400">{keyPath}: </span>
        {String(value)}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-slate-400">{keyPath}</span>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 text-[11px]">
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

  const [allNodesOpen, setAllNodesOpen] = useState(false);

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
      <div data-testid="results-panel" className="p-3 text-xs text-slate-400">
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
    <div data-testid="results-panel" className="flex flex-col gap-3 p-3 text-sm">
      <p className="text-[10px] text-slate-400">
        Kết quả lưu tại data/artifacts/ và lịch sử Runs — không mất khi reload.
      </p>

      {erroredEntries.length > 0 && (
        <div data-testid="results-error-banner" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          <p className="mb-1 font-semibold">Run có lỗi:</p>
          <ul className="flex flex-col gap-0.5">
            {erroredEntries.map(([nodeId, r]) => (
              <li key={nodeId}>
                <span className="font-mono">{nodeId}</span>: {r.error ?? 'Unknown error'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Kết quả cuối</h2>
        {finalNodes.length === 0 && <p className="text-xs text-slate-400">Chưa có kết quả cuối.</p>}
        {finalNodes.map((node) => {
          const run = nodeRuns[node.id];
          const items = Object.entries(run?.outputs ?? {}).flatMap(([outKey, v]) =>
            collectLeafItems(v, `${node.id}.${outKey}`),
          );
          return (
            <div key={node.id} className="flex flex-col gap-2 rounded border border-slate-200 p-2">
              <p className="text-xs font-medium text-slate-600">
                {titleFor(node.type)} <span className="text-slate-400">({node.id})</span>
              </p>
              {items.length === 0 && <p className="text-xs text-slate-400">Không có output.</p>}
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
        className="rounded border border-slate-200"
      >
        <summary data-testid="results-all-nodes-toggle" className="cursor-pointer px-2 py-1 text-xs font-medium text-slate-600">
          Tất cả node ({successNodes.length})
        </summary>
        <div className="flex flex-col gap-2 p-2">
          {successNodes.length === 0 && <p className="text-xs text-slate-400">Chưa có node nào chạy thành công.</p>}
          {successNodes.map((node) => (
            <div
              key={node.id}
              id={`result-node-${node.id}`}
              data-testid="results-node-block"
              className="flex flex-col gap-1 rounded border border-slate-100 p-2"
            >
              <p className="text-[11px] font-medium text-slate-500">
                {titleFor(node.type)} <span className="text-slate-400">({node.id})</span>
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
