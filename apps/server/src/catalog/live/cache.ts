/**
 * `CatalogCacheRepo` (SPEC-step19.md §1.4): thin CRUD layer over the
 * `catalog_cache` table (added to `../../db/sqlite.ts`'s `SCHEMA_SQL`, same
 * additive `CREATE TABLE IF NOT EXISTS` pattern the rest of the schema
 * uses). One row per provider key (`'openrouter'` | `'fal'`).
 *
 * Follows the same DI-able-clock pattern as `WorkflowsRepo`
 * (`../../db/workflows.ts`) so cache TTL logic is unit-testable without
 * faking global timers.
 */
import type Database from 'better-sqlite3';

/** 24h, per SPEC-step19.md §1.4. */
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedPayload<T> {
  fetchedAt: number;
  data: T;
}

interface CatalogCacheRow {
  fetched_at: number;
  payload: string;
}

export class CatalogCacheRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(provider: string): CachedPayload<T> | undefined {
    const row = this.db.prepare(`SELECT fetched_at, payload FROM catalog_cache WHERE provider = ?`).get(provider) as
      | CatalogCacheRow
      | undefined;
    if (!row) return undefined;
    return { fetchedAt: row.fetched_at, data: JSON.parse(row.payload) as T };
  }

  /** Upserts `data` for `provider`, stamped with the repo's clock. Returns the stamped `fetchedAt`. */
  set<T>(provider: string, data: T): number {
    const fetchedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO catalog_cache (provider, fetched_at, payload)
         VALUES (@provider, @fetchedAt, @payload)
         ON CONFLICT (provider) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           payload = excluded.payload`,
      )
      .run({ provider, fetchedAt, payload: JSON.stringify(data) });
    return fetchedAt;
  }

  isFresh(fetchedAt: number, nowMs: number = this.now()): boolean {
    return nowMs - fetchedAt < CATALOG_CACHE_TTL_MS;
  }
}
