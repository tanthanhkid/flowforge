/**
 * Node palette grouped by category (SPEC-step4.md §4): drag onto the canvas
 * (FlowCanvas.tsx's onDrop reads NODE_DRAG_TYPE) or click to add at a
 * default position.
 */
import type { DragEvent } from 'react';
import type { NodeSpec } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { NODE_DRAG_TYPE } from './types.ts';

function groupByCategory(specs: NodeSpec[]): Array<[string, NodeSpec[]]> {
  const groups = new Map<string, NodeSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.category) ?? [];
    list.push(spec);
    groups.set(spec.category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function Sidebar() {
  const registry = useFlowStore((s) => s.registry);
  const addNode = useFlowStore((s) => s.addNode);

  const groups = groupByCategory(registry);

  function handleClickAdd(type: string): void {
    // Reads the live count via getState() rather than a subscribed value —
    // two clicks landing in the same React batch (no re-render in between)
    // would otherwise both see the same stale count and stack their nodes
    // at an identical position.
    const offset = (useFlowStore.getState().workflow.nodes.length % 8) * 30;
    addNode(type, { x: 60 + offset, y: 60 + offset });
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, type: string): void {
    event.dataTransfer.setData(NODE_DRAG_TYPE, type);
    event.dataTransfer.effectAllowed = 'move';
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-2 text-sm">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Nodes</h2>
      {groups.length === 0 && <p className="px-1 text-xs text-slate-400">Loading node registry…</p>}
      {groups.map(([category, specs]) => (
        <div key={category} className="mb-3">
          <h3 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{category}</h3>
          <div className="flex flex-col gap-1">
            {specs.map((spec) => (
              <button
                key={spec.type}
                type="button"
                draggable
                onDragStart={(event) => handleDragStart(event, spec.type)}
                onClick={() => handleClickAdd(spec.type)}
                title={spec.description}
                className="cursor-grab rounded border border-slate-200 px-2 py-1 text-left text-xs hover:bg-slate-50 active:cursor-grabbing"
              >
                {spec.title}
              </button>
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}
