/**
 * `autoLayout` (SPEC-step5.md §2, file list): fills in `position` for any
 * node that's missing one, placing it at `x = depth * 380, y = index * 240`
 * where `depth` is the node's longest-path distance from a source node (a
 * node with no incoming edges) and `index` is its 0-based order among other
 * nodes sharing that depth (in original node-array order).
 *
 * SPEC-step16.md §3: bumped from the original 280/150 spacing — that assumed
 * a node was roughly 280px wide, but NodeCard is a fixed 300px box (plus
 * ports/preview can push its height past 150px), so the old spacing let
 * freshly-generated nodes overlap before the client ever got a chance to
 * fix them up (client `canvas/layout.ts`'s `layoutWorkflow`, run
 * automatically after a successful ✨ generate, does the precise job with
 * real measured sizes — this is just a coarser pre-validation nudge so
 * positions aren't already on top of each other).
 *
 * Runs *before* `validateWorkflow()` in the generate/edit retry loop
 * (SPEC-step5.md §4), on a JSON value that hasn't been schema-validated yet
 * — it may be missing `nodes`/`edges` entirely, contain malformed edges, or
 * even describe a cyclic graph. It must never throw; anything it can't make
 * sense of it just passes through untouched so `validateWorkflow()` gets the
 * chance to report a proper, LLM-actionable issue instead of a stack trace.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nodeIdOf(node: unknown): string | undefined {
  if (!isPlainObject(node)) return undefined;
  return typeof node.id === 'string' ? node.id : undefined;
}

/** Builds `nodeId -> Set(direct predecessor nodeIds)` from `edges`, ignoring
 * any edge that doesn't reference two known node ids (malformed edges are
 * validateWorkflow()'s job to report, not autoLayout()'s). */
function buildDependencyMap(nodeIds: Set<string>, edgesRaw: unknown[]): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const id of nodeIds) deps.set(id, new Set());

  for (const e of edgesRaw) {
    if (!isPlainObject(e)) continue;
    const from = isPlainObject(e.from) ? e.from : undefined;
    const to = isPlainObject(e.to) ? e.to : undefined;
    const fromNode = from && typeof from.node === 'string' ? from.node : undefined;
    const toNode = to && typeof to.node === 'string' ? to.node : undefined;
    if (fromNode && toNode && nodeIds.has(fromNode) && nodeIds.has(toNode)) {
      deps.get(toNode)!.add(fromNode);
    }
  }

  return deps;
}

/** Longest-path depth from any source node, memoized. `stack` guards against
 * infinite recursion on a cyclic graph — a node revisited within its own
 * ancestor chain just contributes depth 0 rather than recursing forever. */
function makeDepthResolver(deps: Map<string, Set<string>>): (id: string) => number {
  const cache = new Map<string, number>();

  function depthOf(id: string, stack: Set<string>): number {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0;

    stack.add(id);
    let maxParentDepth = -1;
    for (const parent of deps.get(id) ?? []) {
      maxParentDepth = Math.max(maxParentDepth, depthOf(parent, stack));
    }
    stack.delete(id);

    const depth = maxParentDepth + 1;
    cache.set(id, depth);
    return depth;
  }

  return (id: string) => depthOf(id, new Set());
}

export function autoLayout(workflow: unknown): unknown {
  if (!isPlainObject(workflow)) return workflow;

  const nodesRaw = workflow.nodes;
  if (!Array.isArray(nodesRaw)) return workflow;
  const edgesRaw = Array.isArray(workflow.edges) ? workflow.edges : [];

  const nodeIds = new Set<string>();
  for (const node of nodesRaw) {
    const id = nodeIdOf(node);
    if (id !== undefined) nodeIds.add(id);
  }

  const deps = buildDependencyMap(nodeIds, edgesRaw);
  const depthOf = makeDepthResolver(deps);

  const indexByDepth = new Map<number, number>();
  const nodes = nodesRaw.map((node) => {
    if (!isPlainObject(node)) return node;
    if (isPlainObject(node.position)) return node;

    const id = nodeIdOf(node);
    const depth = id !== undefined ? depthOf(id) : 0;
    const index = indexByDepth.get(depth) ?? 0;
    indexByDepth.set(depth, index + 1);

    return { ...node, position: { x: depth * 380, y: index * 240 } };
  });

  return { ...workflow, nodes };
}
