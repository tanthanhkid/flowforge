/**
 * Tier-by-price thresholds (SPEC-step19.md §1.3) — the user's explicit ask
 * ("chia tier theo giá") replaces the old hand-assigned `tier` field on
 * every model, live or static, with one price-based rule per `kind` bucket.
 *
 * Kept as a plain constant so thresholds are easy to tune by hand later —
 * do NOT compute these from data, they're a fixed table.
 *
 *   kind (bucket) | 💎 xin  | ✅ kha        | 💸 rẻ
 *   video (per 5s)| >= 0.75 | 0.20 – 0.75   | < 0.20
 *   image (per ảnh)| >= 0.05 | 0.01 – 0.05  | < 0.01
 *   llm (per call) | >= 0.004| 0.0006–0.004 | < 0.0006
 *
 * Sanity checks (SPEC-step19.md §1.3, verified by tier.test.ts):
 *   Veo3 ≈$2/5s -> xin; Kling 2.1 standard $0.28/5s -> kha;
 *   Claude Sonnet 4.5 $0.0099/call -> xin; a $0 free model -> re.
 */
import type { CatalogTier } from './types.js';

export type TierBucket = 'video' | 'image' | 'llm';

export interface TierThreshold {
  /** estUsd >= xin -> tier 'xin'. */
  xin: number;
  /** xin > estUsd >= kha -> tier 'kha'; estUsd < kha -> tier 're'. */
  kha: number;
}

export const TIER_THRESHOLDS: Record<TierBucket, TierThreshold> = {
  video: { xin: 0.75, kha: 0.2 },
  image: { xin: 0.05, kha: 0.01 },
  llm: { xin: 0.004, kha: 0.0006 },
};

/** `estUsd === null` (or non-finite) -> tier 'unknown' (SPEC-step19.md §1.3) — never guessed into a price tier. */
export function tierForPrice(bucket: TierBucket, estUsd: number | null): CatalogTier {
  if (estUsd === null || !Number.isFinite(estUsd)) return 'unknown';
  const t = TIER_THRESHOLDS[bucket];
  if (estUsd >= t.xin) return 'xin';
  if (estUsd >= t.kha) return 'kha';
  return 're';
}
