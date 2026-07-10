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
}
