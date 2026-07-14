import Database from 'better-sqlite3';
import type { CacheStore } from '../engine/cache.js';
import type { NodeRunRecord, RunRecord, RunStore } from '../engine/stores.js';
import type { NodeState, PortValue, RunStatus } from '../engine/types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT, json TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT, workflow_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS node_runs (run_id TEXT, node_id TEXT, state TEXT NOT NULL, outputs_json TEXT, error TEXT, logs_json TEXT, cache_hit INTEGER DEFAULT 0, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (run_id, node_id));
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, node_type TEXT, outputs_json TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_cache (provider TEXT PRIMARY KEY, fetched_at INTEGER, payload TEXT);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE,      -- quan hệ 1-1 bắt buộc với workflows.id
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_change_id INTEGER            -- con trỏ digest: AI đã "đọc" tới change nào; NULL = chưa turn nào
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,                    -- 'user' | 'assistant'
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',   -- 'pending' | 'streaming' | 'done' | 'error'
  error TEXT,
  change_id INTEGER,                     -- workflow_changes.id nếu turn này tạo ra change (NULL nếu chỉ trả lời)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,                  -- 'ai' | 'user'
  scope TEXT NOT NULL,                   -- 'structural' | 'cosmetic'
  message_id TEXT,                       -- set khi source='ai'
  ops_json TEXT NOT NULL,                -- PatchOp[] (vocabulary chung — bước 21 thêm op move-node)
  summary TEXT NOT NULL,                 -- 1 dòng tiếng Việt human-readable
  snapshot_after TEXT NOT NULL,          -- full Workflow JSON NGAY SAU khi apply — phục vụ revert đúng 100%
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_workflow ON workflow_changes(workflow_id, id);
CREATE INDEX IF NOT EXISTS idx_changes_conversation ON workflow_changes(conversation_id, id);
`;

// CREATE TABLE IF NOT EXISTS never adds a column to a table that already
// exists, so a DB created before SPEC-step20.md added `workflows.version`
// needs an explicit ALTER TABLE — this converges both a brand-new DB and an
// existing `data/*.db` onto the same schema without losing any rows.
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const hasColumn = cols.some((col) => col.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'workflows', 'version', 'version INTEGER NOT NULL DEFAULT 0');
  // SPEC-step32.md B1 — user-message image attachments (JSON array of
  // { path, filename?, mime? }, NULL when the message has none).
  ensureColumn(db, 'messages', 'attachments', 'attachments TEXT');
  // SPEC-step32.md B4 — who last set `conversations.title`: 'auto' (first
  // message's opening words, routes/conversations.ts's `autoTitle`), 'user'
  // (PATCH rename), or 'ai' (chatTurn.ts applying the LLM's own `title`
  // suggestion). Existing rows (pre-step32) all get 'auto' via the column
  // DEFAULT, which is also the correct value for them — every conversation
  // that predates this column got its title from `autoTitle`, never a user
  // rename (that codepath already always went through `rename()`, which is
  // updated by this same step to require the new `source` argument).
  ensureColumn(db, 'conversations', 'title_source', "title_source TEXT NOT NULL DEFAULT 'auto'");
  return db;
}

interface RunRow {
  id: string;
  workflow_id: string | null;
  workflow_json: string;
  status: string;
  created_at: number | null;
  finished_at: number | null;
}

interface NodeRunRow {
  run_id: string;
  node_id: string;
  state: string;
  outputs_json: string | null;
  error: string | null;
  logs_json: string | null;
  cache_hit: number;
  started_at: number | null;
  finished_at: number | null;
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: Database.Database) {}

  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, workflow_json, status, created_at, finished_at)
         VALUES (@id, @workflowId, @workflowJson, @status, @createdAt, @finishedAt)`,
      )
      .run({
        id: run.id,
        workflowId: run.workflowId,
        workflowJson: run.workflowJson,
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? null,
      });
  }

  finishRun(runId: string, status: RunStatus, finishedAt: number): void {
    this.db.prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`).run(status, finishedAt, runId);
  }

  upsertNodeRun(rec: NodeRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO node_runs (run_id, node_id, state, outputs_json, error, logs_json, cache_hit, started_at, finished_at)
         VALUES (@runId, @nodeId, @state, @outputsJson, @error, @logsJson, @cacheHit, @startedAt, @finishedAt)
         ON CONFLICT (run_id, node_id) DO UPDATE SET
           state = excluded.state,
           outputs_json = excluded.outputs_json,
           error = excluded.error,
           logs_json = excluded.logs_json,
           cache_hit = excluded.cache_hit,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
      )
      .run({
        runId: rec.runId,
        nodeId: rec.nodeId,
        state: rec.state,
        outputsJson: rec.outputs !== undefined ? JSON.stringify(rec.outputs) : null,
        error: rec.error ?? null,
        logsJson: JSON.stringify(rec.logs ?? []),
        cacheHit: rec.cacheHit ? 1 : 0,
        startedAt: rec.startedAt ?? null,
        finishedAt: rec.finishedAt ?? null,
      });
  }

  appendNodeLog(runId: string, nodeId: string, message: string): void {
    const row = this.db
      .prepare(`SELECT logs_json FROM node_runs WHERE run_id = ? AND node_id = ?`)
      .get(runId, nodeId) as { logs_json: string | null } | undefined;
    const logs: string[] = row?.logs_json ? (JSON.parse(row.logs_json) as string[]) : [];
    logs.push(message);
    this.db
      .prepare(`UPDATE node_runs SET logs_json = ? WHERE run_id = ? AND node_id = ?`)
      .run(JSON.stringify(logs), runId, nodeId);
  }

  getRun(runId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined {
    const runRow = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
    if (!runRow) return undefined;

    const nodeRows = this.db.prepare(`SELECT * FROM node_runs WHERE run_id = ?`).all(runId) as NodeRunRow[];

    return {
      run: {
        id: runRow.id,
        workflowId: runRow.workflow_id ?? '',
        workflowJson: runRow.workflow_json,
        status: runRow.status as RunStatus,
        createdAt: runRow.created_at ?? 0,
        finishedAt: runRow.finished_at ?? undefined,
      },
      nodes: nodeRows.map((row) => ({
        runId: row.run_id,
        nodeId: row.node_id,
        state: row.state as NodeState,
        outputs: row.outputs_json ? (JSON.parse(row.outputs_json) as Record<string, PortValue>) : undefined,
        error: row.error ?? undefined,
        logs: row.logs_json ? (JSON.parse(row.logs_json) as string[]) : [],
        cacheHit: !!row.cache_hit,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.finished_at ?? undefined,
      })),
    };
  }

  /**
   * SPEC-step30.md §2 — the most recently CREATED run for a workflow (by
   * `created_at`, `rowid` as tiebreaker for same-millisecond inserts — same
   * ordering `routes/runs.ts`'s `GET /api/runs` already uses), full node
   * detail included. A small method on the concrete class rather than a new
   * `RunStore` interface member: `routes/runs.ts`'s own doc comment already
   * established the precedent of querying the `runs` table directly instead
   * of growing that interface for a single workflow-scoped read, and
   * `InMemoryRunStore` (engine unit tests' mock-node double) has no
   * `workflowId`-indexed lookup to mirror this with anyway.
   */
  latestRunForWorkflow(workflowId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined {
    const row = this.db
      .prepare(`SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(workflowId) as { id: string } | undefined;
    if (!row) return undefined;
    return this.getRun(row.id);
  }
}

export class SqliteCacheStore implements CacheStore {
  constructor(private readonly db: Database.Database) {}

  get(key: string): Record<string, PortValue> | undefined {
    const row = this.db.prepare(`SELECT outputs_json FROM cache WHERE key = ?`).get(key) as
      | { outputs_json: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.outputs_json) as Record<string, PortValue>;
  }

  set(key: string, nodeType: string, outputs: Record<string, PortValue>): void {
    this.db
      .prepare(
        `INSERT INTO cache (key, node_type, outputs_json, created_at)
         VALUES (@key, @nodeType, @outputsJson, @createdAt)
         ON CONFLICT (key) DO UPDATE SET
           node_type = excluded.node_type,
           outputs_json = excluded.outputs_json,
           created_at = excluded.created_at`,
      )
      .run({ key, nodeType, outputsJson: JSON.stringify(outputs), createdAt: Date.now() });
  }
}
