/**
 * `llm.generate` (SPEC-step2.md §7): free-form generation via OpenRouter.
 * `messages` = optional system + a user message built from `prompt` (with an
 * optional `"\n\nContext:\n" + context` suffix).
 */
import { z } from 'zod';
import { getEnv } from '../config.js';
import type { NodeDefinition } from '../engine/types.js';
import { chatCompletion, type ChatMessage } from './providers/openrouter.js';

const RawParamsSchema = z.object({
  model: z.string().default(''),
  system: z.string().default(''),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
});

// Resolve an empty/omitted `model` to OPENROUTER_DEFAULT_MODEL as part of
// param parsing (via z.preprocess, NOT z.transform — a transform makes the
// schema "unrepresentable" for registry.ts's z.toJSONSchema(), which every
// node's paramsSchema must support for the agent layer). This matters
// because the engine computes the cache key from the *parsed* params
// (executor.ts calls paramsSchema.parse() before hashing), before execute()
// ever runs — resolving the default only inside execute() left the cache key
// containing the literal `model: ''`, so changing OPENROUTER_DEFAULT_MODEL
// and re-running silently replayed the old model's cached output.
const ParamsSchema = z.preprocess((raw) => {
  const obj: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (!obj.model) obj.model = getEnv('OPENROUTER_DEFAULT_MODEL');
  return obj;
}, RawParamsSchema);
type Params = z.infer<typeof RawParamsSchema>;

export const llmGenerateNode: NodeDefinition<Params> = {
  type: 'llm.generate',
  category: 'llm',
  title: 'LLM: Sinh văn bản',
  description: 'Sinh văn bản từ prompt qua OpenRouter.',
  inputs: {
    prompt: { type: 'text', required: true },
    context: { type: 'text', required: false },
  },
  outputs: { text: { type: 'text' } },
  paramsSchema: ParamsSchema,
  execute: async ({ inputs, params, ctx }) => {
    // params.model is already resolved (never '') by ParamsSchema's
    // preprocess step above, so the cache key and the actual request always
    // agree on which model was used.
    const model = params.model;
    const prompt = String(inputs.prompt ?? '');
    const context = inputs.context !== undefined && inputs.context !== null ? String(inputs.context) : '';

    const messages: ChatMessage[] = [];
    if (params.system) messages.push({ role: 'system', content: params.system });
    messages.push({ role: 'user', content: context ? `${prompt}\n\nContext:\n${context}` : prompt });

    const text = await chatCompletion({
      model,
      messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: ctx.signal,
    });
    return { text };
  },
};
