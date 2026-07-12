/**
 * `getCatalog()` (SPEC-step19.md §1.4/§1.6) — the contract consumers (a
 * later phase: `routes/modelCatalog.ts`, `engine/costEstimate.ts`,
 * `nodes/fal.video.ts`'s t2v guard, `agent/promptBuilder.ts`) call to get
 * the unified, price-tiered fal/OpenRouter catalog:
 *
 *   - `CATALOG_LIVE=0` (or `opts.liveEnabled: false`) -> always the static
 *     preset only, `meta.source: 'static'`, no network/DB touched at all.
 *   - Cache hit (< 24h old) -> served straight from `catalog_cache`, no
 *     fetch.
 *   - Cache hit but stale (>= 24h old) -> the stale payload is still served
 *     immediately (never blocks the caller on a live re-fetch), and a
 *     best-effort background refetch updates the cache for next time
 *     (stale-while-revalidate). A failed background refetch is swallowed —
 *     the stale cache just keeps being served until one succeeds.
 *   - Cache miss -> fetches live synchronously (bounded by a 25s overall
 *     budget across both providers); on any failure, falls back to the
 *     static preset for that provider (`meta.source: 'static'`) rather than
 *     ever throwing out of `getCatalog()`.
 *
 * Never fetches at server startup — this module has no side effects at
 * import time; the first `getCatalog()` call (a request handler, in the
 * later routes phase) is what triggers the lazy fetch.
 */
import type Database from 'better-sqlite3';
import { FAL_IMAGE_MODELS, FAL_VIDEO_MODELS } from '../falModels.js';
import { OPENROUTER_LLM_MODELS } from '../openrouterModels.js';
import { CatalogCacheRepo } from './cache.js';
import { fetchFalCatalog } from './fetchFal.js';
import { fetchOpenRouterCatalog } from './fetchOpenRouter.js';
import { mergeFalCatalog, mergeLlmCatalog } from './merge.js';
import type { CatalogSource, FetchLike, LiveFalModel, LiveOpenRouterModel, UnifiedCatalog } from './types.js';

const PROVIDER_OPENROUTER = 'openrouter';
const PROVIDER_FAL = 'fal';

/** SPEC-step19.md §1.4 — overall wall-clock budget for a *synchronous* live fetch (cache-miss path); per-request timeouts inside fetchFalCatalog/fetchOpenRouterCatalog are separately bounded to 10s each. */
const OVERALL_FETCH_TIMEOUT_MS = 25_000;

export interface GetCatalogOpts {
  fetchImpl?: FetchLike;
  /** DI-able clock, default Date.now. */
  now?: () => number;
  /** Default: `process.env.CATALOG_LIVE !== '0'`. Set false to always use the static preset, matching the `CATALOG_LIVE=0` env gate (SPEC-step19.md §1.4). */
  liveEnabled?: boolean;
  /**
   * Test-only: await the stale-while-revalidate background refetch before
   * `getCatalog()` returns, instead of firing it and returning immediately.
   * Production callers must never set this — it defeats the point of
   * serving stale data immediately while revalidating in the background.
   */
  awaitBackgroundRefresh?: boolean;
}

function isLiveEnabledByEnv(): boolean {
  return process.env.CATALOG_LIVE !== '0';
}

