/**
 * `text.template` (SPEC-step2.md §7): fills `{{a}}`..`{{d}}` slots in a
 * template string from the corresponding optional text inputs. Whitespace
 * inside the braces is tolerated (`{{ a }}`); an unconnected slot input
 * becomes `''`; a slot name that isn't a/b/c/d is left untouched.
 */
import { z } from 'zod';
import type { NodeDefinition } from '../engine/types.js';

const ParamsSchema = z.object({
  template: z.string().min(1),
});
type Params = z.infer<typeof ParamsSchema>;

const SLOT_NAMES = new Set(['a', 'b', 'c', 'd']);
const SLOT_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const textTemplateNode: NodeDefinition<Params> = {
  type: 'text.template',
  category: 'utility',
  title: 'Ghép văn bản theo mẫu',
  description: 'Ghép các đoạn văn bản vào mẫu theo slot {{a}}..{{d}}.',
  inputs: {
    a: { type: 'text', required: false },
    b: { type: 'text', required: false },
    c: { type: 'text', required: false },
    d: { type: 'text', required: false },
  },
  outputs: { text: { type: 'text' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params }) => {
    const text = params.template.replace(SLOT_PATTERN, (match, name: string) => {
      if (!SLOT_NAMES.has(name)) return match;
      const value = inputs[name];
      return value === undefined || value === null ? '' : String(value);
    });
    return { text };
  },
};
