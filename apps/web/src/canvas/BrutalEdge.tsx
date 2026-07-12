/**
 * SPEC-step18.md §5.4 — custom edge: a solid black "outline" path underneath
 * a colored path on top, so a low-contrast edge color (lime/yellow against
 * the cream canvas — spec §6.2, giám khảo bắt buộc) is still always readable.
 * The black layer also carries the arrowhead (`markerEnd`, set by FlowCanvas
 * to React Flow's built-in `MarkerType.ArrowClosed` colored black) so the
 * marker reads the same regardless of the edge's own port color.
 *
 * `data.targetRunning` (resolved by FlowCanvas from the live `nodeRuns` map
 * — a bare `EdgeProps` has no notion of the target node's run state on its
 * own) puts a moving dash (`ff-dash`, defined in index.css, neutralized
 * under `prefers-reduced-motion`) on the colored path only, so an edge
 * feeding a `running` node visibly "flows" toward it.
 *
 * SPEC-step26.md §3 — a freshly `add-edge`'d edge (this turn's optimistic
 * highlight, store/chat.ts's `opHighlights`, cleared on `onDone`) instead
 * plays a one-shot "draw" animation (`.ff-edge-draw`, index.css) on the
 * colored path: reuses the very `ff-dash` keyframe above, just a single
 * ~300ms pass instead of an infinite loop, per the spec's "tái dùng pattern
 * ff-dash nếu có". Read directly off the chat store (same pattern as
 * NodeCard.tsx's own highlight lookup) rather than threaded through
 * FlowCanvas's edge `data`, since it's transient UI-only state, unrelated to
 * the edge's actual port-color/running-state data.
 */
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { useChatStore } from '../store/chat.ts';

export interface BrutalEdgeData extends Record<string, unknown> {
  color: string;
  targetRunning: boolean;
}

/** Mirrors NodeCard.tsx's `NodeProps<FlowNode>` pattern — a properly-typed `data` beats an `as` cast on a widened default. */
export type BrutalEdgeType = Edge<BrutalEdgeData, 'brutal'>;

export function BrutalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<BrutalEdgeType>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = data?.color ?? '#0D0D0D';
  const targetRunning = data?.targetRunning ?? false;
  const highlight = useChatStore((s) => s.opHighlights[id]);
  const edgeAdded = highlight?.kind === 'edge-added';

  const outlineWidth = selected ? 7 : 5;
  const colorWidth = selected ? 5 : 3;

  return (
    <>
      {/* Black outline layer — carries the arrowhead, no separate hit-test area (the colored layer on top owns it). */}
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        interactionWidth={0}
        style={{ stroke: '#0D0D0D', strokeWidth: outlineWidth, strokeLinecap: 'round' }}
      />
      {/* Colored layer on top — this is the one the user actually clicks/hovers. */}
      <BaseEdge
        // See the NodeCard.tsx `key` comment for why: forces the one-shot
        // draw animation to replay if this exact edge id somehow gets
        // re-highlighted (a fresh `nonce`) before the previous highlight
        // cleared.
        key={edgeAdded ? `hl-${highlight?.nonce}` : 'base'}
        path={path}
        className={edgeAdded ? 'ff-edge-draw' : undefined}
        style={{
          stroke: color,
          strokeWidth: colorWidth,
          strokeLinecap: 'round',
          // `edgeAdded`'s one-shot draw (the `.ff-edge-draw` class above)
          // takes priority over the infinite `targetRunning` loop when both
          // are true — a newly-added edge whose target happens to already
          // be `running` is a rare coincidence, and an inline `style`
          // `animation` here would otherwise win the cascade over the
          // class's, fighting it for the same CSS property.
          ...(!edgeAdded && targetRunning ? { strokeDasharray: '8 6', animation: 'ff-dash 0.6s linear infinite' } : {}),
        }}
      />
    </>
  );
}
