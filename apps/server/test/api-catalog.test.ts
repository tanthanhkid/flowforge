/**
 * SPEC-step13.md §4 / SPEC-step14.md §4 / SPEC-step19.md §1.6/§4 —
 * api-catalog.test.ts.
 * GET /api/model-catalog now returns the unified live+static catalog
 * (`{ falVideo, falImage, openrouter, meta }` — the same shape the web
 * picker, `apps/web/src/panels/ModelPicker.tsx`, consumes; there is no
 * legacy `{ video, image, llm }` shape left to test) + POST
 * /api/catalog/refresh.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPromptBuilderCatalog } from '../src/agent/promptBuilder.js';
import { CatalogCacheRepo } from '../src/catalog/live/cache.js';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import { openDb } from '../src/db/sqlite.js';
import { estimateWorkflowCost, setLiveCatalogForCostEstimate } from '../src/engine/costEstimate.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { setFalVideoLiveCatalog } from '../src/nodes/fal.video.js';
import { buildServer } from '../src/server.js';

const VALID_CATALOG_TIERS = new Set(['xin', 'kha', 're', 'unknown']);

// SPEC-step19.md §1.6/§4 — the unified live+static catalog. The global
// test-setup fetch guard (test/setup.ts) throws on any non-loopback fetch,
// so with no cache seeded the live fetch always fails fast -> getCatalog()
// falls back to meta.source: 'static' deterministically, with no real
// network touched and no explicit CATALOG_LIVE=0 needed.
describe('GET /api/model-catalog — unified catalog (SPEC-step19.md §1.6)', () => {
  let tmpDir: string;
  let dbPath: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'flowforge-catalog-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
    // Reset every module-level snapshot this describe block may have pushed
    // via the route, so it never leaks into a later test in this file.
    setLiveCatalogForCostEstimate(undefined);
    setFalVideoLiveCatalog(undefined);
    setPromptBuilderCatalog(undefined);
  });

  it('falls back to the static presets with meta.source "static" when no cache is seeded (live fetch fails)', async () => {
    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      falVideo: unknown[];
      falImage: unknown[];
      openrouter: unknown[];
      meta: { source: string; fetchedAt: number | null; counts: Record<string, number> };
    };
    expect(body.meta.source).toBe('static');
    expect(body.meta.fetchedAt).toBeNull();
    expect(body.falVideo.length).toBe(FAL_VIDEO_MODELS.length);
    expect(body.falImage.length).toBe(FAL_IMAGE_MODELS.length);
    expect(body.openrouter.length).toBe(OPENROUTER_LLM_MODELS.length);
    expect(body.meta.counts).toMatchObject({
      falVideo: FAL_VIDEO_MODELS.length,
      falImage: FAL_IMAGE_MODELS.length,
      openrouter: OPENROUTER_LLM_MODELS.length,
    });
  });

  it('every falVideo/falImage/openrouter entry has a valid tier (incl. "unknown") and a non-empty id/label', async () => {
    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { falVideo: Record<string, unknown>[]; falImage: Record<string, unknown>[]; openrouter: Record<string, unknown>[] };
    for (const entry of [...body.falVideo, ...body.falImage, ...body.openrouter]) {
      expect(typeof entry.id).toBe('string');
      expect((entry.id as string).length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(VALID_CATALOG_TIERS.has(entry.tier as string)).toBe(true);
      expect(typeof entry.featured).toBe('boolean');
    }
  });

  it('serves a directly-seeded fresh cache as meta.source "live" and includes the seeded live-only ids', async () => {
    const seedDb = openDb(dbPath);
    const cacheRepo = new CatalogCacheRepo(seedDb);
    cacheRepo.set('fal', [
      {
        id: 'fal-ai/brand-new/text-to-video',
        label: 'Brand New T2V',
        kind: 'video-t2v',
        createdAt: Date.now(),
        priceRaw: 'you will be charged **$0.5/second**',
      },
    ]);
    cacheRepo.set('openrouter', [
      { id: 'brand/new-llm', label: 'Brand New LLM', per1MIn: 1, per1MOut: 2, contextLength: 8000, createdAt: Date.now() },
    ]);
    seedDb.close();

    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as {
      falVideo: { id: string; featured: boolean }[];
      openrouter: { id: string; featured: boolean }[];
      meta: { source: string; fetchedAt: number | null };
    };
    expect(body.meta.source).toBe('live');
    expect(body.meta.fetchedAt).not.toBeNull();
    const liveVideo = body.falVideo.find((m) => m.id === 'fal-ai/brand-new/text-to-video');
    expect(liveVideo).toBeDefined();
    expect(liveVideo!.featured).toBe(false);
    const liveLlm = body.openrouter.find((m) => m.id === 'brand/new-llm');
    expect(liveLlm).toBeDefined();
    expect(liveLlm!.featured).toBe(false);
    // Every static preset id is still present too (mergeFalCatalog/mergeLlmCatalog keep them, featured: true).
    expect(body.falVideo.length).toBe(FAL_VIDEO_MODELS.length + 1);
  });

  // SPEC-step14.md §1/§2 — expanded catalog size floors, now against the unified shape.
  it('meets the expanded catalog size floors (falVideo >=18, falImage >=10, openrouter >=12)', async () => {
    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { falVideo: unknown[]; falImage: unknown[]; openrouter: unknown[] };
    expect(body.falVideo.length).toBeGreaterThanOrEqual(18);
    expect(body.falImage.length).toBeGreaterThanOrEqual(10);
    expect(body.openrouter.length).toBeGreaterThanOrEqual(12);
  });

  it('no duplicate ids within falVideo, falImage, or openrouter (static-only, no cache seeded)', async () => {
    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { falVideo: { id: string }[]; falImage: { id: string }[]; openrouter: { id: string }[] };
    for (const list of [body.falVideo, body.falImage, body.openrouter]) {
      const ids = list.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('publishes the fetched catalog to the other SPEC-step19.md §1.6 consumers (costEstimate/fal.video guard/promptBuilder) as a side effect', async () => {
    const seedDb = openDb(dbPath);
    const cacheRepo = new CatalogCacheRepo(seedDb);
    cacheRepo.set('fal', [
      {
        id: 'fal-ai/brand-new/text-to-video',
        label: 'Brand New T2V',
        kind: 'video-t2v',
        createdAt: Date.now(),
        priceRaw: 'you will be charged **$0.5/second**',
      },
    ]);
    cacheRepo.set('openrouter', []);
    seedDb.close();

    app = await buildServer({ dbPath });
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    expect(res.statusCode).toBe(200);

    // costEstimate: the live-only id now resolves to a real estUsd (0.5/s * 5s = 2.5) instead of "unknown".
    const estimate = estimateWorkflowCost({
      version: 1,
      id: 'wf-x',
      name: 'x',
      nodes: [{ id: 'v', type: 'fal.video', params: { modelId: 'fal-ai/brand-new/text-to-video' } }],
      edges: [],
    });
    expect(estimate.nodes[0]!.usd).toBeCloseTo(2.5, 6);
    expect(estimate.unknownCount).toBe(0);
  });
});

describe('POST /api/catalog/refresh (SPEC-step19.md §1.4/§4)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    await app.close();
  });

  // The global test-setup fetch guard makes both providers unreachable in
  // this environment (by design — no test ever touches the real network),
  // and refreshCatalog() has no stale-safe fallback for an explicit refresh
  // request, so the route must surface that failure rather than silently
  // pretending it worked.
  it('returns 502 when both providers are unreachable', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/catalog/refresh' });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe('falModels catalog', () => {
  it('has no duplicate ids within FAL_VIDEO_MODELS', () => {
    const ids = FAL_VIDEO_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate ids within FAL_IMAGE_MODELS', () => {
    const ids = FAL_IMAGE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every video model has kind video-t2v or video-i2v', () => {
    for (const m of FAL_VIDEO_MODELS) {
      expect(['video-t2v', 'video-i2v']).toContain(m.kind);
    }
  });

  it('every image model has kind image', () => {
    for (const m of FAL_IMAGE_MODELS) {
      expect(m.kind).toBe('image');
    }
  });
});

describe('openrouterModels catalog', () => {
  it('has no duplicate ids within OPENROUTER_LLM_MODELS', () => {
    const ids = OPENROUTER_LLM_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has kind "llm"', () => {
    for (const m of OPENROUTER_LLM_MODELS) {
      expect(m.kind).toBe('llm');
    }
  });

  it('has at least one entry in each tier', () => {
    const tiers = new Set(OPENROUTER_LLM_MODELS.map((m) => m.tier));
    expect(tiers.has('xin')).toBe(true);
    expect(tiers.has('kha')).toBe(true);
    expect(tiers.has('re')).toBe(true);
  });
});
