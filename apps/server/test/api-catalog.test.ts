/**
 * SPEC-step13.md §4 — api-catalog.test.ts.
 * GET /api/model-catalog: shape + every id non-empty + tier valid + no
 * duplicate ids within each list.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
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

  it('returns { video, image } arrays of FalModelPreset', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { video: unknown[]; image: unknown[] };
    expect(Array.isArray(body.video)).toBe(true);
    expect(Array.isArray(body.image)).toBe(true);
    expect(body.video.length).toBeGreaterThan(0);
    expect(body.image.length).toBeGreaterThan(0);
  });

  it('every preset has a non-empty id/label/cost and a valid tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-catalog' });
    const body = res.json() as { video: Record<string, unknown>[]; image: Record<string, unknown>[] };
    for (const preset of [...body.video, ...body.image]) {
      expect(typeof preset.id).toBe('string');
      expect((preset.id as string).length).toBeGreaterThan(0);
      expect(typeof preset.label).toBe('string');
      expect((preset.label as string).length).toBeGreaterThan(0);
      expect(typeof preset.cost).toBe('string');
      expect((preset.cost as string).length).toBeGreaterThan(0);
      expect(VALID_TIERS.has(preset.tier as string)).toBe(true);
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
