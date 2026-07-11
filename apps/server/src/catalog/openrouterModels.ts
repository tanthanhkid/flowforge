/**
 * Curated OpenRouter LLM catalog for `llm.generate` / `llm.transform`'s
 * `model` param (SPEC-step14.md §2). Same shape/spirit as `falModels.ts`:
 * one hand-editable file, a *ranked suggestion list* layered on top of the
 * free-form `model` string param — it never removes the ability to type any
 * OpenRouter model id by hand, it only makes good defaults discoverable.
 *
 * Every `id` below was verified to exist in the public, keyless
 * `GET https://openrouter.ai/api/v1/models` response (fetched once via plain
 * curl, no API key involved) and `cost` was computed straight from that
 * response's `pricing.prompt` / `pricing.completion` (USD per token, so
 * multiplied by 1e6 for "per 1M tokens", rounded to 2 decimals) — see
 * SPEC-step14.md implementation report for the full verification log
 * (including the one id that had to be substituted).
 *
 * `estUsd`/`estBasis` (SPEC-step15.md §1) are the machine-readable twin of
 * `cost`: `estUsd = 0.0008 * inPricePer1M + 0.0005 * outPricePer1M`, i.e. the
 * cost of one typical call at ~800 input / 500 output tokens, computed
 * straight from the same $/1M figures as `cost`.
 */

export interface OpenRouterModelPreset {
  /** Full OpenRouter model id, e.g. "anthropic/claude-sonnet-4.5". */
  id: string;
  /** Short display name. */
  label: string;
  /** 💎 xịn (best) / ✅ khá (good) / 💸 rẻ (cheap). */
  tier: 'xin' | 'kha' | 're';
  /** "$X in / $Y out per 1M tokens", computed from the live pricing API. */
  cost: string;
  /** One-line Vietnamese note: strengths/weaknesses. */
  note?: string;
  kind: 'llm';
  /** Machine-readable estimate (SPEC-step15.md §1) — see file header. */
  estUsd: number;
  /** How `estUsd` was derived, e.g. "per call (~800 in / 500 out tokens)". */
  estBasis: string;
}

const LLM_EST_BASIS = 'per call (~800 in / 500 out tokens)';

export const OPENROUTER_LLM_MODELS: OpenRouterModelPreset[] = [
  // 💎 xịn
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    tier: 'xin',
    cost: '$3 in / $15 out per 1M tokens',
    note: 'Suy luận và viết lách rất tốt, bám instruction chặt, giá cao nhất nhóm',
    kind: 'llm',
    estUsd: 0.0099,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'openai/gpt-5.2',
    label: 'GPT-5.2',
    tier: 'xin',
    cost: '$1.75 in / $14 out per 1M tokens',
    note: 'Model mới nhất của OpenAI, mạnh về suy luận đa bước',
    kind: 'llm',
    estUsd: 0.0084,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    tier: 'xin',
    cost: '$1.25 in / $10 out per 1M tokens',
    note: 'Context dài, mạnh về đa phương thức (ảnh/âm thanh), giá tốt hơn 2 model trên',
    kind: 'llm',
    estUsd: 0.006,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'x-ai/grok-4.5',
    label: 'Grok 4.5',
    tier: 'xin',
    cost: '$2 in / $6 out per 1M tokens',
    note: 'Model mặc định hệ thống hiện tại (OPENROUTER_DEFAULT_MODEL) — để trống params.model sẽ dùng model này',
    kind: 'llm',
    estUsd: 0.0046,
    estBasis: LLM_EST_BASIS,
  },

  // ✅ khá
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    tier: 'kha',
    cost: '$1 in / $5 out per 1M tokens',
    note: 'Nhanh, rẻ hơn Sonnet nhiều nhưng vẫn giữ được văn phong Claude tốt',
    kind: 'llm',
    estUsd: 0.0033,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    tier: 'kha',
    cost: '$0.3 in / $2.5 out per 1M tokens',
    note: 'Rất nhanh, giá rẻ, đủ tốt cho hầu hết tác vụ hàng ngày',
    kind: 'llm',
    estUsd: 0.00149,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'deepseek/deepseek-chat-v3-0324',
    label: 'DeepSeek Chat V3 (0324)',
    tier: 'kha',
    cost: '$0.24 in / $0.9 out per 1M tokens',
    note: 'Chất lượng khá tốt so với giá, mạnh về code và suy luận',
    kind: 'llm',
    estUsd: 0.000642,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick',
    tier: 'kha',
    cost: '$0.15 in / $0.6 out per 1M tokens',
    note: 'Model mã nguồn mở của Meta, đa phương thức, giá rẻ cho chất lượng nhận được',
    kind: 'llm',
    estUsd: 0.00042,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'openai/gpt-5-mini',
    label: 'GPT-5 Mini',
    tier: 'kha',
    cost: '$0.25 in / $2 out per 1M tokens',
    note: 'Bản nhỏ/rẻ hơn của dòng GPT-5, vẫn giữ khá nhiều khả năng suy luận',
    kind: 'llm',
    estUsd: 0.0012,
    estBasis: LLM_EST_BASIS,
  },

  // 💸 rẻ
  {
    id: 'google/gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    tier: 're',
    cost: '$0.1 in / $0.4 out per 1M tokens',
    note: 'Rẻ và nhanh nhất dòng Gemini hiện có trên OpenRouter, hợp việc đơn giản/khối lượng lớn',
    kind: 'llm',
    estUsd: 0.00028,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'qwen/qwen-2.5-72b-instruct',
    label: 'Qwen 2.5 72B Instruct',
    tier: 're',
    cost: '$0.36 in / $0.4 out per 1M tokens',
    note: 'Model mã nguồn mở của Alibaba, giá rẻ, ổn cho tác vụ text thông thường',
    kind: 'llm',
    estUsd: 0.000488,
    estBasis: LLM_EST_BASIS,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B Instruct',
    tier: 're',
    cost: '$0.1 in / $0.32 out per 1M tokens',
    note: 'Rẻ nhất nhóm, mã nguồn mở, đủ dùng cho việc đơn giản/test',
    kind: 'llm',
    estUsd: 0.00024,
    estBasis: LLM_EST_BASIS,
  },
];
