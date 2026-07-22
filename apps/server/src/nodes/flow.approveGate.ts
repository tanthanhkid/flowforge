/**
 * `flow.approveGate` (SPEC-step33.md §33c): the human approval gate placed
 * right before `broll.generate` (§33d, not this sub-step) — lets the user
 * review/edit the `CutPlan` an upstream `llm.selectMoments` produced before
 * any b-roll-generation cost is incurred. Not cacheable: it must always
 * park/pass-through fresh, never short-circuit to a stale cached plan.
 *
 * `ctx.awaitApproval` is only present when the Engine was built with a
 * `GateRegistry` (`executor.ts`'s `EngineOptions.gate`) — absent in
 * headless/unit-test runs, in which case this node is a plain pass-through
 * so every non-gate engine test keeps working unchanged.
 */
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({});
type Params = z.infer<typeof ParamsSchema>;

export const flowApproveGateNode: NodeDefinition<Params> = {
  type: 'flow.approveGate',
  category: 'utility',
  title: 'Duyệt bản cắt',
  description: 'Dừng run để người dùng xem/sửa bản cắt (CutPlan) trước khi chạy tiếp.',
  inputs: { plan: { type: 'json', required: true } },
  outputs: { plan: { type: 'json' } },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ inputs, ctx }) => {
    if (!ctx.awaitApproval) {
      return { plan: inputs.plan };
    }
    const approved = await ctx.awaitApproval({ plan: inputs.plan });
    return { plan: approved ?? inputs.plan };
  },
};
