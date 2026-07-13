/**
 * SPEC-step19.md §1.5/§4 — catalog-live-merge.test.ts. `mergeFalCatalog` /
 * `mergeLlmCatalog`: a live entry matching a static preset id is upgraded to
 * `featured: true` and keeps the preset's hand-verified label/note/estUsd
 * (not the regex-parsed live price); presets absent from live are kept;
 * live-only entries are included with `featured: false`; tier is always
 * recomputed from the final `estUsd` via the shared price-threshold table.
 */
import { describe, expect, it } from 'vitest';
import type { FalModelPreset } from '../src/catalog/falModels.js';
import { mergeFalCatalog, mergeLlmCatalog } from '../src/catalog/live/merge.js';
import type { LiveFalModel, LiveOpenRouterModel } from '../src/catalog/live/types.js';
import type { OpenRouterModelPreset } from '../src/catalog/openrouterModels.js';

const FAL_PRESET: FalModelPreset = {
  id: 'fal-ai/flux/dev',
  label: 'FLUX.1 [dev]',
  tier: 'kha',
  cost: '~$0.025/megapixel',
  note: 'Chất lượng tốt, giá vừa phải',
  kind: 'image',
  estUsd: 0.025,
  estBasis: 'per image (hand-verified)',
};

const LLM_PRESET: OpenRouterModelPreset = {
  id: 'anthropic/claude-sonnet-4.5',
  label: 'Claude Sonnet 4.5',
  tier: 'xin',
  cost: '$3 in / $15 out per 1M tokens',
  note: 'Suy luận tốt',
  kind: 'llm',
  estUsd: 0.0099,
  estBasis: 'per call (hand-verified)',
};

describe('mergeFalCatalog', () => {
  it('marks a preset id present in live as featured, keeps preset label/note/estUsd, takes createdAt from live', () => {
    const live: LiveFalModel[] = [
      {
        id: 'fal-ai/flux/dev',
        label: 'FLUX Dev (live title, should be ignored)',
        kind: 'image',
        createdAt: 1_700_000_000_000,
        priceRaw: '**$999** per image', // deliberately different from preset.estUsd — must be ignored
      },
    ];

    const [entry] = mergeFalCatalog(live, [FAL_PRESET]);

    expect(entry).toMatchObject({
      id: 'fal-ai/flux/dev',
      label: 'FLUX.1 [dev]', // preset label wins, not the live title
      note: 'Chất lượng tốt, giá vừa phải', // preset note wins
      estUsd: 0.025, // preset estUsd wins, not the $999 parsed from live
      estBasis: 'per image (hand-verified)',
      createdAt: 1_700_000_000_000, // createdAt still comes from live
      featured: true,
      tier: 'kha', // recomputed from estUsd 0.025 (image bucket: kha is 0.01-0.05)
    });
  });

  it('keeps a preset absent from live, with createdAt null', () => {
    const result = mergeFalCatalog([], [FAL_PRESET]);
    expect(result).toEqual([
      expect.objectContaining({ id: 'fal-ai/flux/dev', featured: true, createdAt: null }),
    ]);
  });

  it('includes a live-only entry (no matching preset) as featured: false, price-parsed from priceRaw', () => {
    const live: LiveFalModel[] = [
      {
        id: 'fal-ai/brand-new-model',
        label: 'Brand New Model',
        kind: 'video-t2v',
        createdAt: 1_700_000_000_000,
        priceRaw: '**$0.28**/second',
      },
    ];

    const result = mergeFalCatalog(live, [FAL_PRESET]);
    const liveOnly = result.find((m) => m.id === 'fal-ai/brand-new-model');

    expect(liveOnly).toMatchObject({
      label: 'Brand New Model',
      featured: false,
      tier: 'xin', // 1.4 >= 0.75
    });
    expect(liveOnly?.estUsd).toBeCloseTo(1.4, 6); // 0.28 * 5
  });

  it('assigns tier "unknown" when a live-only entry has an unparseable price', () => {
    const live: LiveFalModel[] = [
      { id: 'fal-ai/mystery', label: 'Mystery', kind: 'image', createdAt: null, priceRaw: '' },
    ];
    const [entry] = mergeFalCatalog(live, []);
    expect(entry).toMatchObject({ estUsd: null, tier: 'unknown', featured: false });
  });

  // SPEC-step29.md §2 — `imageKind` (additive t2i/i2i sub-classification)
  // must survive the merge for both the preset and live-only paths.
  it('carries a preset\'s imageKind through to the merged entry', () => {
    const [entry] = mergeFalCatalog([], [{ ...FAL_PRESET, imageKind: 't2i' }]);
    expect(entry?.imageKind).toBe('t2i');
  });

  it('carries a live-only entry\'s imageKind through to the merged entry', () => {
    const live: LiveFalModel[] = [
      { id: 'fal-ai/brand-new-i2i', label: 'Brand New I2I', kind: 'image', createdAt: null, priceRaw: '**$0.03** per image', imageKind: 'i2i' },
    ];
    const [entry] = mergeFalCatalog(live, []);
    expect(entry?.imageKind).toBe('i2i');
  });

  it('leaves imageKind undefined when neither the preset nor the live entry sets it', () => {
    const [entry] = mergeFalCatalog([], [FAL_PRESET]);
    expect(entry?.imageKind).toBeUndefined();
  });
});

