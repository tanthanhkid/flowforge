/**
 * `input.text` (SPEC-step2.md §7): emits a fixed text value entered by the
 * user. No inputs — this is a source node.
 */
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  value: z.string().default(''),
});
type Params = z.infer<typeof ParamsSchema>;

export const inputTextNode: NodeDefinition<Params> = {
  type: 'input.text',
  category: 'utility',
  title: 'Văn bản nhập tay',
  description: 'Giá trị văn bản cố định do người dùng nhập.',
  inputs: {},
  outputs: { text: { type: 'text' } },
  paramsSchema: ParamsSchema,
  execute: async ({ params }) => {
    return { text: params.value };
  },
};
