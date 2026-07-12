/**
 * SPEC-step25.md §4 — `agent/patch.ts` is now a thin re-export from
 * `shared` (packages/shared/src/patch.ts). The full case-by-case behavior
 * test suite moved to `packages/shared/test/patch.test.ts` verbatim; this
 * file just smoke-tests that the re-export is alive and imports from the
 * pre-existing `../src/agent/patch.js` path still work for every caller
 * that hasn't changed (chatTurnManager.ts, routes/changes.ts).
 */
import { describe, expect, it } from 'vitest';
import { applyPatch, opScope, PatchError, PatchOpSchema } from '../src/agent/patch.js';
import type { Workflow } from '../src/engine/schema.js';

function baseWorkflow(): Workflow {
  return {
    version: 1,
    id: 'wf-1',
    name: 'Test',
    nodes: [{ id: 'a', type: 'input.text', params: { value: 'hi' } }],
    edges: [],
  };
}

describe('agent/patch.ts (re-export from shared)', () => {
  it('applyPatch applies an op and returns the server Workflow type', () => {
    const wf = baseWorkflow();
    const result = applyPatch(wf, [{ op: 'update-node', nodeId: 'a', label: 'New label' }]);
    expect(result.nodes.find((n) => n.id === 'a')?.label).toBe('New label');
  });

  it('applyPatch on an unknown nodeId throws the re-exported PatchError', () => {
    const wf = baseWorkflow();
    expect(() => applyPatch(wf, [{ op: 'remove-node', nodeId: 'nope' }])).toThrow(PatchError);
  });

  it('PatchOpSchema parses a valid op', () => {
    expect(PatchOpSchema.safeParse({ op: 'move-node', nodeId: 'a', position: { x: 1, y: 2 } }).success).toBe(
      true,
    );
  });

  it('opScope is re-exported and classifies move-node as cosmetic', () => {
    expect(opScope({ op: 'move-node', nodeId: 'a', position: { x: 0, y: 0 } })).toBe('cosmetic');
  });
});
