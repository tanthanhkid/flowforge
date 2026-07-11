/**
 * SPEC-step13.md §4 / SPEC-step14.md §4 — api-catalog.test.ts.
 * GET /api/model-catalog: shape + every id non-empty + tier valid + no
 * duplicate ids within each list + expanded-catalog size floors + llm cost
 * pattern.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { buildServer } from '../src/server.js';

const VALID_TIERS = new Set(['xin', 'kha', 're']);

describe('GET /api/model-catalog', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns { video, image, llm } arrays', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { video: unknown[]; image: unknown[]; llm: unknown[] };
    expect(Array.isArray(body.video)).toBe(true);
    expect(Array.isArray(body.image)).toBe(true);
    expect(Array.isArray(body.llm)).toBe(true);
    expect(body.video.length).toBeGreaterThan(0);
    expect(body.image.length).toBeGreaterThan(0);
    expect(body.llm.length).toBeGreaterThan(0);
  });

  // SPEC-step14.md §1/§2 — expanded catalog size floors.
  it('meets the expanded catalog size floors (video >=18, image >=10, llm >=12)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { video: unknown[]; image: unknown[]; llm: unknown[] };
    expect(body.video.length).toBeGreaterThanOrEqual(18);
    expect(body.image.length).toBeGreaterThanOrEqual(10);
    expect(body.llm.length).toBeGreaterThanOrEqual(12);
  });

  it('every preset has a non-empty id/label/cost and a valid tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { video: Record<string, unknown>[]; image: Record<string, unknown>[]; llm: Record<string, unknown>[] };
    for (const preset of [...body.video, ...body.image, ...body.llm]) {
      expect(typeof preset.id).toBe('string');
      expect((preset.id as string).length).toBeGreaterThan(0);
      expect(typeof preset.label).toBe('string');
      expect((preset.label as string).length).toBeGreaterThan(0);
      expect(typeof preset.cost).toBe('string');
      expect((preset.cost as string).length).toBeGreaterThan(0);
      expect(VALID_TIERS.has(preset.tier as string)).toBe(true);
    }
  });

  it('no duplicate ids within video, image, or llm lists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { video: { id: string }[]; image: { id: string }[]; llm: { id: string }[] };
    for (const list of [body.video, body.image, body.llm]) {
      const ids = list.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every llm preset cost matches the "$X in / $Y out per 1M tokens" pattern', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { llm: { cost: string }[] };
    for (const preset of body.llm) {
      expect(preset.cost).toMatch(/^\$[\d.]+ in \/ \$[\d.]+ out per 1M tokens$/);
    }
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
