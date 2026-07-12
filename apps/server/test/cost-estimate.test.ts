/**
 * cost-estimate.test.ts (SPEC-step15.md §5): `estimateWorkflowCost()` per
 * node type against the real catalogs, duration scaling for fal.video,
 * empty-model -> default model, custom/unknown model ids -> null +
 * unknownCount, total = sum of non-null usd, and the sample-premium-video
 * workflow (Veo3 8s) estimates to more than $3.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import type { UnifiedCatalog } from '../src/catalog/live/types.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { findRepoRoot } from '../src/config.js';
import { DISCLAIMER, estimateWorkflowCost, setLiveCatalogForCostEstimate } from '../src/engine/costEstimate.js';
import type { Workflow } from '../src/engine/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');

function wf(nodes: Workflow['nodes']): Workflow {
  return { version: 1, id: 'wf-test', name: 'test', nodes, edges: [] };
}

describe('estimateWorkflowCost', () => {
  it('fal.image node: usd matches the catalog estUsd for that modelId', () => {
    const preset = FAL_IMAGE_MODELS[0]!;
    const result = estimateWorkflowCost(
      wf([{ id: 'img', type: 'fal.image', params: { modelId: preset.id } }]),
    );
    expect(result.nodes[0]).toMatchObject({ nodeId: 'img', type: 'fal.image', usd: preset.estUsd, basis: preset.estBasis });
    expect(result.totalUsd).toBeCloseTo(preset.estUsd, 6);
    expect(result.unknownCount).toBe(0);
  });

  it('fal.video node without duration: usd matches the catalog estUsd (5s baseline)', () => {
    const preset = FAL_VIDEO_MODELS.find((m) => m.id === 'fal-ai/veo3')!;
    const result = estimateWorkflowCost(
      wf([{ id: 'vid', type: 'fal.video', params: { modelId: preset.id, aspectRatio: '9:16' } }]),
    );
    expect(result.nodes[0]!.usd).toBeCloseTo(preset.estUsd, 6);
  });

  it('fal.video node with duration=10 (number): scales estUsd by 2x (10s = 2x 5s)', () => {
    const preset = FAL_VIDEO_MODELS.find((m) => m.id === 'fal-ai/veo3')!;
    const result = estimateWorkflowCost(
      wf([{ id: 'vid', type: 'fal.video', params: { modelId: preset.id, duration: 10 } }]),
    );
    expect(result.nodes[0]!.usd).toBeCloseTo(preset.estUsd * 2, 6);
  });

  it('fal.video node with duration as a numeric string (Kling-style "10"): scales the same as duration=10', () => {
    const preset = FAL_VIDEO_MODELS.find((m) => m.id === 'fal-ai/veo3')!;
    const result = estimateWorkflowCost(
      wf([{ id: 'vid', type: 'fal.video', params: { modelId: preset.id, duration: '10' } }]),
    );
    expect(result.nodes[0]!.usd).toBeCloseTo(preset.estUsd * 2, 6);
  });

  it('llm.generate with empty model: resolves via getEnv(OPENROUTER_DEFAULT_MODEL), same as llm.transform', () => {
    // test/setup.ts stubs OPENROUTER_DEFAULT_MODEL to 'test/dummy-model' for
    // every test (real-secret guard) — not a catalog id, so both node types
    // should agree it's "unknown" rather than silently disagreeing with each
    // other. This proves the empty-model resolution path is exercised and
    // consistent, without hardcoding a real default model id into the test.
    const result = estimateWorkflowCost(
      wf([
        { id: 'gen', type: 'llm.generate', params: { model: '' } },
        { id: 'trans', type: 'llm.transform', params: { instruction: 'x', model: '' } },
      ]),
    );
    expect(result.nodes[0]!.usd).toBeNull();
    expect(result.nodes[1]!.usd).toBeNull();
    expect(result.unknownCount).toBe(2);
  });

  it('llm.transform with a known model id: usd matches the catalog estUsd for that model', () => {
    const preset = OPENROUTER_LLM_MODELS.find((m) => m.id === 'anthropic/claude-sonnet-4.5')!;
    const result = estimateWorkflowCost(
      wf([{ id: 'llm', type: 'llm.transform', params: { instruction: 'x', model: preset.id } }]),
    );
    expect(result.nodes[0]!.usd).toBeCloseTo(preset.estUsd, 6);
  });

  it('custom/unknown model id (outside catalog): usd is null, unknownCount increments, excluded from totalUsd', () => {
    const result = estimateWorkflowCost(
      wf([
        { id: 'img', type: 'fal.image', params: { modelId: 'some-rando/custom-model' } },
        { id: 'input', type: 'input.text', params: { value: 'x' } },
      ]),
    );
    expect(result.nodes[0]!.usd).toBeNull();
    expect(result.nodes[0]!.note).toBeTruthy();
    expect(result.unknownCount).toBe(1);
    expect(result.totalUsd).toBe(0);
  });

  it('vbee.tts uses the static NODE_BASE_COST entry ($0.02)', () => {
    const result = estimateWorkflowCost(wf([{ id: 'tts', type: 'vbee.tts', params: {} }]));
    expect(result.nodes[0]!.usd).toBeCloseTo(0.02, 6);
  });

  it('utility / video.compose nodes cost $0', () => {
    const result = estimateWorkflowCost(
      wf([
        { id: 'a', type: 'input.text', params: { value: 'x' } },
        { id: 'b', type: 'text.template', params: { template: '{{a}}' } },
        { id: 'c', type: 'video.compose', params: {} },
        { id: 'd', type: 'output.collect', params: {} },
      ]),
    );
    for (const n of result.nodes) {
      expect(n.usd).toBe(0);
    }
    expect(result.totalUsd).toBe(0);
    expect(result.unknownCount).toBe(0);
  });

  it('totalUsd is the sum of every non-null node usd', () => {
    const preset = FAL_IMAGE_MODELS[0]!;
    const llmPreset = OPENROUTER_LLM_MODELS[0]!;
    const result = estimateWorkflowCost(
      wf([
        { id: 'a', type: 'input.text', params: { value: 'x' } },
        { id: 'b', type: 'fal.image', params: { modelId: preset.id } },
        { id: 'c', type: 'llm.generate', params: { model: llmPreset.id } },
        { id: 'd', type: 'vbee.tts', params: {} },
      ]),
    );
    expect(result.totalUsd).toBeCloseTo(preset.estUsd + llmPreset.estUsd + 0.02, 6);
  });

  it('includes the fixed Vietnamese disclaimer', () => {
    const result = estimateWorkflowCost(wf([{ id: 'a', type: 'input.text', params: { value: 'x' } }]));
    expect(result.disclaimer).toBe(DISCLAIMER);
  });

  it('sample-premium-video.json estimates to more than $3 (Veo3 8s dominates)', () => {
    const raw = JSON.parse(readFileSync(path.join(repoRoot, 'samples', 'sample-premium-video.json'), 'utf8')) as Workflow;
    const result = estimateWorkflowCost(raw);
    expect(result.totalUsd).toBeGreaterThan(3);
    expect(result.unknownCount).toBe(0);
  });

  it('sample-value-video.json (best-value: Kling 2.5 Turbo Pro 5s + vbee.tts) totals its known-cost nodes correctly', () => {
    // The 3 llm.generate/llm.transform nodes use model: '' (system default);
    // in this test process that resolves via getEnv('OPENROUTER_DEFAULT_MODEL')
    // to test/setup.ts's dummy stub ('test/dummy-model', deliberately not a
    // catalog id — see test/setup.ts's "real-secret guard"), so they're
    // "unknown" here even though the real server (OPENROUTER_DEFAULT_MODEL=
    // x-ai/grok-4.5 in .env.local) would price them at $0.0046 each.
    const kling = FAL_VIDEO_MODELS.find((m) => m.id === 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video')!;
    const raw = JSON.parse(readFileSync(path.join(repoRoot, 'samples', 'sample-value-video.json'), 'utf8')) as Workflow;
    const result = estimateWorkflowCost(raw);
    expect(result.unknownCount).toBe(3);
    // vbee.tts ($0.02) + fal.video Kling 2.5 Turbo Pro at duration=5 (no
    // scaling, 5s baseline) — the 3 unknown llm nodes contribute $0.
    expect(result.totalUsd).toBeCloseTo(kling.estUsd + 0.02, 6);
    // Sanity-check the real-server projection quoted in the implementation
    // report: 3x grok-4.5 calls + vbee.tts + Kling 5s.
    const grok = OPENROUTER_LLM_MODELS.find((m) => m.id === 'x-ai/grok-4.5')!;
    const projectedRealTotal = 3 * grok.estUsd + 0.02 + kling.estUsd;
    expect(projectedRealTotal).toBeGreaterThan(0.3);
    expect(projectedRealTotal).toBeLessThan(0.5);
  });
});

function makeCatalog(overrides: Partial<UnifiedCatalog> = {}): UnifiedCatalog {
  return {
    falVideo: [],
    falImage: [],
    openrouter: [],
    meta: { source: 'live', fetchedAt: Date.now(), counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
    ...overrides,
  };
}

// SPEC-step19.md §1.6 — "lookup estUsd live-merge trước, preset tĩnh sau,
// không có -> behavior 'không rõ giá' hiện tại": estimateWorkflowCost(wf)
// (no 2nd arg, no setLiveCatalogForCostEstimate call) is exercised by every
// test above and is untouched by this describe block — every test here
// resets the pushed snapshot back to undefined afterward.
describe('estimateWorkflowCost — live catalog lookup (SPEC-step19.md §1.6)', () => {
  afterEach(() => {
    setLiveCatalogForCostEstimate(undefined);
  });

  it('resolves a live-only fal.video id (not in the static preset) once a catalog snapshot is pushed', () => {
    setLiveCatalogForCostEstimate(
      makeCatalog({
        falVideo: [
          {
            id: 'fal-ai/brand-new/text-to-video',
            label: 'Brand New T2V',
            kind: 'video-t2v',
            tier: 're',
            estUsd: 0.42,
            estBasis: 'per 5s clip (live)',
            createdAt: Date.now(),
            featured: false,
          },
        ],
      }),
    );
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'v', type: 'fal.video', params: { modelId: 'fal-ai/brand-new/text-to-video' } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeCloseTo(0.42, 6);
    expect(result.unknownCount).toBe(0);
  });

  it('scales a live-only fal.video id by duration just like a static preset', () => {
    setLiveCatalogForCostEstimate(
      makeCatalog({
        falVideo: [
          {
            id: 'fal-ai/brand-new/text-to-video',
            label: 'Brand New T2V',
            kind: 'video-t2v',
            tier: 're',
            estUsd: 0.4,
            estBasis: 'per 5s clip (live)',
            createdAt: null,
            featured: false,
          },
        ],
      }),
    );
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'v', type: 'fal.video', params: { modelId: 'fal-ai/brand-new/text-to-video', duration: 10 } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeCloseTo(0.8, 6);
  });

  it('a live entry with estUsd: null (unparseable fal price) is "unknown", not a crash', () => {
    setLiveCatalogForCostEstimate(
      makeCatalog({
        falImage: [
          {
            id: 'fal-ai/brand-new/some-image-model',
            label: 'Brand New Image',
            kind: 'image',
            tier: 'unknown',
            estUsd: null,
            estBasis: 'không xác định được đơn giá chuẩn hoá',
            createdAt: null,
            featured: false,
          },
        ],
      }),
    );
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'img', type: 'fal.image', params: { modelId: 'fal-ai/brand-new/some-image-model' } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeNull();
    expect(result.unknownCount).toBe(1);
  });

  it('a static preset id still resolves to the exact same estUsd via the live-merged catalog (matches the pre-step-19 static-only value)', () => {
    const preset = FAL_IMAGE_MODELS[0]!;
    setLiveCatalogForCostEstimate(
      makeCatalog({
        falImage: [
          {
            id: preset.id,
            label: preset.label,
            kind: 'image',
            tier: preset.tier,
            estUsd: preset.estUsd,
            estBasis: preset.estBasis,
            createdAt: null,
            featured: true,
          },
        ],
      }),
    );
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'img', type: 'fal.image', params: { modelId: preset.id } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeCloseTo(preset.estUsd, 6);
  });

  it('an unknown model id (not in the pushed catalog nor the static preset) is still "unknown"', () => {
    setLiveCatalogForCostEstimate(makeCatalog());
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'img', type: 'fal.image', params: { modelId: 'totally/unknown-model' } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeNull();
    expect(result.nodes[0]!.note).toBeTruthy();
  });

  it('llm live-only id resolves via the pushed catalog', () => {
    setLiveCatalogForCostEstimate(
      makeCatalog({
        openrouter: [
          {
            id: 'brand/new-llm',
            label: 'Brand New LLM',
            tier: 'kha',
            estUsd: 0.001,
            estBasis: 'per call (~800 in / 500 out tokens)',
            createdAt: null,
            featured: false,
          },
        ],
      }),
    );
    const result = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'gen', type: 'llm.generate', params: { model: 'brand/new-llm' } }],
      edges: [],
    });
    expect(result.nodes[0]!.usd).toBeCloseTo(0.001, 6);
  });
});
