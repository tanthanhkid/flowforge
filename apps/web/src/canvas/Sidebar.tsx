/**
 * Node palette grouped by category (SPEC-step4.md §4): drag onto the canvas
 * (FlowCanvas.tsx's onDrop reads NODE_DRAG_TYPE) or click to add at a
 * default position.
 *
 * SPEC-step18.md §5.2 (neo-brutalist pass): white surface, 3px black right
 * border; each category is a full-width, category-colored, sticky bar
 * (font-display uppercase — llm's blue needs white text, every other
 * category's saturated bg needs black, same AA rule as NodeCard's header);
 * each node is a 2px-bordered "sticker" that tilts -1.5° on hover ("nhặt
 * sticker" feel); a dashed-border tip banner closes out the list pointing at
 * chatting with the AI (ChatPane) as the alternative to manual drag-and-drop
 * (SPEC-step24.md §5 replaced the old "✨ Describe" toolbar popover with it).
 */
import type { DragEvent } from 'react';
import type { NodeSpec } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { categoryHex, categoryTextClass } from './categoryColors.ts';
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

/** Vietnamese label + emoji per known category (matches the mockup); unknown categories fall back to their raw name. */
const CATEGORY_LABEL: Record<string, string> = {
  llm: '🧠 LLM',
  image: '🖼 Image',
  video: '🎞 Video',
  audio: '🔊 Audio',
  utility: '🧰 Utility',
};

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
    <aside className="flex w-[210px] shrink-0 flex-col overflow-y-auto border-r-[3px] border-ink bg-paper text-sm">
      {groups.length === 0 && <p className="p-2 font-mono-data text-[11px] text-ink-soft">Loading node registry…</p>}
      {groups.map(([category, specs]) => (
        <div key={category}>
          <h3
            className={`sticky top-0 z-10 border-t-[3px] border-ink px-2 py-1 font-display text-[11px] uppercase tracking-wide ${categoryTextClass(category)}`}
            style={{ background: categoryHex(category) }}
          >
            {CATEGORY_LABEL[category] ?? category}
          </h3>
          <div className="flex flex-col gap-1.5 p-2">
            {specs.map((spec) => (
              <button
                key={spec.type}
                type="button"
                data-testid={`palette-${spec.type}`}
                draggable
                onDragStart={(event) => handleDragStart(event, spec.type)}
                onClick={() => handleClickAdd(spec.type)}
                title={spec.description}
                className="cursor-grab border-2 border-ink bg-paper px-2 py-1.5 text-left text-[11px] font-bold text-ink shadow-hard-2 transition-transform duration-100 motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 motion-safe:hover:rotate-[-1.5deg] active:cursor-grabbing"
              >
                {spec.title}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="m-2 mt-auto border-2 border-dashed border-ink bg-bg p-2 text-[11px] font-bold leading-snug text-ink">
        💡 Kéo node vào canvas hoặc chat với AI để dựng workflow
      </div>
    </aside>
  );
}
