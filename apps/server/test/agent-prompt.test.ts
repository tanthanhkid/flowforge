/**
 * SPEC-step5.md §7 — agent-prompt.test.ts.
 * System prompts embed the full node catalog (all 9 real node types +
 * port names + paramsJsonSchema) and the 2 hard-coded few-shots parse to a
 * real Workflow and pass validateWorkflow() against the real registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEditSystemPrompt,
  buildGenerateSystemPrompt,
  GENERATE_FEWSHOT_CAPTION_IMAGE,
  GENERATE_FEWSHOT_SCRIPT_VBEE,
  setPromptBuilderCatalog,
} from '../src/agent/promptBuilder.js';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import type { CatalogFalEntry, CatalogLlmEntry, CatalogTier, UnifiedCatalog } from '../src/catalog/live/types.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { createDefaultRegistry } from '../src/nodes/index.js';
import { WorkflowSchema, validateWorkflow } from '../src/engine/schema.js';

const ALL_NODE_TYPES = [
  'input.text',
  'input.file',
  'text.template',
  'output.collect',
  'llm.generate',
  'llm.transform',
  'fal.image',
  'fal.video',
  'vbee.tts',
];

describe('buildGenerateSystemPrompt', () => {
  const registry = createDefaultRegistry();
  const prompt = buildGenerateSystemPrompt(registry);

  it('contains all 9 real node types', () => {
    for (const type of ALL_NODE_TYPES) {
      expect(prompt).toContain(type);
    }
  });

  it('contains the port names of each node type', () => {
    for (const def of registry.list()) {
      for (const portName of Object.keys(def.inputs)) {
        expect(prompt).toContain(portName);
      }
      for (const portName of Object.keys(def.outputs)) {
        expect(prompt).toContain(portName);
      }
    }
  });

  it('contains each node paramsJsonSchema (property names) serialized into the catalog', () => {
    for (const def of registry.describeForAgent()) {
      const schema = def.paramsJsonSchema as { properties?: Record<string, unknown> };
      for (const propName of Object.keys(schema.properties ?? {})) {
        expect(prompt).toContain(`"${propName}"`);
      }
    }
  });

  it('instructs the model to return ONLY JSON', () => {
    expect(prompt).toMatch(/DUY NHẤT JSON/);
  });

  it('few-shot (a) caption+image parses as a real Workflow and passes validateWorkflow()', () => {
    const parsed = WorkflowSchema.parse(GENERATE_FEWSHOT_CAPTION_IMAGE);
    const result = validateWorkflow(parsed, registry);
    expect(result.ok).toBe(true);
  });

  it('few-shot (b) script+vbee parses as a real Workflow and passes validateWorkflow()', () => {
    const parsed = WorkflowSchema.parse(GENERATE_FEWSHOT_SCRIPT_VBEE);
    const result = validateWorkflow(parsed, registry);
    expect(result.ok).toBe(true);
  });

  it('embeds both few-shots serialized into the prompt text', () => {
    expect(prompt).toContain(GENERATE_FEWSHOT_CAPTION_IMAGE.id);
    expect(prompt).toContain(GENERATE_FEWSHOT_SCRIPT_VBEE.id);
  });

  // SPEC-step13.md §2/§4 — the "MODEL CATALOG (fal)" section + the
  // tier-selection rule.
  it('contains the MODEL CATALOG (fal) section with a xịn-tier id and the tier-selection rule', () => {
    expect(prompt).toContain('MODEL CATALOG (fal)');
    const xinModel = [...FAL_VIDEO_MODELS, ...FAL_IMAGE_MODELS].find((m) => m.tier === 'xin');
    expect(xinModel).toBeDefined();
    expect(prompt).toContain(xinModel!.id);
    expect(prompt).toMatch(/mặc định chọn tier "kha"/);
  });

  // SPEC-step14.md §2/§3/§4 — the "MODEL CATALOG (OpenRouter LLM)" section +
  // the "params.model = ''" default rule.
  it('contains the MODEL CATALOG (OpenRouter LLM) section with an id + the default-"" rule', () => {
    expect(prompt).toContain('MODEL CATALOG (OpenRouter LLM)');
    expect(prompt).toContain(OPENROUTER_LLM_MODELS[0]!.id);
    expect(prompt).toMatch(/params\.model = ""/);
  });
});

describe('buildEditSystemPrompt', () => {
  const registry = createDefaultRegistry();
  const workflow = {
    version: 1 as const,
    id: 'wf-x',
    name: 'x',
    nodes: [{ id: 'a', type: 'input.text', params: { value: 'hi' } }],
    edges: [],
  };

  it('contains the node catalog, the current workflow JSON, the target nodeId, and the patch op list', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    for (const type of ALL_NODE_TYPES) {
      expect(prompt).toContain(type);
    }
    expect(prompt).toContain('"id": "wf-x"');
    expect(prompt).toContain('"a"');
    expect(prompt).toContain('update-node');
    expect(prompt).toContain('add-node');
    expect(prompt).toContain('remove-node');
    expect(prompt).toContain('add-edge');
    expect(prompt).toContain('remove-edge');
  });

  it('instructs the model to return ONLY a JSON array', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toMatch(/JSON array|MẢNG/);
  });

  it('also contains the MODEL CATALOG (fal) section', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toContain('MODEL CATALOG (fal)');
  });

  it('also contains the MODEL CATALOG (OpenRouter LLM) section', () => {
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toContain('MODEL CATALOG (OpenRouter LLM)');
  });
});

// SPEC-step19.md §1.6 — once routes/modelCatalog.ts has pushed a live
// catalog snapshot via setPromptBuilderCatalog(), the two MODEL CATALOG
// sections render a capped (featured + top ~8/tier/kind, ~30 total) view of
// it instead of the raw static presets, and note that the id is free-form.
describe('MODEL CATALOG sections — live catalog cap (SPEC-step19.md §1.6)', () => {
  const registry = createDefaultRegistry();

  afterEach(() => {
    // Reset so this describe block never leaks its pushed catalog into the
    // `describe`s above (which assert the pre-step-19 static-only default).
    setPromptBuilderCatalog(undefined);
  });

  function makeFalEntry(overrides: Partial<CatalogFalEntry> & { id: string }): CatalogFalEntry {
    return {
      label: overrides.id,
      kind: 'video-t2v',
      tier: 're',
      estUsd: 0.1,
      estBasis: 'per 5s clip (live)',
      createdAt: null,
      featured: false,
      ...overrides,
    };
  }

  function makeLlmEntry(overrides: Partial<CatalogLlmEntry> & { id: string }): CatalogLlmEntry {
    return {
      label: overrides.id,
      tier: 're',
      estUsd: 0.0001,
      estBasis: 'per call (~800 in / 500 out tokens)',
      createdAt: null,
      featured: false,
      ...overrides,
    };
  }

  function makeCatalog(overrides: Partial<UnifiedCatalog> = {}): UnifiedCatalog {
    return {
      falVideo: [],
      falImage: [],
      openrouter: [],
      meta: { source: 'live', fetchedAt: Date.now(), counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
      ...overrides,
    };
  }

  it('caps a large non-featured (live-only) bucket to ~8 entries per tier per kind', () => {
    const manyLiveT2V: CatalogFalEntry[] = Array.from({ length: 20 }, (_, i) =>
      makeFalEntry({ id: `fal-ai/bucket-test/model-${i}`, kind: 'video-t2v', tier: 're', createdAt: 20 - i }),
    );
    setPromptBuilderCatalog(makeCatalog({ falVideo: manyLiveT2V }));

    const prompt = buildGenerateSystemPrompt(registry);
    const matches = manyLiveT2V.filter((m) => prompt.includes(m.id));
    expect(matches.length).toBeLessThanOrEqual(8);
    expect(matches.length).toBeGreaterThan(0);
    // The newest ones (pre-sorted first in the fixture, matching
    // catalog/live/merge.ts's real sort order) are the ones kept.
    expect(prompt).toContain('fal-ai/bucket-test/model-0');
  });

  it('always keeps every featured entry, even past the ~30 overall cap', () => {
    const manyFeatured: CatalogFalEntry[] = Array.from({ length: 35 }, (_, i) =>
      makeFalEntry({ id: `fal-ai/featured-test/model-${i}`, featured: true, tier: 'xin' }),
    );
    setPromptBuilderCatalog(makeCatalog({ falVideo: manyFeatured }));

    const prompt = buildGenerateSystemPrompt(registry);
    for (const m of manyFeatured) {
      expect(prompt).toContain(m.id);
    }
  });

  it('marks a featured entry with the ⭐ badge and notes the id is free-form', () => {
    setPromptBuilderCatalog(
      makeCatalog({
        falImage: [makeFalEntry({ id: 'fal-ai/featured-image', kind: 'image', featured: true, tier: 'xin' })],
        openrouter: [makeLlmEntry({ id: 'brand/featured-llm', featured: true, tier: 'xin' })],
      }),
    );

    const prompt = buildGenerateSystemPrompt(registry);
    expect(prompt).toMatch(/fal-ai\/featured-image \(fal-ai\/featured-image\), giá:/);
    expect(prompt).toContain('⭐');
    expect(prompt).toMatch(/CHUỖI TỰ DO/);
  });

  it('renders the ❓ "chưa rõ giá" label for an unknown-tier / null-estUsd entry', () => {
    setPromptBuilderCatalog(
      makeCatalog({
        falVideo: [makeFalEntry({ id: 'fal-ai/no-price', tier: 'unknown', estUsd: null, featured: true })],
      }),
    );
    const prompt = buildGenerateSystemPrompt(registry);
    expect(prompt).toContain('fal-ai/no-price');
    expect(prompt).toMatch(/❓ chưa rõ giá/);
    expect(prompt).toContain('giá: chưa rõ giá');
  });

  // Post-review fix: the ~30-id cap on non-featured (live-only) entries used
  // to reset independently for each of the 3 sections (fal video / fal
  // image / openrouter), so a catalog with a large non-featured long tail in
  // all 3 could carry up to ~90 non-featured ids total. It's now ONE shared
  // budget across all 3 sections combined.
  //
  // Each section below spreads 10 non-featured entries across all 4 tiers
  // (40 raw entries/section) so the per-tier-per-kind-8 bucket cap alone
  // still leaves 32 candidates/section (4 tiers × 8) — comfortably above the
  // old per-section 30 cap, so a buggy "resets per section" implementation
  // would still land at 30 ids PER section (90 total), which the `<= 30`
  // assertion below would catch.
  it('shares the ~30 non-featured cap across all 3 sections combined, not ~30 per section', () => {
    const tiers: CatalogTier[] = ['xin', 'kha', 're', 'unknown'];
    const manyFalNonFeatured = (prefix: string, kind: CatalogFalEntry['kind']): CatalogFalEntry[] =>
      tiers.flatMap((tier) =>
        Array.from({ length: 10 }, (_, i) => makeFalEntry({ id: `${prefix}-${tier}-${i}`, kind, tier, createdAt: 10 - i })),
      );
    const manyLlmNonFeatured = (prefix: string): CatalogLlmEntry[] =>
      tiers.flatMap((tier) =>
        Array.from({ length: 10 }, (_, i) => makeLlmEntry({ id: `${prefix}-${tier}-${i}`, tier, createdAt: 10 - i })),
      );

    const falVideo = manyFalNonFeatured('fal-ai/video-nf', 'video-t2v');
    const falImage = manyFalNonFeatured('fal-ai/image-nf', 'image');
    const openrouter = manyLlmNonFeatured('llm-nf');
    setPromptBuilderCatalog(makeCatalog({ falVideo, falImage, openrouter }));

    const prompt = buildGenerateSystemPrompt(registry);
    const allIds = [...falVideo, ...falImage, ...openrouter].map((m) => m.id);
    const nonFeaturedMatches = allIds.filter((id) => prompt.includes(id));

    expect(nonFeaturedMatches.length).toBeLessThanOrEqual(30);
    expect(nonFeaturedMatches.length).toBeGreaterThan(0);
  });

  it('buildEditSystemPrompt also uses the pushed live catalog (same cap logic)', () => {
    setPromptBuilderCatalog(
      makeCatalog({ openrouter: [makeLlmEntry({ id: 'brand/edit-llm', featured: true, tier: 'kha' })] }),
    );
    const workflow = {
      version: 1 as const,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'a', type: 'input.text', params: { value: 'hi' } }],
      edges: [],
    };
    const prompt = buildEditSystemPrompt(registry, workflow, 'a');
    expect(prompt).toContain('brand/edit-llm');
  });
});
