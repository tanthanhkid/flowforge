/**
 * SPEC-step25.md §4 — smoke test that `apps/web` can import the PatchOp
 * domain from `shared` (packages/shared, workspace dependency) and that
 * `applyPatch` works against the web's own `Workflow` type (api/types.ts,
 * mirrored from the server but a structurally-identical, nominally distinct
 * type) with no cast needed at the call site (see `WorkflowShape` /
 * `applyPatch`'s generic signature in packages/shared/src/patch.ts).
 */
import { describe, expect, it } from 'vitest';
import { applyPatch } from 'shared';
import type { Workflow } from '../src/api/types.ts';

function emptyWorkflow(): Workflow {
  return { version: 1, id: 'wf-empty', name: 'Empty', nodes: [], edges: [] };
}

describe('shared import (apps/web)', () => {
  it('applyPatch adds a node onto an empty web Workflow', () => {
    const wf = emptyWorkflow();
    const result = applyPatch(wf, [
      { op: 'add-node', node: { id: 'a', type: 'input.text', params: { value: 'hi' } } },
    ]);
    expect(result.nodes).toEqual([{ id: 'a', type: 'input.text', params: { value: 'hi' } }]);
    // Purity: the original empty workflow is untouched.
    expect(wf.nodes).toEqual([]);
  });
});
