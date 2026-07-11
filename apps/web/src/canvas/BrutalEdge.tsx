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
 */
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export interface BrutalEdgeData extends Record<string, unknown> {
  color: string;
  targetRunning: boolean;
}

/** Mirrors NodeCard.tsx's `NodeProps<FlowNode>` pattern — a properly-typed `data` beats an `as` cast on a widened default. */
export type BrutalEdgeType = Edge<BrutalEdgeData, 'brutal'>;

export function BrutalEdge({
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
        path={path}
        style={{
          stroke: color,
          strokeWidth: colorWidth,
          strokeLinecap: 'round',
          ...(targetRunning ? { strokeDasharray: '8 6', animation: 'ff-dash 0.6s linear infinite' } : {}),
        }}
      />
    </>
  );
}
