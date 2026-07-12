/**
 * SPEC-step19.md §1.4/§4 — catalog-live-cache.test.ts. `getCatalog()`'s
 * cache-or-fetch orchestration: TTL freshness, stale-while-revalidate,
 * fallback-to-static on a cache-miss fetch failure, the `CATALOG_LIVE=0`
 * env gate, and `refreshCatalog()`'s forced refetch. `fetchImpl` fully
 * injected — never touches `globalThis.fetch` or the real network.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../src/catalog/falModels.js';
import { CATALOG_CACHE_TTL_MS, CatalogCacheRepo } from '../src/catalog/live/cache.js';
import { getCatalog, refreshCatalog } from '../src/catalog/live/index.js';
import type { FetchLike } from '../src/catalog/live/types.js';
import { OPENROUTER_LLM_MODELS } from '../src/catalog/openrouterModels.js';
import { openDb } from '../src/db/sqlite.js';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function fakeFetchImpl(opts: { falPages?: number } = {}): FetchLike {
  const falPages = opts.falPages ?? 1;
  return (async (url: string) => {
    if (url.startsWith('https://openrouter.ai/api/v1/models')) {
      return jsonResponse(200, {
        data: [
          {
            id: 'test-vendor/live-only-llm',
            name: 'Live Only LLM',
            pricing: { prompt: '0.000001', completion: '0.000002' },
            architecture: { modality: 'text->text' },
          },
        ],
      });
    }
    if (url.startsWith('https://fal.ai/api/models')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return jsonResponse(200, {
        items:
          page === 1
            ? [{ id: 'test-vendor/live-only-image', title: 'Live Only Image', category: 'text-to-image', pricingInfoOverride: '**$0.02** per image' }]
            : [],
        page,
        pages: falPages,
        size: 1,
        total: 1,
      });
    }
    throw new Error(`unexpected url in test: ${url}`);
  }) as unknown as FetchLike;
}

const EXPECTED_STATIC_COUNTS = {
  falImage: FAL_IMAGE_MODELS.length,
  falVideo: FAL_VIDEO_MODELS.length,
  openrouter: OPENROUTER_LLM_MODELS.length,
};

describe('getCatalog', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
    delete process.env.CATALOG_LIVE;
  });

  it('cache miss -> fetches live, merges with static presets, caches the result', async () => {
    const fetchImpl = fakeFetchImpl();
    const now = 1_000_000;
    const catalog = await getCatalog(db, { fetchImpl, now: () => now });

    expect(catalog.meta.source).toBe('live');
    expect(catalog.meta.fetchedAt).toBe(now);
    expect(catalog.meta.counts).toEqual({
      falImage: EXPECTED_STATIC_COUNTS.falImage + 1,
      falVideo: EXPECTED_STATIC_COUNTS.falVideo,
      openrouter: EXPECTED_STATIC_COUNTS.openrouter + 1,
    });
    expect(catalog.falImage.some((m) => m.id === 'test-vendor/live-only-image' && m.featured === false)).toBe(true);
    expect(catalog.openrouter.some((m) => m.id === 'test-vendor/live-only-llm' && m.featured === false)).toBe(true);

    // Cache now populated: a second call with a fetchImpl that always throws
    // must still succeed, served entirely from cache.
    const throwingFetch: FetchLike = (async () => {
      throw new Error('should not be called — cache should be fresh');
    }) as unknown as FetchLike;
    const cached = await getCatalog(db, { fetchImpl: throwingFetch, now: () => now + 1000 });
    expect(cached.meta.source).toBe('live');
    expect(cached.falImage.some((m) => m.id === 'test-vendor/live-only-image')).toBe(true);
  });

  it('fresh cache (< 24h old) is served without calling fetchImpl again', async () => {
    const seedNow = 1_000_000;
    await getCatalog(db, { fetchImpl: fakeFetchImpl(), now: () => seedNow });

    const fetchSpy = vi.fn(fakeFetchImpl());
    const laterButFresh = seedNow + CATALOG_CACHE_TTL_MS - 1;
    await getCatalog(db, { fetchImpl: fetchSpy as unknown as FetchLike, now: () => laterButFresh });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('expired cache (>= 24h old) is served immediately (stale) while a background refetch updates it', async () => {
    const seedNow = 1_000_000;
    await getCatalog(db, { fetchImpl: fakeFetchImpl(), now: () => seedNow });

    // A second live-only image appears in the "new" live response, to tell
    // apart the stale-served payload from the freshly-refetched one.
    const updatedFetch = fakeFetchImplWithExtraImage();
    const expiredNow = seedNow + CATALOG_CACHE_TTL_MS + 1;

    const staleResult = await getCatalog(db, { fetchImpl: updatedFetch, now: () => expiredNow, awaitBackgroundRefresh: true });
    expect(staleResult.meta.source).toBe('live-stale');
    expect(staleResult.meta.fetchedAt).toBe(seedNow); // still the OLD fetchedAt — this response is the stale payload
    expect(staleResult.falImage.some((m) => m.id === 'test-vendor/extra-live-image')).toBe(false);

    // Next call (any time after) sees the refreshed cache written by the
    // background refetch triggered above (awaited via awaitBackgroundRefresh
    // for test determinism only — see index.ts's GetCatalogOpts doc).
    const throwingFetch: FetchLike = (async () => {
      throw new Error('should not be called — cache should already be refreshed');
    }) as unknown as FetchLike;
    const refreshedResult = await getCatalog(db, { fetchImpl: throwingFetch, now: () => expiredNow + 1 });
    expect(refreshedResult.meta.fetchedAt).toBe(expiredNow);
    expect(refreshedResult.falImage.some((m) => m.id === 'test-vendor/extra-live-image')).toBe(true);
  });

  function fakeFetchImplWithExtraImage(): FetchLike {
    return (async (url: string) => {
      if (url.startsWith('https://openrouter.ai/api/v1/models')) {
        return jsonResponse(200, { data: [] });
      }
      if (url.startsWith('https://fal.ai/api/models')) {
        return jsonResponse(200, {
          items: [{ id: 'test-vendor/extra-live-image', title: 'Extra', category: 'text-to-image' }],
          page: 1,
          pages: 1,
          size: 1,
          total: 1,
        });
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as unknown as FetchLike;
  }

  it('cache miss + fetch throws -> falls back to the static preset only, never throws', async () => {
    const throwingFetch: FetchLike = (async () => {
      throw new Error('network is down');
    }) as unknown as FetchLike;

    const catalog = await getCatalog(db, { fetchImpl: throwingFetch, now: () => 1_000_000 });

    expect(catalog.meta.source).toBe('static');
    expect(catalog.meta.fetchedAt).toBeNull();
    expect(catalog.meta.counts).toEqual(EXPECTED_STATIC_COUNTS);
    expect(catalog.falImage.every((m) => m.featured)).toBe(true);
    expect(catalog.openrouter.every((m) => m.featured)).toBe(true);
  });

  it('CATALOG_LIVE=0 (env) -> always static, never calls fetchImpl', async () => {
    process.env.CATALOG_LIVE = '0';
    const fetchSpy = vi.fn(fakeFetchImpl());

    const catalog = await getCatalog(db, { fetchImpl: fetchSpy as unknown as FetchLike });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog.meta.source).toBe('static');
    expect(catalog.meta.counts).toEqual(EXPECTED_STATIC_COUNTS);
  });

  it('opts.liveEnabled: false overrides even when CATALOG_LIVE is unset -> static, never calls fetchImpl', async () => {
    const fetchSpy = vi.fn(fakeFetchImpl());
    const catalog = await getCatalog(db, { fetchImpl: fetchSpy as unknown as FetchLike, liveEnabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog.meta.source).toBe('static');
  });

  it('combines a static fal provider (failed, no cache) with a live openrouter provider as overall "static"', async () => {
    const mixedFetch: FetchLike = (async (url: string) => {
      if (url.startsWith('https://openrouter.ai/api/v1/models')) {
        return jsonResponse(200, { data: [] });
      }
      throw new Error('fal is down');
    }) as unknown as FetchLike;

    const catalog = await getCatalog(db, { fetchImpl: mixedFetch, now: () => 1_000_000 });
    expect(catalog.meta.source).toBe('static');
  });
});

describe('refreshCatalog', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('force-refetches both providers regardless of a fresh cache, returns counts + fetchedAt, and updates the cache', async () => {
    const seedNow = 1_000_000;
    await getCatalog(db, { fetchImpl: fakeFetchImpl(), now: () => seedNow });

    const refreshedFetchImpl: FetchLike = (async (url: string) => {
      if (url.startsWith('https://openrouter.ai/api/v1/models')) {
        return jsonResponse(200, { data: [] });
      }
      return jsonResponse(200, {
        items: [{ id: 'test-vendor/post-refresh-image', title: 'Post refresh', category: 'text-to-image' }],
        page: 1,
        pages: 1,
        size: 1,
        total: 1,
      });
    }) as unknown as FetchLike;

    const refreshNow = seedNow + 5000; // well within the old TTL — must still refetch
    const result = await refreshCatalog(db, { fetchImpl: refreshedFetchImpl, now: () => refreshNow });

    expect(result.fetchedAt).toBe(refreshNow);
    expect(result.counts.openrouter).toBe(EXPECTED_STATIC_COUNTS.openrouter); // live list now empty, only presets remain
    expect(result.counts.falImage).toBe(EXPECTED_STATIC_COUNTS.falImage + 1);

    // getCatalog must now see the refreshed cache without calling fetch again.
    const throwingFetch: FetchLike = (async () => {
      throw new Error('should not be called');
    }) as unknown as FetchLike;
    const catalog = await getCatalog(db, { fetchImpl: throwingFetch, now: () => refreshNow + 1 });
    expect(catalog.meta.fetchedAt).toBe(refreshNow);
    expect(catalog.falImage.some((m) => m.id === 'test-vendor/post-refresh-image')).toBe(true);
  });

  it('propagates a fetch failure rather than silently falling back', async () => {
    const throwingFetch: FetchLike = (async () => {
      throw new Error('network is down');
    }) as unknown as FetchLike;
    await expect(refreshCatalog(db, { fetchImpl: throwingFetch })).rejects.toThrow('network is down');
  });

  // Post-review fix: an explicit "refresh now" is still live/network access,
  // so CATALOG_LIVE=0/liveEnabled:false must gate it exactly like
  // getCatalog() — previously this bypassed the gate entirely (a
  // CATALOG_LIVE=0 e2e/test run would still hit the real network the moment
  // anything called POST /api/catalog/refresh).
  it('CATALOG_LIVE=0 (env) -> returns the static catalog counts, never calls fetchImpl, never writes the cache', async () => {
    process.env.CATALOG_LIVE = '0';
    const fetchSpy = vi.fn(fakeFetchImpl());

    const result = await refreshCatalog(db, { fetchImpl: fetchSpy as unknown as FetchLike });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ counts: EXPECTED_STATIC_COUNTS, fetchedAt: null, source: 'static' });

    delete process.env.CATALOG_LIVE;
    const cacheRepo = new CatalogCacheRepo(db);
    expect(cacheRepo.get('openrouter')).toBeUndefined();
    expect(cacheRepo.get('fal')).toBeUndefined();
  });

  it('opts.liveEnabled: false overrides even when CATALOG_LIVE is unset -> static, never calls fetchImpl', async () => {
    const fetchSpy = vi.fn(fakeFetchImpl());
    const result = await refreshCatalog(db, { fetchImpl: fetchSpy as unknown as FetchLike, liveEnabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.source).toBe('static');
    expect(result.fetchedAt).toBeNull();
  });
});

describe('CatalogCacheRepo', () => {
  it('isFresh() is true just under the TTL and false at/after it', () => {
    let clock = 1_000_000;
    const db = openDb(':memory:');
    const repo = new CatalogCacheRepo(db, () => clock);
    const fetchedAt = repo.set('openrouter', [{ id: 'x' }]);

    clock = fetchedAt + CATALOG_CACHE_TTL_MS - 1;
    expect(repo.isFresh(fetchedAt, clock)).toBe(true);

    clock = fetchedAt + CATALOG_CACHE_TTL_MS;
    expect(repo.isFresh(fetchedAt, clock)).toBe(false);

    db.close();
  });

  it('get() round-trips the stored payload and returns undefined for a missing provider', () => {
    const db = openDb(':memory:');
    const repo = new CatalogCacheRepo(db, () => 42);
    repo.set('fal', [{ id: 'a' }, { id: 'b' }]);

    expect(repo.get('fal')).toEqual({ fetchedAt: 42, data: [{ id: 'a' }, { id: 'b' }] });
    expect(repo.get('missing-provider')).toBeUndefined();

    db.close();
  });
});
