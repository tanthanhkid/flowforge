/**
 * Pure client-side auto-layout (SPEC-step16.md §2). Fixes the "node đè
 * nhau, edge chéo loạn" bug: unlike server `agent/layout.ts` (which only
 * fills in a *missing* position with a rough guess before schema
 * validation), this recomputes every node's position from scratch given the
 * current graph shape, using each node's *real* measured box size when
 * available (React Flow's `node.measured` once rendered) and a sane
 * fallback otherwise.
 *
 * Algorithm: layered by topological depth (Kahn's algorithm / BFS from
 * source nodes — nodes with no incoming edges from another node in the
 * workflow). Cycle-safe: any node that never reaches indegree 0 (because
 * it's part of a cycle, directly or transitively) is dumped into one extra
 * column *after* every node the algorithm did manage to place, rather than
 * looping forever or crashing.
 *
 * Column x: each column's width is the max real (or fallback) width of the
 * nodes placed in it, plus a fixed gap; column n's x is the running sum of
 * every earlier column's width+gap. Row y: nodes within a column are
 * stacked using their real (or fallback) height plus a fixed gap, the whole
 * stack centered around y=0 so a single-column diamond doesn't drift
 * downward as branches are added/removed.
 *
 * Pure: never mutates `wf` or `sizes`, always returns a new Workflow value.
 */
import type { Workflow, WorkflowNode } from '../api/types.ts';

export interface NodeSize {
  width: number;
  height: number;
}

/** Matches NodeCard's fixed `w-[300px]` (SPEC-step16.md §1). */
export const FALLBACK_NODE_WIDTH = 300;
/** A generous guess for a node's collapsed height (header + a couple of ports + badge). */
export const FALLBACK_NODE_HEIGHT = 200;
const COLUMN_GAP = 100;
const ROW_GAP = 60;

function sizeOf(id: string, sizes: Record<string, NodeSize> | undefined): NodeSize {
  const size = sizes?.[id];
  return {
    width: size && size.width > 0 ? size.width : FALLBACK_NODE_WIDTH,
    height: size && size.height > 0 ? size.height : FALLBACK_NODE_HEIGHT,
  };
}

/**
 * Assigns every node a depth (0-based column index) via Kahn's algorithm.
 * Nodes with no in-workflow predecessors start at depth 0; every other
 * node's depth is `1 + max(depth of its direct predecessors)`, propagated
 * outward as predecessors are "removed" from the graph.
 *
 * Any node that's part of a cycle (directly or through another node in a
 * cycle) never has all its predecessors removed, so it's never assigned a
 * depth by the loop below — those are collected into `unresolved` and
 * placed in one extra trailing column after the loop, so the function
 * always terminates and every node ends up with a depth.
 */
function assignDepths(nodes: WorkflowNode[], edges: Workflow['edges']): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const predecessors = new Map<string, Set<string>>();
  const successors = new Map<string, Set<string>>();
  for (const id of ids) {
    predecessors.set(id, new Set());
    successors.set(id, new Set());
  }
  for (const edge of edges) {
    if (!ids.has(edge.from.node) || !ids.has(edge.to.node)) continue;
    predecessors.get(edge.to.node)!.add(edge.from.node);
    successors.get(edge.from.node)!.add(edge.to.node);
  }

  const remainingIndegree = new Map<string, number>();
  for (const id of ids) remainingIndegree.set(id, predecessors.get(id)!.size);

  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ids) {
    if (remainingIndegree.get(id) === 0) {
      depth.set(id, 0);
      queue.push(id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    const d = depth.get(id)!;
    for (const next of successors.get(id)!) {
      const candidate = d + 1;
      if ((depth.get(next) ?? -1) < candidate) depth.set(next, candidate);
      const remaining = remainingIndegree.get(next)! - 1;
      remainingIndegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  // Cycle-safe fallback: anything the loop above never reached (stuck at a
  // positive remaining indegree forever) goes in one trailing column.
  let maxResolvedDepth = -1;
  for (const d of depth.values()) maxResolvedDepth = Math.max(maxResolvedDepth, d);
  const cycleColumn = maxResolvedDepth + 1;
  for (const id of ids) {
    if (!depth.has(id)) depth.set(id, cycleColumn);
  }

  return depth;
}

/** Pure: trả về Workflow mới với `position` được tính lại cho mọi node (SPEC-step16.md §2). */
export function layoutWorkflow(wf: Workflow, sizes?: Record<string, NodeSize>): Workflow {
  const depths = assignDepths(wf.nodes, wf.edges);

  const columns = new Map<number, WorkflowNode[]>();
  for (const node of wf.nodes) {
    const d = depths.get(node.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(node);
  }
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);

  const columnX = new Map<number, number>();
  let x = 0;
  for (const d of sortedDepths) {
    columnX.set(d, x);
    const widths = columns.get(d)!.map((n) => sizeOf(n.id, sizes).width);
    x += Math.max(...widths) + COLUMN_GAP;
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const d of sortedDepths) {
    const colNodes = columns.get(d)!;
    const heights = colNodes.map((n) => sizeOf(n.id, sizes).height);
    const totalHeight = heights.reduce((a, b) => a + b, 0) + ROW_GAP * (colNodes.length - 1);
    let y = -totalHeight / 2;
    for (let i = 0; i < colNodes.length; i++) {
      positions.set(colNodes[i]!.id, { x: columnX.get(d)!, y });
      y += heights[i]! + ROW_GAP;
    }
  }

  return {
    ...wf,
    nodes: wf.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } })),
  };
}
