import type { Workflow } from './schema.js';

export interface Graph {
  nodeIds: string[];
  /** node id -> set of node ids that directly depend on it (outgoing edges, deduped) */
  dependents: Map<string, Set<string>>;
  /** node id -> set of node ids it directly depends on (incoming edges, deduped) */
  dependencies: Map<string, Set<string>>;
  /** node id -> number of unique upstream dependencies */
  indegree: Map<string, number>;
}

export function buildGraph(workflow: Workflow): Graph {
  const nodeIds = workflow.nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const dependents = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();

  for (const id of nodeIds) {
    dependents.set(id, new Set());
    dependencies.set(id, new Set());
  }

  for (const edge of workflow.edges) {
    if (!nodeIdSet.has(edge.from.node) || !nodeIdSet.has(edge.to.node)) {
      // Edge referencing an unknown node — ignored here; validateWorkflow() reports it.
      continue;
    }
    dependents.get(edge.from.node)!.add(edge.to.node);
    dependencies.get(edge.to.node)!.add(edge.from.node);
  }

  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    indegree.set(id, dependencies.get(id)!.size);
  }

  return { nodeIds, dependents, dependencies, indegree };
}

/** Kahn's algorithm. Throws if the workflow graph contains a cycle. */
export function topoSort(workflow: Workflow): string[] {
  const graph = buildGraph(workflow);
  const indegree = new Map(graph.indegree);
  const queue: string[] = [];
  for (const id of graph.nodeIds) {
    if ((indegree.get(id) ?? 0) === 0) queue.push(id);
  }

  const order: string[] = [];
  let i = 0;
  while (i < queue.length) {
    const id = queue[i++]!;
    order.push(id);
    for (const next of graph.dependents.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (order.length !== graph.nodeIds.length) {
    throw new Error('Cycle detected in workflow graph');
  }
  return order;
}

/** Returns the node ids participating in a cycle, or null if the graph is acyclic. */
export function detectCycle(workflow: Workflow): string[] | null {
  const graph = buildGraph(workflow);
  const indegree = new Map(graph.indegree);
  const queue: string[] = [];
  for (const id of graph.nodeIds) {
    if ((indegree.get(id) ?? 0) === 0) queue.push(id);
  }

  const visited = new Set<string>();
  let i = 0;
  while (i < queue.length) {
    const id = queue[i++]!;
    visited.add(id);
    for (const next of graph.dependents.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (visited.size === graph.nodeIds.length) return null;

  const remaining = graph.nodeIds.filter((id) => !visited.has(id));
  const remainingSet = new Set(remaining);

  // "remaining" (the set Kahn's algorithm never reached indegree 0 for) is
  // cycle-nodes UNION nodes merely downstream of a cycle — a downstream node
  // never has indegree 0 either, so it stays stuck in the same bucket.
  // Narrow it down via a reverse peel: repeatedly drop any node whose
  // outgoing edges no longer point at another node still in the set. A node
  // strictly downstream of a cycle has no path back into the cycle, so its
  // "downstream-of-cycle" subgraph is itself acyclic and fully peels away;
  // every node still on an actual cycle always retains at least one outgoing
  // edge to a fellow cycle member (which is never peeled), so it survives.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of remainingSet) {
      const hasEdgeWithinRemaining = Array.from(graph.dependents.get(id) ?? []).some((next) => remainingSet.has(next));
      if (!hasEdgeWithinRemaining) {
        remainingSet.delete(id);
        changed = true;
      }
    }
  }

  return remainingSet.size > 0 ? Array.from(remainingSet) : remaining;
}

/** All transitive downstream node ids of nodeId (not including nodeId itself). */
export function descendantsOf(workflow: Workflow, nodeId: string): Set<string> {
  const graph = buildGraph(workflow);
  const result = new Set<string>();
  const stack: string[] = Array.from(graph.dependents.get(nodeId) ?? []);

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const next of graph.dependents.get(id) ?? []) {
      if (!result.has(next)) stack.push(next);
    }
  }

  return result;
}
