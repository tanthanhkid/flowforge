/**
 * Custom React Flow node (SPEC-step4.md §4): title + category badge header,
 * input ports left / output ports right (colored by type via portColors.ts),
 * a run-state badge footer (pending/running/success/error/skipped, +
 * ⚡cache when cacheHit), an inline Preview of successful outputs, and
 * (SPEC-step5.md §6) a ✨ button opening a popover to edit this node via
 * natural-language instruction (POST /api/agent/edit-node).
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useState, type CSSProperties } from 'react';
import { editNodeWithInstruction } from '../api/client.ts';
import type { NodeState, PortType } from '../api/types.ts';
import { Preview } from '../preview/Preview.tsx';
import { useFlowStore } from '../store/flow.ts';
import { PORT_COLORS } from './portColors.ts';
import type { FlowNode } from './types.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

const STATE_BADGE: Record<NodeState, { label: string; className: string }> = {
  pending: { label: 'pending', className: 'bg-slate-200 text-slate-600' },
  running: { label: 'running', className: 'bg-blue-500 text-white animate-pulse' },
  success: { label: 'success', className: 'bg-green-500 text-white' },
  error: { label: 'error', className: 'bg-red-500 text-white' },
  skipped: { label: 'skipped', className: 'bg-yellow-400 text-yellow-900' },
};

const CATEGORY_COLORS: Record<string, string> = {
  llm: 'bg-blue-100 text-blue-700',
  image: 'bg-green-100 text-green-700',
  video: 'bg-purple-100 text-purple-700',
  audio: 'bg-orange-100 text-orange-700',
  utility: 'bg-slate-100 text-slate-700',
};

function categoryClass(category: string): string {
  return CATEGORY_COLORS[category] ?? 'bg-slate-100 text-slate-700';
}

function portDotStyle(type: PortType): CSSProperties {
  const color = PORT_COLORS[type];
  return {
    width: 10,
    height: 10,
    background: type === 'any' ? 'transparent' : color,
    border: `2px ${type === 'any' ? 'dashed' : 'solid'} ${color}`,
  };
}

export function NodeCard({ data, selected }: NodeProps<FlowNode>) {
  const { node, spec, runState } = data;
  const inputs = Object.entries(spec?.inputs ?? {});
  const outputs = Object.entries(spec?.outputs ?? {});
  const badge = runState ? STATE_BADGE[runState.state] : undefined;
  const hasOutputs = runState?.state === 'success' && runState.outputs && Object.keys(runState.outputs).length > 0;

  const workflow = useFlowStore((s) => s.workflow);
  const setWorkflowJson = useFlowStore((s) => s.setWorkflowJson);
  const selectNode = useFlowStore((s) => s.selectNode);
  const isForced = useFlowStore((s) => s.forceNodeIds.includes(node.id));

  const [showEdit, setShowEdit] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [applying, setApplying] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  async function handleApply(): Promise<void> {
    setApplying(true);
    setEditError(null);
    try {
      const result = await editNodeWithInstruction(workflow, node.id, instruction);
      setWorkflowJson(result.workflow);
      // setWorkflowJson clears selection when the previously selected node
      // no longer exists — this node still does, so re-select it explicitly
      // (spec §6: "thành công setWorkflowJson(kết quả) giữ selection").
      selectNode(node.id);
      setShowEdit(false);
      setInstruction('');
    } catch (err) {
      setEditError(errorMessage(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      data-testid="node-card"
      data-node-id={node.id}
      data-state={runState?.state ?? 'pending'}
      className={`min-w-[200px] rounded-md border bg-white shadow-sm ${
        selected ? 'border-blue-500 ring-2 ring-blue-400' : 'border-slate-300'
      }`}
    >
      <div className="relative flex items-center justify-between gap-2 border-b border-slate-200 px-2 py-1">
        <span className="truncate text-xs font-semibold" title={node.id}>
          {spec?.title ?? node.type}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${categoryClass(spec?.category ?? '')}`}>
            {spec?.category ?? '?'}
          </span>
          {isForced && (
            <span
              title="Sẽ force re-run ở lần Run kế tiếp"
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
            >
              🔁 force
            </span>
          )}
          <button
            type="button"
            title="Edit this node with AI"
            onClick={(e) => {
              e.stopPropagation();
              setShowEdit((v) => !v);
            }}
            className="rounded px-1 text-xs hover:bg-slate-100"
          >
            ✨
          </button>
        </div>
        {showEdit && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 top-full z-10 mt-1 w-64 rounded border border-slate-200 bg-white p-2 shadow-lg"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold">Sửa node bằng AI</span>
              <button type="button" onClick={() => setShowEdit(false)} className="text-xs text-slate-400">
                ✕
              </button>
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Mô tả thay đổi bạn muốn…"
              rows={3}
              className="mb-2 w-full rounded border border-slate-200 p-1 text-xs"
            />
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applying || instruction.trim().length === 0}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {applying && (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {applying ? 'Applying…' : 'Apply'}
            </button>
            {editError && <p className="mt-1 text-xs text-red-600">{editError}</p>}
          </div>
        )}
      </div>

      <div className="flex justify-between gap-3 px-1 py-1.5">
        <div className="flex flex-col gap-1">
          {inputs.map(([name, portSpec]) => (
            <div key={name} className="relative flex h-4 items-center pl-3">
              <Handle
                type="target"
                position={Position.Left}
                id={name}
                title={`${name}: ${portSpec.type}`}
                style={portDotStyle(portSpec.type)}
              />
              <span className="truncate text-[10px] text-slate-500">{name}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-end gap-1">
          {outputs.map(([name, portSpec]) => (
            <div key={name} className="relative flex h-4 items-center justify-end pr-3">
              <span className="truncate text-[10px] text-slate-500">{name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={name}
                title={`${name}: ${portSpec.type}`}
                style={portDotStyle(portSpec.type)}
              />
            </div>
          ))}
        </div>
      </div>

      {hasOutputs && runState?.outputs && (
        <div data-testid="node-preview" className="border-t border-slate-100 px-2 py-1">
          {Object.entries(runState.outputs).map(([key, value]) => (
            <Preview key={key} value={value} />
          ))}
        </div>
      )}

      {badge && (
        <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-1" title={runState?.error}>
          <span data-testid="node-state-badge" className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>
            {badge.label}
          </span>
          {runState?.cached && <span className="text-[10px] text-amber-600">⚡cache</span>}
        </div>
      )}
    </div>
  );
}
