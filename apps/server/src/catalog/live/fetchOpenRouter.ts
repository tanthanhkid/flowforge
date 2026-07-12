/**
 * `fetchOpenRouterCatalog` (SPEC-step19.md §1.1): 1 request against
 * OpenRouter's public, keyless `GET /api/v1/models` — no `OPENROUTER_API_KEY`
 * involved. Filters out non-text-output models (embedding/moderation) and
 * maps the rest to `LiveOpenRouterModel`.
 */
import { fetchJsonWithTimeout } from './httpHelpers.js';
import type { FetchLike, LiveOpenRouterModel } from './types.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_TIMEOUT_MS = 10_000;

interface RawOpenRouterModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  created?: number;
  architecture?: {
    /** Older API shape, e.g. "text->text" / "text+image->text". */
    modality?: string;
    /** Newer API shape. */
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

interface RawOpenRouterResponse {
  data?: RawOpenRouterModel[];
}

/**
 * Excludes embedding/moderation/other non-text-output models — this catalog
 * only lists models usable by `llm.generate`/`llm.transform` (text out).
 * Prefers the structured `architecture` field; falls back to an id-based
 * heuristic when that field is missing entirely (permissive: keeps the
 * model rather than risk hiding a valid one).
 */
function isTextOutputModel(m: RawOpenRouterModel): boolean {
  const arch = m.architecture;
  if (arch?.output_modalities && arch.output_modalities.length > 0) {
    return arch.output_modalities.includes('text');
  }
  if (typeof arch?.modality === 'string' && arch.modality.includes('->')) {
    const output = arch.modality.split('->')[1] ?? '';
    return output.includes('text');
  }
  const id = m.id.toLowerCase();
  return !id.includes('embed') && !id.includes('moderation');
}

/**
 * `pricing.prompt`/`pricing.completion` are USD-per-token strings; converts
 * to USD-per-1M-tokens, defaulting to 0 when missing/unparseable
 * (free/unpriced models).
 *
 * Post-review fix: OpenRouter uses `"-1"` as a sentinel on dynamic/auto-
 * router models (e.g. `openrouter/auto`) to mean "price varies by the model
 * it routes to" — NOT a literal negative price. Parsing it literally turned
 * into a huge negative `per1M*` (`-1,000,000`), which then flowed into
 * `estUsd = 0.0008*per1MIn + 0.0005*per1MOut` (~-1300), sorting into the 💸
 * "rẻ" tier and rendering as "$-1000000/1M" in the picker/prompt/cost
 * estimate. Any negative price (not just exactly -1, in case OpenRouter uses
 * other negative sentinels) is treated as "unknown", same as a missing
 * pricing field elsewhere in this catalog — never guessed into a number.
 */
function parsePricePer1M(raw: string | undefined): number | null {
  const n = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return null;
  return n * 1_000_000;
}

export interface FetchOpenRouterOpts {
  fetchImpl?: FetchLike;
  /** default 10_000 */
  timeoutMs?: number;
}

export async function fetchOpenRouterCatalog(opts: FetchOpenRouterOpts = {}): Promise<LiveOpenRouterModel[]> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const json = await fetchJsonWithTimeout<RawOpenRouterResponse>(OPENROUTER_MODELS_URL, fetchImpl, timeoutMs);
  const data = Array.isArray(json?.data) ? json.data : [];

  return data.filter(isTextOutputModel).map((m) => ({
    id: m.id,
    label: m.name ?? m.id,
    per1MIn: parsePricePer1M(m.pricing?.prompt),
    per1MOut: parsePricePer1M(m.pricing?.completion),
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    createdAt: typeof m.created === 'number' ? m.created * 1000 : null,
  }));
}
