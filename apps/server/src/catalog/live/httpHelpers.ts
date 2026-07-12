/**
 * Tiny fetch helpers for the live catalog fetchers (SPEC-step19.md §1.1),
 * deliberately separate from `../../lib/http.ts` (that module's retry/queue
 * polling shape is tailored to authenticated provider calls; both fal.ai's
 * `/api/models` and OpenRouter's `/api/v1/models` are public, keyless, plain
 * GET endpoints with no queue semantics, and — per SPEC-step19.md §1.4 —
 * must accept an injectable `fetchImpl` so tests never touch the real
 * network or need to stub `globalThis.fetch`).
 */
import type { FetchLike } from './types.js';

/**
 * `fetchImpl(url)` with an AbortController-based timeout. No retry — a
 * failed page fails the whole live fetch, which the caller (getCatalog)
 * turns into a fallback to the static preset rather than retrying (see
 * `index.ts`).
 */
export async function fetchJsonWithTimeout<T>(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timeout after ${timeoutMs}ms: GET ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once (SPEC-step19.md
 * §1.1's "tối đa 5 request song song" for fal.ai's ~35 pages). Preserves
 * input order in the result array regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
