/**
 * fal.ai image t2i/i2i classification (SPEC-step29.md §3), extracted out of
 * `fal.image.ts` (SPEC-step33.md §33d "Guard extraction (plan-verify H2)")
 * so `broll.generate` (SPEC-step33.md §33d) can reuse the same
 * catalog-lookup + suggestion logic without duplicating it. Behavior is
 * byte-identical to the pre-extraction private functions in `fal.image.ts` —
 * only the module location changed.
 */
import { FAL_IMAGE_MODELS } from '../catalog/falModels.js';
import type { CatalogFalEntry } from '../catalog/live/types.js';

/**
 * Pushed by `routes/modelCatalog.ts` after every `getCatalog()`/
 * `refreshCatalog()` call (SPEC-step29.md §3, mirroring `fal.video.ts`'s
 * `setFalVideoLiveCatalog`) so the t2i/i2i guard below also recognizes
 * fal.ai image models outside the static preset list. `undefined` (the
 * default, and what every test that never calls this keeps getting) -> the
 * guard falls back to static-preset-only knowledge.
 */
let liveImageCatalog: CatalogFalEntry[] | undefined;

export function setLiveImageCatalog(entries: CatalogFalEntry[] | undefined): void {
  liveImageCatalog = entries;
}

/** Static preset first, then the live-merged catalog snapshot (if pushed) — undefined means truly unknown to both (custom/uncatalogued model ids are left alone, same rationale as `fal.video.ts`'s `findKind`). */
export function findImageKind(modelId: string): 't2i' | 'i2i' | undefined {
  const preset = FAL_IMAGE_MODELS.find((m) => m.id === modelId);
  if (preset?.imageKind) return preset.imageKind;
  return liveImageCatalog?.find((m) => m.id === modelId)?.imageKind;
}

/**
 * SPEC-step29.md §3 — up to 2 `imageKind === 'i2i'` suggestions for the
 * guard's error message. Unlike `fal.video.ts`'s same-family-prefix
 * heuristic, the image family doesn't name t2i/i2i siblings as path pairs,
 * so this just takes the first matches from: static presets first (in their
 * declared 💎/✅/💸 tier order), then the live-merged catalog snapshot
 * (already tier/featured/newest-sorted by `catalog/live/merge.ts`). Empty
 * when neither has one — the caller then omits the suggestion clause.
 */
export function suggestI2IModels(): string[] {
  const presetMatches = FAL_IMAGE_MODELS.filter((m) => m.imageKind === 'i2i').map((m) => m.id);
  if (presetMatches.length > 0) return presetMatches.slice(0, 2);
  const liveMatches = liveImageCatalog?.filter((m) => m.imageKind === 'i2i').map((m) => m.id) ?? [];
  return liveMatches.slice(0, 2);
}

/**
 * SPEC-step33.md §33d — up to 2 `imageKind === 't2i'` suggestions, for
 * `broll.generate`'s guard (the OPPOSITE direction from `fal.image`'s: broll
 * has no image input, so an i2i model can't work at all — it needs a source
 * image broll can't supply). Same static-then-live search order as
 * `suggestI2IModels`.
 */
export function suggestT2IModels(): string[] {
  const presetMatches = FAL_IMAGE_MODELS.filter((m) => m.imageKind === 't2i').map((m) => m.id);
  if (presetMatches.length > 0) return presetMatches.slice(0, 2);
  const liveMatches = liveImageCatalog?.filter((m) => m.imageKind === 't2i').map((m) => m.id) ?? [];
  return liveMatches.slice(0, 2);
}
