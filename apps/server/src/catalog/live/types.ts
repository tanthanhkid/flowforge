/**
 * Shared types for the *live* fal.ai / OpenRouter catalog (SPEC-step19.md
 * §1). Kept separate from the static hand-curated catalogs
 * (`../falModels.ts` / `../openrouterModels.ts`) — those remain the source
 * of truth for `note`/`label`/`estUsd` on any model id they cover (see
 * `merge.ts`); this module only adds the *live* long tail on top of them,
 * tiered purely by price.
 */

/** fal.ai category, narrowed to the 3 buckets this catalog cares about. */
export type FalKind = 'image' | 'video-t2v' | 'video-i2v';

/** SPEC-step19.md §1.3 — `'unknown'` added on top of the existing 3 static tiers, for `estUsd === null`. */
export type CatalogTier = 'xin' | 'kha' | 're' | 'unknown';

/**
 * Raw model entry as returned by `fetchOpenRouterCatalog`, pre-tier/merge.
 *
 * `per1MIn`/`per1MOut` are `null` when OpenRouter reports a negative
 * per-token price — its dynamic/auto-router models (e.g. `openrouter/auto`)
 * use `"-1"` as a sentinel meaning "price varies by the model it routes to",
 * not a literal negative price (post-review fix: this used to be parsed
 * literally into a huge negative `estUsd`, e.g. `-1300`, which still sorted
 * into the 💸 "rẻ" tier and rendered as a nonsense "$-1000000/1M" price).
 */
export interface LiveOpenRouterModel {
  id: string;
  label: string;
  /** USD per 1M input tokens; null = price varies per routed-to model (negative sentinel), never a literal negative number. */
  per1MIn: number | null;
  /** USD per 1M output tokens; null = price varies per routed-to model (negative sentinel), never a literal negative number. */
  per1MOut: number | null;
  contextLength: number | null;
  /** epoch ms, from `created` (unix seconds) * 1000. */
  createdAt: number | null;
}

/** Raw model entry as returned by `fetchFalCatalog`, pre-price-parse/merge. */
export interface LiveFalModel {
  id: string;
  label: string;
  kind: FalKind;
  /** epoch ms, parsed from `date`/`publishedAt`. */
  createdAt: number | null;
  /** `shortDescription`, truncated to 120 chars. */
  note?: string;
  /** Raw `pricingInfoOverride` markdown string, possibly empty — parsed by `priceParser.ts`. */
  priceRaw?: string;
}

/** One entry in the unified fal (image/video) catalog served to consumers. */
export interface CatalogFalEntry {
  id: string;
  label: string;
  kind: FalKind;
  tier: CatalogTier;
  /** null = could not be normalized from the live pricing text (SPEC-step19.md §1.2 rule 5) — never a guess. */
  estUsd: number | null;
  estBasis: string;
  note?: string;
  createdAt: number | null;
  /** true = also present in the hand-curated static preset (`../falModels.ts`). */
  featured: boolean;
}

/** One entry in the unified OpenRouter (llm) catalog served to consumers. */
export interface CatalogLlmEntry {
  id: string;
  label: string;
  tier: CatalogTier;
  estUsd: number | null;
  estBasis: string;
  note?: string;
  createdAt: number | null;
  /** true = also present in the hand-curated static preset (`../openrouterModels.ts`). */
  featured: boolean;
  per1MIn?: number;
  per1MOut?: number;
  contextLength?: number | null;
}

export type CatalogSource = 'live' | 'live-stale' | 'static';

export interface CatalogMeta {
  source: CatalogSource;
  /** epoch ms of the underlying live fetch this response is based on; null when source === 'static'. */
  fetchedAt: number | null;
  counts: { falVideo: number; falImage: number; openrouter: number };
}

/** SPEC-step19.md §1.6 — the `getCatalog()` response contract for consumers (routes/costEstimate/fal.video guard/promptBuilder, wired in a later phase). */
export interface UnifiedCatalog {
  falVideo: CatalogFalEntry[];
  falImage: CatalogFalEntry[];
  openrouter: CatalogLlmEntry[];
  meta: CatalogMeta;
}

/**
 * Minimal fetch signature so `fetchOpenRouterCatalog`/`fetchFalCatalog` (and
 * everything built on top of them) are DI-able in tests (SPEC-step19.md
 * §1.4) — no test ever needs to reach the real network or stub
 * `globalThis.fetch`, it can just pass a `fetchImpl` mock straight through.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
