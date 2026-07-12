/**
 * ConversationsRepo (SPEC-step20.md §3.1): CRUD + summary listing over the
 * `conversations` table. Relationship to `workflows` is 1-1 and enforced by
 * the `workflow_id UNIQUE` constraint in db/sqlite.ts's SCHEMA_SQL — a
 * second create() for the same workflowId throws (SQLITE_CONSTRAINT).
 */
import type Database from 'better-sqlite3';

export interface Conversation {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastSeenChangeId: number | null;
}

export interface ConversationSummary {
  id: string;
  workflowId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  lastRunStatus?: string;
}

interface ConversationRow {
  id: string;
  workflow_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  last_seen_change_id: number | null;
}

interface ConversationSummaryRow extends ConversationRow {
  node_count: number;
  last_run_status: string | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenChangeId: row.last_seen_change_id,
  };
}

// Escapes SQLite LIKE wildcards ('%', '_') and the escape char itself so a
// literal '%'/'_' typed by the user in a search box doesn't act as a
// wildcard. Paired with `ESCAPE '\'` in the query below.
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class ConversationsRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: { id: string; workflowId: string; title?: string }): Conversation {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, workflow_id, title, created_at, updated_at, last_seen_change_id)
         VALUES (@id, @workflowId, @title, @ts, @ts, NULL)`,
      )
      .run({ id: input.id, workflowId: input.workflowId, title: input.title ?? '', ts });
    return this.get(input.id)!;
  }

  get(id: string): Conversation | undefined {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : undefined;
  }

  getByWorkflowId(workflowId: string): Conversation | undefined {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE workflow_id = ?`).get(workflowId) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : undefined;
  }

  /** Ordered newest-updated first; nodeCount/lastRunStatus joined from workflows/runs. */
  list(search?: string): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
                COALESCE(json_array_length(w.json, '$.nodes'), 0) AS node_count,
                (SELECT r.status FROM runs r
                   WHERE r.workflow_id = c.workflow_id
                   ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_run_status
         FROM conversations c
         LEFT JOIN workflows w ON w.id = c.workflow_id
         WHERE (@search IS NULL OR c.title LIKE @pattern ESCAPE '\\')
         ORDER BY c.updated_at DESC, c.rowid DESC`,
      )
      .all({
        search: search ?? null,
        pattern: search !== undefined ? `%${escapeLike(search)}%` : null,
      }) as ConversationSummaryRow[];

    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodeCount: row.node_count,
      lastRunStatus: row.last_run_status ?? undefined,
    }));
  }

  rename(id: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(title, this.now(), id);
  }

  touch(id: string): void {
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(this.now(), id);
  }

  setLastSeenChangeId(id: string, changeId: number | null): void {
    this.db.prepare(`UPDATE conversations SET last_seen_change_id = ? WHERE id = ?`).run(changeId, id);
  }

  /**
   * Deletes the conversation and its 1-1 workflow, plus everything that
   * hangs off either of them (messages, workflow_changes, runs/node_runs).
   * App-level cascade (SQLite here has no `PRAGMA foreign_keys` FKs) run
   * inside one transaction so a crash mid-way can't leave orphans.
   */
  deleteCascade(id: string): void {
    const conv = this.get(id);
    if (!conv) return;
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
      this.db.prepare(`DELETE FROM workflow_changes WHERE conversation_id = ?`).run(id);
      const runIds = this.db.prepare(`SELECT id FROM runs WHERE workflow_id = ?`).all(conv.workflowId) as Array<{
        id: string;
      }>;
      for (const { id: runId } of runIds) {
        this.db.prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(runId);
      }
      this.db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(conv.workflowId);
      this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(conv.workflowId);
      this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    });
    tx();
  }
}
