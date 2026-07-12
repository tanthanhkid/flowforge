/**
 * SPEC-step5.md §7 — agent-patch.test.ts. Moved verbatim to
 * `packages/shared/test/patch.test.ts` by SPEC-step25.md §4 (same
 * assertions, same case count — only the import path and the
 * `baseWorkflow()` helper's type changed, from the server's zod-derived
 * `Workflow` to a plain object shaped like `WorkflowShape`, since `shared`
 * doesn't depend on the server's engine/schema.ts). Each PatchOp variant +
 * purity + error-on-bad-reference (with the offending op index).
 */
import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  changeScope,
  opScope,
  PatchError,
  type PatchOp,
  type WorkflowShape,
} from '../src/patch.js';

function baseWorkflow(): WorkflowShape & { version: 1; id: string; name: string } {
  return {
    version: 1,
    id: 'wf-1',
    name: 'Test',
    nodes: [
      { id: 'a', type: 'input.text', params: { value: 'hi' } },
      { id: 'b', type: 'llm.generate', params: { temperature: 0.7, model: 'x' } },
    ],
    edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }],
  };
}

describe('applyPatch', () => {
  it('update-node: merges params key-by-key (does not replace the whole object)', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [{ op: 'update-node', nodeId: 'b', params: { temperature: 0.9 } }]);
    const node = result.nodes.find((n) => n.id === 'b');
    expect(node?.params).toEqual({ temperature: 0.9, model: 'x' });
  });

  it('update-node: also updates label when provided', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [{ op: 'update-node', nodeId: 'a', label: 'New label' }]);
    const node = result.nodes.find((n) => n.id === 'a');
    expect(node?.label).toBe('New label');
    expect(node?.params).toEqual({ value: 'hi' });
  });

  it('add-node: appends a new node', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [
      { op: 'add-node', node: { id: 'c', type: 'output.collect', params: {} } },
    ]);
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('remove-node: removes the node AND every edge attached to it', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [{ op: 'remove-node', nodeId: 'b' }]);
    expect(result.nodes.map((n) => n.id)).toEqual(['a']);
    expect(result.edges).toEqual([]);
  });

  it('add-edge: appends a new edge', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [
      {
        op: 'add-edge',
        edge: { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'a', port: 'text' } },
      },
    ]);
    expect(result.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('remove-edge: removes the edge by id', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [{ op: 'remove-edge', edgeId: 'e1' }]);
    expect(result.edges).toEqual([]);
  });

  it('update-node on an unknown nodeId throws PatchError carrying the op index', () => {
    const wf = baseWorkflow();
    try {
      applyPatch(wf, [
        { op: 'update-node', nodeId: 'a', label: 'ok' },
        { op: 'update-node', nodeId: 'nope', params: {} },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
    }
  });

  it('remove-node on an unknown nodeId throws PatchError', () => {
    const wf = baseWorkflow();
    expect(() => applyPatch(wf, [{ op: 'remove-node', nodeId: 'nope' }])).toThrow(PatchError);
  });

  it('remove-edge on an unknown edgeId throws PatchError', () => {
    const wf = baseWorkflow();
    expect(() => applyPatch(wf, [{ op: 'remove-edge', edgeId: 'nope' }])).toThrow(PatchError);
  });

  it('add-edge referencing an unknown node throws PatchError carrying the op index', () => {
    const wf = baseWorkflow();
    try {
      applyPatch(wf, [
        { op: 'update-node', nodeId: 'a', label: 'ok' },
        {
          op: 'add-edge',
          edge: { id: 'e9', from: { node: 'ghost', port: 'text' }, to: { node: 'b', port: 'context' } },
        },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
    }
  });

  it('add-node with a duplicate id throws PatchError', () => {
    const wf = baseWorkflow();
    expect(() =>
      applyPatch(wf, [{ op: 'add-node', node: { id: 'a', type: 'input.text', params: {} } }]),
    ).toThrow(PatchError);
  });

  it('add-edge with a duplicate id throws PatchError', () => {
    const wf = baseWorkflow();
    expect(() =>
      applyPatch(wf, [
        { op: 'add-edge', edge: { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'context' } } },
      ]),
    ).toThrow(PatchError);
  });

  it('is pure: the input workflow (and nested nodes/edges) is never mutated', () => {
    const wf = baseWorkflow();
    const snapshot = JSON.parse(JSON.stringify(wf));
    applyPatch(wf, [
      { op: 'update-node', nodeId: 'a', params: { value: 'changed' } },
      { op: 'add-node', node: { id: 'c', type: 'output.collect', params: {} } },
      { op: 'remove-edge', edgeId: 'e1' },
    ]);
    expect(wf).toEqual(snapshot);
  });

  // SPEC-step21.md §2 — move-node op.
  it('move-node: sets the node position, purely', () => {
    const wf = baseWorkflow();
    const snapshot = JSON.parse(JSON.stringify(wf));
    const result = applyPatch(wf, [{ op: 'move-node', nodeId: 'a', position: { x: 140, y: 260 } }]);
    expect(result.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 140, y: 260 });
    expect(wf).toEqual(snapshot);
  });

  it('move-node on an unknown nodeId throws PatchError carrying the op index', () => {
    const wf = baseWorkflow();
    try {
      applyPatch(wf, [
        { op: 'update-node', nodeId: 'a', label: 'ok' },
        { op: 'move-node', nodeId: 'nope', position: { x: 0, y: 0 } },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
    }
  });
});

// SPEC-step21.md §2 — opScope/changeScope.
describe('opScope / changeScope', () => {
  const addNode: PatchOp = { op: 'add-node', node: { id: 'x', type: 'input.text', params: {} } };
  const moveNode: PatchOp = { op: 'move-node', nodeId: 'x', position: { x: 0, y: 0 } };

  it('opScope: move-node is cosmetic, every other op is structural', () => {
    expect(opScope(moveNode)).toBe('cosmetic');
    expect(opScope(addNode)).toBe('structural');
    expect(opScope({ op: 'remove-node', nodeId: 'x' })).toBe('structural');
    expect(opScope({ op: 'update-node', nodeId: 'x' })).toBe('structural');
    expect(opScope({ op: 'add-edge', edge: { id: 'e', from: { node: 'a', port: 'p' }, to: { node: 'b', port: 'q' } } })).toBe(
      'structural',
    );
    expect(opScope({ op: 'remove-edge', edgeId: 'e' })).toBe('structural');
  });

  it('changeScope: an empty array is cosmetic', () => {
    expect(changeScope([])).toBe('cosmetic');
  });

  it('changeScope: all-cosmetic ops -> cosmetic', () => {
    expect(changeScope([moveNode, moveNode])).toBe('cosmetic');
  });

  it('changeScope: a mix of cosmetic and structural ops -> structural', () => {
    expect(changeScope([moveNode, addNode])).toBe('structural');
  });

  it('changeScope: all-structural ops -> structural', () => {
    expect(changeScope([addNode])).toBe('structural');
  });
});
