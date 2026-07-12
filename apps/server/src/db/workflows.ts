/**
 * WorkflowsRepo (SPEC-step3.md §1/§4): thin CRUD layer over the `workflows`
 * table that already exists in db/sqlite.ts's SCHEMA_SQL
 * (id, name, json, created_at, updated_at). Kept separate from
 * SqliteRunStore/SqliteCacheStore since those belong to the engine's own
 * persistence contract (src/engine/stores.ts) — workflows are purely an API
 * concern.
 */
import type Database from 'better-sqlite3';
import type { Workflow } from '../engine/schema.js';

export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRow {
  id: string;
  name: string | null;
  json: string;
  created_at: number | null;
  updated_at: number | null;
}

/**
 * Thrown by saveVersioned() (SPEC-step20.md §3.4) when the caller's
 * expectedVersion doesn't match the workflow's current version — the
 * optimistic-concurrency guard against a chat turn overwriting a manual
 * edit (or vice versa) made while it was in flight. Carries the actual
 * current version so the caller can decide whether to retry/rebase.
 */
export class VersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(`Version conflict: current version is ${currentVersion}`);
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

export class WorkflowsRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): WorkflowSummary[] {
    const rows = this.db
      .prepare(`SELECT id, name, created_at, updated_at FROM workflows ORDER BY updated_at DESC, rowid DESC`)
      .all() as Array<Omit<WorkflowRow, 'json'>>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    }));
  }

  exists(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM workflows WHERE id = ?`).get(id);
    return row !== undefined;
  }

  get(id: string): Workflow | undefined {
    const row = this.db.prepare(`SELECT json FROM workflows WHERE id = ?`).get(id) as { json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.json) as Workflow;
  }

  /** Insert a brand-new workflow. Caller must check exists(id) first (route returns 409 on conflict). */
  create(workflow: Workflow): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, json, created_at, updated_at) VALUES (@id, @name, @json, @now, @now)`,
      )
      .run({ id: workflow.id, name: workflow.name, json: JSON.stringify(workflow), now });
  }

  /** Insert-or-update; created_at is preserved on update, updated_at always bumped. */
  upsert(workflow: Workflow): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, json, created_at, updated_at)
         VALUES (@id, @name, @json, @now, @now)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           json = excluded.json,
           updated_at = excluded.updated_at`,
      )
      .run({ id: workflow.id, name: workflow.name, json: JSON.stringify(workflow), now });
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
  }

  getVersion(id: string): number | undefined {
    const row = this.db.prepare(`SELECT version FROM workflows WHERE id = ?`).get(id) as
      | { version: number }
      | undefined;
    return row?.version;
  }

  getWithVersion(id: string): { workflow: Workflow; version: number } | undefined {
    const row = this.db.prepare(`SELECT json, version FROM workflows WHERE id = ?`).get(id) as
      | { json: string; version: number }
      | undefined;
    if (!row) return undefined;
    return { workflow: JSON.parse(row.json) as Workflow, version: row.version };
  }

  /**
   * Upsert that bumps `version` by 1 on every successful write (SPEC-step20.md
   * §3.4) — a workflow that doesn't exist yet is treated as version 0.
   * When `expectedVersion` is given and doesn't match the current version,
   * throws VersionConflictError and leaves the DB untouched (the whole
   * check + write runs inside a single better-sqlite3 transaction, which
   * rolls back automatically on a thrown error). `upsert()`/`create()`
   * above are untouched and never bump version, so existing routes built
   * on them keep their current semantics.
   */
  saveVersioned(workflow: Workflow, expectedVersion?: number): number {
    const run = this.db.transaction(() => {
      const currentRow = this.db.prepare(`SELECT version FROM workflows WHERE id = ?`).get(workflow.id) as
        | { version: number }
        | undefined;
      const currentVersion = currentRow?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new VersionConflictError(currentVersion);
      }

      const nextVersion = currentVersion + 1;
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO workflows (id, name, json, created_at, updated_at, version)
           VALUES (@id, @name, @json, @now, @now, @nextVersion)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             json = excluded.json,
             updated_at = excluded.updated_at,
             version = excluded.version`,
        )
        .run({ id: workflow.id, name: workflow.name, json: JSON.stringify(workflow), now, nextVersion });
      return nextVersion;
    });
    return run();
  }
}