describe('mergeLlmCatalog', () => {
  it('marks a preset id present in live as featured, keeps preset estUsd, fills per1MIn/Out/contextLength from live', () => {
    const live: LiveOpenRouterModel[] = [
      {
        id: 'anthropic/claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5 (live)',
        per1MIn: 3,
        per1MOut: 15,
        contextLength: 200000,
        createdAt: 1_690_000_000_000,
      },
    ];

    const [entry] = mergeLlmCatalog(live, [LLM_PRESET]);

    expect(entry).toMatchObject({
      label: 'Claude Sonnet 4.5', // preset label wins
      estUsd: 0.0099, // preset estUsd wins
      featured: true,
      tier: 'xin',
      per1MIn: 3,
      per1MOut: 15,
      contextLength: 200000,
      createdAt: 1_690_000_000_000,
    });
  });

  it('computes estUsd for a live-only model via the step15 formula (0.0008*in + 0.0005*out)', () => {
    const live: LiveOpenRouterModel[] = [
      { id: 'new/model', label: 'New Model', per1MIn: 1, per1MOut: 2, contextLength: 128000, createdAt: null },
    ];
    const [entry] = mergeLlmCatalog(live, []);
    expect(entry?.estUsd).toBeCloseTo(0.0008 * 1 + 0.0005 * 2, 8);
    expect(entry?.featured).toBe(false);
  });

  it('a free ($0/$0) live-only model tiers as re', () => {
    const live: LiveOpenRouterModel[] = [
      { id: 'free/model', label: 'Free Model', per1MIn: 0, per1MOut: 0, contextLength: null, createdAt: null },
    ];
    const [entry] = mergeLlmCatalog(live, []);
    expect(entry?.estUsd).toBe(0);
    expect(entry?.tier).toBe('re');
  });

  // Post-review fix: a live-only model with OpenRouter's negative-price
  // sentinel (already normalized to per1MIn/per1MOut: null by
  // fetchOpenRouter.ts) must never get a computed estUsd from the step15
  // formula — it stays null/tier "unknown", and per1MIn/per1MOut are left
  // undefined (not the raw null) so the picker's "$X + $Y /1M" formatting
  // never renders a bogus negative price either.
  it('a live-only dynamic-router model (per1MIn/per1MOut: null) -> estUsd null, tier unknown, per1M fields undefined', () => {
    const live: LiveOpenRouterModel[] = [
      { id: 'openrouter/auto', label: 'Auto Router', per1MIn: null, per1MOut: null, contextLength: null, createdAt: null },
    ];
    const [entry] = mergeLlmCatalog(live, []);
    expect(entry?.estUsd).toBeNull();
    expect(entry?.tier).toBe('unknown');
    expect(entry?.estBasis).toContain('giá động theo model đích');
    expect(entry?.per1MIn).toBeUndefined();
    expect(entry?.per1MOut).toBeUndefined();
  });

  // Same case, but the model also happens to be a hand-curated preset
  // (preset.estUsd still wins per §1.5) — per1MIn/per1MOut from live must
  // still come through as undefined, not a literal null.
  it('a preset id whose live entry is a dynamic-router model -> per1M fields undefined, preset estUsd still wins', () => {
    const live: LiveOpenRouterModel[] = [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude (live)', per1MIn: null, per1MOut: null, contextLength: 200000, createdAt: null },
    ];
    const [entry] = mergeLlmCatalog(live, [LLM_PRESET]);
    expect(entry?.estUsd).toBe(0.0099); // preset wins, unaffected by live's null pricing
    expect(entry?.per1MIn).toBeUndefined();
    expect(entry?.per1MOut).toBeUndefined();
  });
});
