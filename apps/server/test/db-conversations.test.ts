/**
 * SPEC-step20.md §5.1 (schema/migration) + §5.2 (ConversationsRepo).
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationsRepo } from '../src/db/conversations.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';

function makeWorkflow(id: string, name = ''): Workflow {
  return { version: 1, id, name, nodes: [], edges: [] };
}

describe('openDb schema/migration', () => {
  it('creates the 3 new tables (conversations, messages, workflow_changes) on a fresh db', () => {
    const db = openDb(':memory:');
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[];
    const tables = rows.map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['conversations', 'messages', 'workflow_changes']));
    db.close();
  });

  it('adds workflows.version to a pre-step20 db without losing existing rows, and is idempotent', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-db-migration-'));
    const dbPath = path.join(tmp, 'legacy.db');

    // Simulate a database created before SPEC-step20.md: workflows table
    // exists but has no `version` column (the exact shape SCHEMA_SQL's
    // `CREATE TABLE IF NOT EXISTS workflows` still declares today).
    const legacy = new Database(dbPath);
    legacy.exec(
      `CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, json TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);`,
    );
    legacy
      .prepare(`INSERT INTO workflows (id, name, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('legacy-wf', 'Legacy', JSON.stringify(makeWorkflow('legacy-wf', 'Legacy')), 111, 222);
    legacy.close();

    // First openDb(): ALTER TABLE runs, existing row survives, version defaults to 0.
    const db1 = openDb(dbPath);
    const cols1 = db1.prepare(`PRAGMA table_info(workflows)`).all() as Array<{ name: string }>;
    expect(cols1.some((c) => c.name === 'version')).toBe(true);
    const row1 = db1.prepare(`SELECT * FROM workflows WHERE id = ?`).get('legacy-wf') as {
      name: string;
      json: string;
      created_at: number;
      updated_at: number;
      version: number;
    };
    expect(row1.name).toBe('Legacy');
    expect(row1.created_at).toBe(111);
    expect(row1.updated_at).toBe(222);
    expect(row1.version).toBe(0);
    db1.close();

    // Second and third openDb(): column already present, no error, data intact.
    const db2 = openDb(dbPath);
    expect(() => openDb(dbPath)).not.toThrow();
    const row2 = db2.prepare(`SELECT version FROM workflows WHERE id = ?`).get('legacy-wf') as { version: number };
    expect(row2.version).toBe(0);
    db2.close();

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('ConversationsRepo', () => {
  let db: Database.Database;
  let workflows: WorkflowsRepo;
  let repo: ConversationsRepo;
  let clock: number;

  beforeEach(() => {
    db = openDb(':memory:');
    clock = 1000;
    workflows = new WorkflowsRepo(db, () => clock);
    repo = new ConversationsRepo(db, () => clock);
  });

  afterEach(() => {
    db.close();
  });

  it('create() then get() round-trips, timestamps from now()', () => {
    workflows.create(makeWorkflow('wf-1'));
    const conv = repo.create({ id: 'c1', workflowId: 'wf-1', title: 'Hello' });
    expect(conv).toEqual({
      id: 'c1',
      workflowId: 'wf-1',
      title: 'Hello',
      createdAt: 1000,
      updatedAt: 1000,
      lastSeenChangeId: null,
    });
    expect(repo.get('c1')).toEqual(conv);
  });

  it('title defaults to empty string when omitted', () => {
    workflows.create(makeWorkflow('wf-1'));
    const conv = repo.create({ id: 'c1', workflowId: 'wf-1' });
    expect(conv.title).toBe('');
  });

  it('getByWorkflowId finds the 1-1 conversation', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1', title: 'X' });
    expect(repo.getByWorkflowId('wf-1')?.id).toBe('c1');
    expect(repo.getByWorkflowId('missing')).toBeUndefined();
  });

  it('enforces workflow_id UNIQUE: a second conversation for the same workflow throws', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1' });
    expect(() => repo.create({ id: 'c2', workflowId: 'wf-1' })).toThrow();
  });

  it('list() orders by updated_at DESC and supports search (including literal % and _)', () => {
    workflows.create(makeWorkflow('wf-1'));
    workflows.create(makeWorkflow('wf-2'));
    workflows.create(makeWorkflow('wf-3'));

    clock = 100;
    repo.create({ id: 'c1', workflowId: 'wf-1', title: 'Video TikTok mèo' });
    clock = 300;
    repo.create({ id: 'c2', workflowId: 'wf-2', title: 'Caption Facebook' });
    clock = 200;
    repo.create({ id: 'c3', workflowId: 'wf-3', title: '100% giảm giá' });

    const all = repo.list();
    expect(all.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);

    const searched = repo.list('facebook');
    expect(searched.map((c) => c.id)).toEqual(['c2']);

    // A literal '%' typed by the user must not act as a wildcard.
    const literalPercent = repo.list('100%');
    expect(literalPercent.map((c) => c.id)).toEqual(['c3']);
    expect(repo.list('100_').map((c) => c.id)).toEqual([]);
  });

  it('nodeCount reflects workflow.nodes.length and lastRunStatus reflects the newest run', () => {
    const wf = makeWorkflow('wf-1');
    wf.nodes = [
      { id: 'n1', type: 'mock.text', params: {} },
      { id: 'n2', type: 'mock.text', params: {} },
    ];
    workflows.create(wf);
    repo.create({ id: 'c1', workflowId: 'wf-1' });

    let summary = repo.list().find((c) => c.id === 'c1')!;
    expect(summary.nodeCount).toBe(2);
    expect(summary.lastRunStatus).toBeUndefined();

    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_json, status, created_at, finished_at) VALUES (?, ?, '{}', 'success', 10, 20)`,
    ).run('run-1', 'wf-1');
    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_json, status, created_at, finished_at) VALUES (?, ?, '{}', 'error', 30, 40)`,
    ).run('run-2', 'wf-1');

    summary = repo.list().find((c) => c.id === 'c1')!;
    expect(summary.lastRunStatus).toBe('error');
  });

  it('rename() updates title and bumps updated_at', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1', title: 'Old' });
    clock = 500;
    repo.rename('c1', 'New');
    const conv = repo.get('c1')!;
    expect(conv.title).toBe('New');
    expect(conv.updatedAt).toBe(500);
  });

  it('touch() bumps updated_at without touching title', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1', title: 'Same' });
    clock = 500;
    repo.touch('c1');
    const conv = repo.get('c1')!;
    expect(conv.title).toBe('Same');
    expect(conv.updatedAt).toBe(500);
  });

  it('setLastSeenChangeId sets and clears back to null', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1' });
    repo.setLastSeenChangeId('c1', 42);
    expect(repo.get('c1')?.lastSeenChangeId).toBe(42);
    repo.setLastSeenChangeId('c1', null);
    expect(repo.get('c1')?.lastSeenChangeId).toBeNull();
  });

  it('deleteCascade removes messages/changes/runs/node_runs/workflow/conversation', () => {
    workflows.create(makeWorkflow('wf-1'));
    repo.create({ id: 'c1', workflowId: 'wf-1' });
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES ('m1', 'c1', 'user', 'hi', 'done', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_changes (workflow_id, conversation_id, source, scope, ops_json, summary, snapshot_after, created_at)
       VALUES ('wf-1', 'c1', 'user', 'structural', '[]', 's', '{}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, workflow_id, workflow_json, status, created_at) VALUES ('run-1', 'wf-1', '{}', 'success', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO node_runs (run_id, node_id, state) VALUES ('run-1', 'n1', 'success')`,
    ).run();

    repo.deleteCascade('c1');

    expect(repo.get('c1')).toBeUndefined();
    expect(workflows.get('wf-1')).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'c1'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workflow_changes WHERE conversation_id = 'c1'`).get()).toEqual({
      n: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE workflow_id = 'wf-1'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM node_runs WHERE run_id = 'run-1'`).get()).toEqual({ n: 0 });
  });

  it('deleteCascade on an unknown id is a no-op', () => {
    expect(() => repo.deleteCascade('missing')).not.toThrow();
  });
});
