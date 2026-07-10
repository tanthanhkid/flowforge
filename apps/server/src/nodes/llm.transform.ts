/**
 * `llm.transform` (SPEC-step2.md §7): rewrites `text` per a free-form
 * `instruction` via OpenRouter, using a fixed system prompt that keeps the
 * model from adding commentary around the result.
 */
import { z } from 'zod';
import { getEnv } from '../config.js';
import type { NodeDefinition } from '../engine/types.js';
import { chatCompletion, type ChatMessage } from './providers/openrouter.js';

const SYSTEM_PROMPT = 'Bạn là công cụ biến đổi văn bản. Chỉ trả về văn bản kết quả, không giải thích.';

const RawParamsSchema = z.object({
  instruction: z.string().min(1),
  model: z.string().default(''),
  temperature: z.number().default(0.3),
});

// See llm.generate.ts for why this resolves the default `model` via
// z.preprocess (not z.transform) before the engine computes the cache key.
const ParamsSchema = z.preprocess((raw) => {
  const obj: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (!obj.model) obj.model = getEnv('OPENROUTER_DEFAULT_MODEL');
  return obj;
}, RawParamsSchema);
type Params = z.infer<typeof RawParamsSchema>;

export const llmTransformNode: NodeDefinition<Params> = {
  type: 'llm.transform',
  category: 'llm',
  title: 'LLM: Biến đổi văn bản',
  description: 'Biến đổi văn bản đầu vào theo hướng dẫn (instruction) qua OpenRouter.',
  inputs: {
    text: { type: 'text', required: true },
  },
  outputs: { text: { type: 'text' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    // params.model is already resolved (never '') by ParamsSchema's
    // preprocess step above — see llm.generate.ts for why.
    const model = params.model;
    const text = String(inputs.text ?? '');

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Instruction: ${params.instruction}\n\nText:\n${text}` },
    ];

    const result = await chatCompletion({
      model,
      messages,
      temperature: params.temperature,
      signal: ctx.signal,
    });
    return { text: result };
  },
};
