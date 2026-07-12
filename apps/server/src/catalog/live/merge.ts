/**
 * Merges live-fetched entries with the hand-curated static presets
 * (SPEC-step19.md §1.5): a preset id present in the live fetch is upgraded
 * to `featured: true` and keeps the preset's own `label`/`note`/`estUsd`/
 * `estBasis` (hand-verified — more trustworthy than the regex-parsed live
 * price/label). Only `tier` is *recomputed* from that `estUsd` for every
 * entry (live or static), so the whole catalog — old hand-tiered presets
 * included — uses the one price-based threshold table (`tier.ts`); this is
 * what makes the §1.3 sanity checks apply uniformly.
 *
 * Presets absent from the live fetch are still kept (e.g. the live fetch
 * temporarily failed to include them, or fal.ai delisted an id that was
 * previously hand-verified) — `createdAt` just falls back to null for
 * those. Live-only entries (no matching preset) are included with
 * `featured: false`.
 *
 * Within each tier, featured entries sort first, then newest first — a
 * reasonable default ordering for consumers; the web picker (SPEC-step19.md
 * §2, later phase) is free to re-sort/group as it sees fit.
 */
import type { FalModelPreset } from '../falModels.js';
import type { OpenRouterModelPreset } from '../openrouterModels.js';
import { parseFalPrice } from './priceParser.js';
import { tierForPrice } from './tier.js';
import type { CatalogFalEntry, CatalogLlmEntry, CatalogTier, FalKind, LiveFalModel, LiveOpenRouterModel } from './types.js';

/** SPEC-step15.md §1 formula, restated here (see ../openrouterModels.ts header) — per call at ~800 in / 500 out tokens. */
const LLM_EST_BASIS = 'per call (~800 in / 500 out tokens)';

/** Post-review fix — a live-only model whose per-token price is OpenRouter's negative "varies by routed model" sentinel (`fetchOpenRouter.ts`'s `parsePricePer1M`) never gets a computed `estUsd`; this basis string surfaces why instead of silently showing "?". */
const DYNAMIC_ROUTER_BASIS = 'giá động theo model đích (router tự chọn model, không có đơn giá cố định)';

const TIER_ORDER: Record<CatalogTier, number> = { xin: 0, kha: 1, re: 2, unknown: 3 };

function falTierBucket(kind: FalKind): 'video' | 'image' {
  return kind === 'image' ? 'image' : 'video';
}

function sortEntries<T extends { tier: CatalogTier; featured: boolean; createdAt: number | null }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}

export function mergeFalCatalog(liveEntries: LiveFalModel[], presets: FalModelPreset[]): CatalogFalEntry[] {
  const liveById = new Map(liveEntries.map((m) => [m.id, m]));
  const presetIds = new Set(presets.map((p) => p.id));

  const merged: CatalogFalEntry[] = presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    tier: tierForPrice(falTierBucket(preset.kind), preset.estUsd),
    estUsd: preset.estUsd,
    estBasis: preset.estBasis,
    note: preset.note,
    createdAt: liveById.get(preset.id)?.createdAt ?? null,
    featured: true,
  }));

  for (const live of liveEntries) {
    if (presetIds.has(live.id)) continue;
    const { estUsd, estBasis } = parseFalPrice(live.priceRaw, live.kind);
    merged.push({
      id: live.id,
      label: live.label,
      kind: live.kind,
      tier: tierForPrice(falTierBucket(live.kind), estUsd),
      estUsd,
      estBasis,
      note: live.note,
      createdAt: live.createdAt,
      featured: false,
    });
  }

  return sortEntries(merged);
}

export function mergeLlmCatalog(liveEntries: LiveOpenRouterModel[], presets: OpenRouterModelPreset[]): CatalogLlmEntry[] {
  const liveById = new Map(liveEntries.map((m) => [m.id, m]));
  const presetIds = new Set(presets.map((p) => p.id));

  const merged: CatalogLlmEntry[] = presets.map((preset) => {
    const live = liveById.get(preset.id);
    return {
      id: preset.id,
      label: preset.label,
      tier: tierForPrice('llm', preset.estUsd),
      estUsd: preset.estUsd,
      estBasis: preset.estBasis,
      note: preset.note,
      createdAt: live?.createdAt ?? null,
      featured: true,
      per1MIn: live?.per1MIn ?? undefined,
      per1MOut: live?.per1MOut ?? undefined,
      contextLength: live?.contextLength ?? null,
    };
  });

  for (const live of liveEntries) {
    if (presetIds.has(live.id)) continue;
    // Post-review fix: per1MIn/per1MOut are null when fetchOpenRouter.ts's
    // parsePricePer1M hit a negative-price sentinel (OpenRouter's dynamic/
    // auto-router models, e.g. openrouter/auto) — the step15 formula must
    // not run on that (it would silently produce a large negative number),
    // so estUsd stays null/unknown, same as an unparseable fal price.
    const hasKnownPricing = live.per1MIn !== null && live.per1MOut !== null;
    const estUsd = hasKnownPricing ? 0.0008 * live.per1MIn! + 0.0005 * live.per1MOut! : null;
    merged.push({
      id: live.id,
      label: live.label,
      tier: tierForPrice('llm', estUsd),
      estUsd,
      estBasis: hasKnownPricing ? LLM_EST_BASIS : DYNAMIC_ROUTER_BASIS,
      createdAt: live.createdAt,
      featured: false,
      per1MIn: live.per1MIn ?? undefined,
      per1MOut: live.per1MOut ?? undefined,
      contextLength: live.contextLength,
    });
  }

  return sortEntries(merged);
}