async function withOverallTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Live catalog fetch exceeded overall ${ms}ms budget`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type ProviderStatus = 'live' | 'stale' | 'static';

interface ProviderResult<T> {
  data: T[];
  fetchedAt: number | null;
  status: ProviderStatus;
}

/** Cache-or-fetch orchestration for one provider (SPEC-step19.md §1.4), shared by both fal and OpenRouter. */
async function loadProvider<T>(
  provider: string,
  cacheRepo: CatalogCacheRepo,
  fetcher: () => Promise<T[]>,
  nowFn: () => number,
  awaitBackgroundRefresh: boolean,
): Promise<ProviderResult<T>> {
  const now = nowFn();
  const cached = cacheRepo.get<T[]>(provider);

  if (cached && cacheRepo.isFresh(cached.fetchedAt, now)) {
    return { data: cached.data, fetchedAt: cached.fetchedAt, status: 'live' };
  }

  if (cached) {
    // Stale-while-revalidate: serve the expired cache immediately; kick off
    // a background refetch that updates the cache for next time. A failure
    // here must never surface — the stale data already answered this call.
    const backgroundRefresh = (async () => {
      try {
        const fresh = await withOverallTimeout(fetcher(), OVERALL_FETCH_TIMEOUT_MS);
        cacheRepo.set(provider, fresh);
      } catch {
        // Keep serving the stale cache until a future request succeeds.
      }
    })();
    if (awaitBackgroundRefresh) await backgroundRefresh;
    return { data: cached.data, fetchedAt: cached.fetchedAt, status: 'stale' };
  }

  // Cache miss: no stale data to fall back to, so this call must fetch
  // synchronously (bounded by the overall timeout) before it can answer.
  try {
    const fresh = await withOverallTimeout(fetcher(), OVERALL_FETCH_TIMEOUT_MS);
    const fetchedAt = cacheRepo.set(provider, fresh);
    return { data: fresh, fetchedAt, status: 'live' };
  } catch {
    return { data: [], fetchedAt: null, status: 'static' };
  }
}

function combineSource(statuses: ProviderStatus[]): CatalogSource {
  if (statuses.some((s) => s === 'static')) return 'static';
  if (statuses.some((s) => s === 'stale')) return 'live-stale';
  return 'live';
}

function buildCatalog(
  falLive: LiveFalModel[],
  openrouterLive: LiveOpenRouterModel[],
  meta: { source: CatalogSource; fetchedAt: number | null },
): UnifiedCatalog {
  const falImageLive = falLive.filter((m) => m.kind === 'image');
  const falVideoLive = falLive.filter((m) => m.kind !== 'image');

  const falImage = mergeFalCatalog(falImageLive, FAL_IMAGE_MODELS);
  const falVideo = mergeFalCatalog(falVideoLive, FAL_VIDEO_MODELS);
  const openrouter = mergeLlmCatalog(openrouterLive, OPENROUTER_LLM_MODELS);

  return {
    falImage,
    falVideo,
    openrouter,
    meta: {
      ...meta,
      counts: { falImage: falImage.length, falVideo: falVideo.length, openrouter: openrouter.length },
    },
  };
}

export async function getCatalog(db: Database.Database, opts: GetCatalogOpts = {}): Promise<UnifiedCatalog> {
  const liveEnabled = opts.liveEnabled ?? isLiveEnabledByEnv();
  if (!liveEnabled) {
    return buildCatalog([], [], { source: 'static', fetchedAt: null });
  }

  const nowFn = opts.now ?? Date.now;
  const cacheRepo = new CatalogCacheRepo(db, nowFn);
  const fetchImpl = opts.fetchImpl;
  const awaitBackgroundRefresh = opts.awaitBackgroundRefresh ?? false;

  const [openrouterResult, falResult] = await Promise.all([
    loadProvider<LiveOpenRouterModel>(
      PROVIDER_OPENROUTER,
      cacheRepo,
      () => fetchOpenRouterCatalog({ fetchImpl }),
      nowFn,
      awaitBackgroundRefresh,
    ),
    loadProvider<LiveFalModel>(PROVIDER_FAL, cacheRepo, () => fetchFalCatalog({ fetchImpl }), nowFn, awaitBackgroundRefresh),
  ]);

  const source = combineSource([openrouterResult.status, falResult.status]);
  const fetchedAts = [openrouterResult.fetchedAt, falResult.fetchedAt].filter((v): v is number => v !== null);
  const fetchedAt = fetchedAts.length > 0 ? Math.min(...fetchedAts) : null;

  return buildCatalog(falResult.data, openrouterResult.data, { source, fetchedAt });
}

export interface RefreshCatalogResult {
  counts: { falImage: number; falVideo: number; openrouter: number };
  /** null only when `source: 'static'` (CATALOG_LIVE=0/liveEnabled:false — no fetch ever happened). */
  fetchedAt: number | null;
  source: CatalogSource;
}

/**
 * `POST /api/catalog/refresh` (SPEC-step19.md §1.4; the route itself is
 * wired in a later phase) — force refetch both providers regardless of TTL.
 * Bounded by the same 25s overall budget as the cache-miss path; a failure
 * here propagates (the route can 502/500 — there's no stale-safe fallback
 * to silently substitute for an explicit "refresh now" request).
 *
 * Fix (post-review): this must honor the same `CATALOG_LIVE=0`/
 * `liveEnabled: false` gate as `getCatalog()` — an explicit "refresh now"
 * is still live/network access, so before this check it bypassed the gate
 * entirely (an e2e/test run with `CATALOG_LIVE=0` would still hit the real
 * fal.ai/OpenRouter network the moment anything called this). When
 * disabled, skip both fetches and the cache write, and hand back the
 * static-only catalog's counts with `source: 'static'`.
 */
export async function refreshCatalog(
  db: Database.Database,
  opts: { fetchImpl?: FetchLike; now?: () => number; liveEnabled?: boolean } = {},
): Promise<RefreshCatalogResult> {
  const liveEnabled = opts.liveEnabled ?? isLiveEnabledByEnv();
  if (!liveEnabled) {
    const catalog = buildCatalog([], [], { source: 'static', fetchedAt: null });
    return { counts: catalog.meta.counts, fetchedAt: null, source: 'static' };
  }

  const nowFn = opts.now ?? Date.now;
  const cacheRepo = new CatalogCacheRepo(db, nowFn);
  const fetchImpl = opts.fetchImpl;

  const [openrouterData, falData] = await Promise.all([
    withOverallTimeout(fetchOpenRouterCatalog({ fetchImpl }), OVERALL_FETCH_TIMEOUT_MS),
    withOverallTimeout(fetchFalCatalog({ fetchImpl }), OVERALL_FETCH_TIMEOUT_MS),
  ]);

  const fetchedAt = cacheRepo.set(PROVIDER_OPENROUTER, openrouterData);
  cacheRepo.set(PROVIDER_FAL, falData);

  const catalog = buildCatalog(falData, openrouterData, { source: 'live', fetchedAt });
  return {
    counts: catalog.meta.counts,
    fetchedAt,
    source: 'live',
  };
}

export * from './cache.js';
export * from './fetchFal.js';
export * from './fetchOpenRouter.js';
export * from './merge.js';
export * from './priceParser.js';
export * from './tier.js';
export * from './types.js';
