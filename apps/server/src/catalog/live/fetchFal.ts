/**
 * `fetchFalCatalog` (SPEC-step19.md §1.1): fal.ai's public, keyless
 * `GET /api/models?page=N` — no `FAL_KEY` involved. The `category` query
 * param is server-ignored (confirmed by orchestrator curl, SPEC-step19.md
 * §0), so every one of the ~35 pages must be fetched and filtering done
 * client-side. Fetches page 1 first (to learn `pages`), then the rest with
 * at most `concurrency` (default 5) requests in flight, each bounded by
 * `timeoutMs` (default 10s).
 */
import { fetchJsonWithTimeout, mapWithConcurrency } from './httpHelpers.js';
import type { FalKind, FetchLike, LiveFalModel } from './types.js';

const FAL_MODELS_URL = 'https://fal.ai/api/models';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 5;
/** SPEC-step19.md §1.1 — shortDescription -> note, truncated to 120 chars. */
const NOTE_MAX_LEN = 120;

interface RawFalModel {
  id: string;
  title?: string;
  category?: string;
  date?: string;
  publishedAt?: string;
  deprecated?: boolean;
  removed?: boolean;
  shortDescription?: string;
  pricingInfoOverride?: string;
}

interface RawFalPage {
  items: RawFalModel[];
  page: number;
  pages: number;
  size: number;
  total: number;
}

/** SPEC-step19.md §1.1 category -> kind mapping; every other category (LoRA, training, utils, ...) is dropped. */
const CATEGORY_TO_KIND: Record<string, FalKind> = {
  'text-to-image': 'image',
  'image-to-image': 'image',
  'text-to-video': 'video-t2v',
  'image-to-video': 'video-i2v',
};

/**
 * SPEC-step29.md §2 — sub-classification of the two `kind: 'image'`
 * categories (confirmed live 2026-07-13 via `GET /api/models`: fal.ai's only
 * two image categories are exactly `text-to-image` and `image-to-image`, no
 * separate "image-editing" category exists). Not consulted for video
 * categories — `video-t2v`/`video-i2v` already carries that split via `kind`
 * itself.
 */
const CATEGORY_TO_IMAGE_KIND: Record<string, 't2i' | 'i2i'> = {
  'text-to-image': 't2i',
  'image-to-image': 'i2i',
};

function toLiveFalModel(m: RawFalModel): LiveFalModel | undefined {
  const kind = m.category ? CATEGORY_TO_KIND[m.category] : undefined;
  if (!kind) return undefined;

  const createdRaw = m.date ?? m.publishedAt;
  const createdAt = createdRaw ? Date.parse(createdRaw) : NaN;
  const imageKind = m.category ? CATEGORY_TO_IMAGE_KIND[m.category] : undefined;

  return {
    id: m.id,
    label: m.title ?? m.id,
    kind,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    note: m.shortDescription ? m.shortDescription.slice(0, NOTE_MAX_LEN) : undefined,
    priceRaw: m.pricingInfoOverride,
    ...(imageKind ? { imageKind } : {}),
  };
}

export interface FetchFalOpts {
  fetchImpl?: FetchLike;
  /** default 10_000 */
  timeoutMs?: number;
  /** default 5 */
  concurrency?: number;
}

export async function fetchFalCatalog(opts: FetchFalOpts = {}): Promise<LiveFalModel[]> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const firstPage = await fetchJsonWithTimeout<RawFalPage>(`${FAL_MODELS_URL}?page=1`, fetchImpl, timeoutMs);
  const totalPages = Math.max(1, firstPage.pages ?? 1);

  const remainingPageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  const remainingPages = await mapWithConcurrency(remainingPageNumbers, concurrency, (page) =>
    fetchJsonWithTimeout<RawFalPage>(`${FAL_MODELS_URL}?page=${page}`, fetchImpl, timeoutMs),
  );

  const allItems = [firstPage, ...remainingPages].flatMap((p) => p.items ?? []);

  const result: LiveFalModel[] = [];
  for (const item of allItems) {
    if (item.deprecated || item.removed) continue;
    const mapped = toLiveFalModel(item);
    if (mapped) result.push(mapped);
  }
  return result;
}
