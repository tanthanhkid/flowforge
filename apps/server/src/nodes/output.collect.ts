/**
 * `output.collect` (SPEC-step2.md §7): gathers up to 4 arbitrary upstream
 * outputs into a single JSON object, keyed by port name. Not cacheable — it
 * exists purely as a run-time collection point for the UI/preview, not a
 * pure transform worth memoizing.
 */
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({});
type Params = z.infer<typeof ParamsSchema>;

const INPUT_PORTS = ['in1', 'in2', 'in3', 'in4'] as const;

export const outputCollectNode: NodeDefinition<Params> = {
  type: 'output.collect',
  category: 'utility',
  title: 'Gom kết quả',
  description: 'Gom tối đa 4 output đầu vào thành một JSON kết quả.',
  inputs: {
    in1: { type: 'any', required: false },
    in2: { type: 'any', required: false },
    in3: { type: 'any', required: false },
    in4: { type: 'any', required: false },
  },
  outputs: { results: { type: 'json' } },
  paramsSchema: ParamsSchema,
  cacheable: false,
  execute: async ({ inputs }) => {
    const results: Record<string, unknown> = {};
    for (const port of INPUT_PORTS) {
      if (inputs[port] !== undefined) {
        results[port] = inputs[port];
      }
    }
    return { results };
  },
};
