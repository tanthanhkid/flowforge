/**
 * PatchOp schema + `applyPatch` (SPEC-step5.md §3): the JSON patch format
 * `editNode.ts` asks the LLM to return, and a pure function to apply it onto
 * a `Workflow`.
 */
import { z } from 'zod';
import type { Workflow } from '../engine/schema.js';

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update-node'),
    nodeId: z.string(),
    // Merged key-by-key into the node's existing params — NOT a wholesale
    // replacement, so the LLM only has to specify the params it wants to
    // change.
    params: z.record(z.string(), z.unknown()).optional(),
    label: z.string().optional(),
  }),
  z.object({
    op: z.literal('add-node'),
    node: z.object({
      id: z.string(),
      type: z.string(),
      params: z.record(z.string(), z.unknown()).default({}),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      label: z.string().optional(),
    }),
  }),
  // Removes the node and every edge attached to it (either endpoint).
  z.object({ op: z.literal('remove-node'), nodeId: z.string() }),
  z.object({
    op: z.literal('add-edge'),
    edge: z.object({
      id: z.string(),
      from: z.object({ node: z.string(), port: z.string() }),
      to: z.object({ node: z.string(), port: z.string() }),
    }),
  }),
  z.object({ op: z.literal('remove-edge'), edgeId: z.string() }),
  // SPEC-step21.md §2: cosmetic op for dragging a node — the LLM is never
  // told about this op (buildChatSystemPrompt/buildEditSystemPrompt don't
  // mention it), but a stray one in an LLM response is still valid input.
  z.object({
    op: z.literal('move-node'),
    nodeId: z.string(),
    position: z.object({ x: z.number(), y: z.number() }),
  }),
]);

export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchOpArraySchema = z.array(PatchOpSchema);

/** Thrown by `applyPatch` when an op references a node/edge id that doesn't
 * exist (update-node/remove-node/remove-edge) or that already exists
 * (add-node/add-edge). Carries the 0-based index of the offending op within
 * the ops array so the caller can surface it back to the LLM. */
export class PatchError extends Error {
  readonly opIndex: number;

  constructor(message: string, opIndex: number) {
    super(`Patch op #${opIndex}: ${message}`);
    this.name = 'PatchError';
    this.opIndex = opIndex;
  }
}

/**
 * Applies `ops` in order onto `workflow`, returning a brand-new `Workflow`.
 * Pure: `workflow` (and every object/array reachable from it) is never
 * mutated — every node/edge touched by an op is deep-cloned first, and the
 * `nodes`/`edges` arrays are rebuilt rather than mutated in place.
 *
 * Throws `PatchError` (naming the op's index) on the first structurally
 * invalid op: a nodeId/edgeId that doesn't exist where one is expected, or
 * one that already exists where a fresh id is expected. Does NOT re-run
 * `validateWorkflow()` — the caller (editNode.ts) does that afterwards so
 * type-mismatch / missing-required-input / cycle issues go through the same
 * retry-and-report-to-LLM path as generateWorkflow.ts.
 */
export function applyPatch(workflow: Workflow, ops: PatchOp[]): Workflow {
  let nodes = workflow.nodes.map((node) => ({
    ...node,
    params: { ...node.params },
    ...(node.position ? { position: { ...node.position } } : {}),
  }));
  let edges = workflow.edges.map((edge) => ({
    ...edge,
    from: { ...edge.from },
    to: { ...edge.to },
  }));

  ops.forEach((op, index) => {
    switch (op.op) {
      case 'update-node': {
        const idx = nodes.findIndex((n) => n.id === op.nodeId);
        if (idx === -1) {
          throw new PatchError(`update-node: node "${op.nodeId}" không tồn tại`, index);
        }
        const node = nodes[idx]!;
        const mergedParams = op.params ? { ...node.params, ...op.params } : node.params;
        const updated = { ...node, params: mergedParams };
        if (op.label !== undefined) updated.label = op.label;
        nodes = [...nodes.slice(0, idx), updated, ...nodes.slice(idx + 1)];
        break;
      }

      case 'add-node': {
        if (nodes.some((n) => n.id === op.node.id)) {
          throw new PatchError(`add-node: node "${op.node.id}" đã tồn tại`, index);
        }
        nodes = [...nodes, { ...op.node, params: { ...op.node.params } }];
        break;
      }

      case 'remove-node': {
        if (!nodes.some((n) => n.id === op.nodeId)) {
          throw new PatchError(`remove-node: node "${op.nodeId}" không tồn tại`, index);
        }
        nodes = nodes.filter((n) => n.id !== op.nodeId);
        edges = edges.filter((e) => e.from.node !== op.nodeId && e.to.node !== op.nodeId);
        break;
      }

      case 'add-edge': {
        if (edges.some((e) => e.id === op.edge.id)) {
          throw new PatchError(`add-edge: edge "${op.edge.id}" đã tồn tại`, index);
        }
        if (!nodes.some((n) => n.id === op.edge.from.node)) {
          throw new PatchError(
            `add-edge: source node "${op.edge.from.node}" không tồn tại`,
            index,
          );
        }
        if (!nodes.some((n) => n.id === op.edge.to.node)) {
          throw new PatchError(`add-edge: target node "${op.edge.to.node}" không tồn tại`, index);
        }
        edges = [
          ...edges,
          { ...op.edge, from: { ...op.edge.from }, to: { ...op.edge.to } },
        ];
        break;
      }

      case 'remove-edge': {
        if (!edges.some((e) => e.id === op.edgeId)) {
          throw new PatchError(`remove-edge: edge "${op.edgeId}" không tồn tại`, index);
        }
        edges = edges.filter((e) => e.id !== op.edgeId);
        break;
      }

      case 'move-node': {
        const idx = nodes.findIndex((n) => n.id === op.nodeId);
        if (idx === -1) {
          throw new PatchError(`move-node: node "${op.nodeId}" không tồn tại`, index);
        }
        const node = nodes[idx]!;
        const updated = { ...node, position: { ...op.position } };
        nodes = [...nodes.slice(0, idx), updated, ...nodes.slice(idx + 1)];
        break;
      }
    }
  });

  return { ...workflow, nodes, edges };
}

/**
 * SPEC-step21.md §2 — classifies a single op for change-tracking purposes:
 * `move-node` only touches layout (no logic impact), everything else is
 * `structural` (affects what the workflow actually does, so it belongs in
 * the digest sent back to the LLM — see changeDigest.ts).
 */
export function opScope(op: PatchOp): 'structural' | 'cosmetic' {
  return op.op === 'move-node' ? 'cosmetic' : 'structural';
}

/**
 * A change (one `applyPatch()` call, possibly several ops) is `cosmetic`
 * only when EVERY op in it is cosmetic — a single structural op anywhere in
 * the batch makes the whole change structural. An empty array counts as
 * `cosmetic` (vacuously true; there's nothing structural to hide from the
 * digest, and this keeps `changeScope([])` from needing a special case at
 * call sites).
 */
export function changeScope(ops: PatchOp[]): 'structural' | 'cosmetic' {
  return ops.every((op) => opScope(op) === 'cosmetic') ? 'cosmetic' : 'structural';
}
