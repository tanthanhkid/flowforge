/**
 * Custom React Flow node (SPEC-step4.md §4): title + category badge header,
 * input ports left / output ports right (colored by type via portColors.ts),
 * a run-state badge footer (pending/running/success/error/skipped, +
 * ⚡cache when cacheHit), and an inline Preview of successful outputs.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { NodeState, PortType } from '../api/types.ts';
import { Preview } from '../preview/Preview.tsx';
import { PORT_COLORS } from './portColors.ts';
import type { FlowNode } from './types.ts';

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

  return (
    <div
      className={`min-w-[200px] rounded-md border bg-white shadow-sm ${
        selected ? 'border-blue-500 ring-2 ring-blue-400' : 'border-slate-300'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-2 py-1">
        <span className="truncate text-xs font-semibold" title={node.id}>
          {spec?.title ?? node.type}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${categoryClass(spec?.category ?? '')}`}>
          {spec?.category ?? '?'}
        </span>
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
        <div className="border-t border-slate-100 px-2 py-1">
          {Object.entries(runState.outputs).map(([key, value]) => (
            <Preview key={key} value={value} />
          ))}
        </div>
      )}

      {badge && (
        <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-1" title={runState?.error}>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>{badge.label}</span>
          {runState?.cached && <span className="text-[10px] text-amber-600">⚡cache</span>}
        </div>
      )}
    </div>
  );
}
