/**
 * SPEC-step20.md §5.4 — ChangesRepo.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangesRepo } from '../src/db/changes.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';

function makeWorkflow(id: string): Workflow {
  return { version: 1, id, name: '', nodes: [], edges: [] };
}

describe('ChangesRepo', () => {
  let db: Database.Database;
  let repo: ChangesRepo;
  let clock: number;

  beforeEach(() => {
    db = openDb(':memory:');
    clock = 1000;
    new WorkflowsRepo(db, () => clock).create(makeWorkflow('wf-1'));
    new ConversationsRepo(db, () => clock).create({ id: 'c1', workflowId: 'wf-1' });
    repo = new ChangesRepo(db, () => clock);
  });

  afterEach(() => {
    db.close();
  });

  function create(overrides: Partial<Parameters<ChangesRepo['create']>[0]> = {}) {
    return repo.create({
      workflowId: 'wf-1',
      conversationId: 'c1',
      source: 'ai',
      scope: 'structural',
      ops: [{ op: 'add-node' }],
      summary: 'change',
      snapshotAfter: { version: 1, id: 'wf-1', name: '', nodes: [], edges: [] },
      ...overrides,
    });
  }

  it('id auto-increments across successive create() calls', () => {
    const c1 = create({ summary: 'first' });
    const c2 = create({ summary: 'second' });
    const c3 = create({ summary: 'third' });
    expect(c2.id).toBeGreaterThan(c1.id);
    expect(c3.id).toBeGreaterThan(c2.id);
  });

  it('round-trips ops/snapshotAfter (JSON) and optional messageId', () => {
    const snapshot = { version: 1, id: 'wf-1', name: 'Named', nodes: [{ id: 'n1', type: 'x', params: {} }], edges: [] };
    const change = create({
      source: 'ai',
      messageId: 'm1',
      ops: [{ op: 'add-node', nodeId: 'n1' }],
      snapshotAfter: snapshot,
    });
    expect(change.messageId).toBe('m1');
    expect(change.ops).toEqual([{ op: 'add-node', nodeId: 'n1' }]);
    expect(change.snapshotAfter).toEqual(snapshot);
    expect(repo.get(change.id)).toEqual(change);
  });

  it('get() returns undefined for an unknown id', () => {
    expect(repo.get(999999)).toBeUndefined();
  });

  it('latestForWorkflow returns the highest-id row for that workflow', () => {
    create({ summary: 'first' });
    const last = create({ summary: 'second' });
    expect(repo.latestForWorkflow('wf-1')?.id).toBe(last.id);
    expect(repo.latestForWorkflow('missing-wf')).toBeUndefined();
  });

  it('listByWorkflow hides cosmetic rows by default', () => {
    create({ scope: 'structural', summary: 'a' });
    create({ scope: 'cosmetic', summary: 'move' });
    create({ scope: 'structural', summary: 'b' });

    const structural = repo.listByWorkflow('wf-1');
    expect(structural.map((c) => c.summary)).toEqual(['a', 'b']);

    const all = repo.listByWorkflow('wf-1', { includeCosmetic: true });
    expect(all.map((c) => c.summary)).toEqual(['a', 'move', 'b']);
  });

  it('listByWorkflow respects sinceId (id > sinceId) and orders ascending', () => {
    const c1 = create({ summary: 'a' });
    const c2 = create({ summary: 'b' });
    const c3 = create({ summary: 'c' });

    expect(repo.listByWorkflow('wf-1', { sinceId: c1.id }).map((c) => c.id)).toEqual([c2.id, c3.id]);
    expect(repo.listByWorkflow('wf-1', { sinceId: c3.id })).toEqual([]);
  });

  it('listByWorkflow respects limit (default 100)', () => {
    for (let i = 0; i < 5; i++) create({ summary: `n${i}` });
    expect(repo.listByWorkflow('wf-1', { limit: 2 })).toHaveLength(2);
    expect(repo.listByWorkflow('wf-1')).toHaveLength(5);
  });

  it('getPrevSnapshot returns the snapshot_after of the immediately preceding row, undefined for the first', () => {
    const snap1 = { version: 1 as const, id: 'wf-1', name: 'v1', nodes: [], edges: [] };
    const snap2 = { version: 1 as const, id: 'wf-1', name: 'v2', nodes: [], edges: [] };
    const c1 = create({ snapshotAfter: snap1 });
    const c2 = create({ snapshotAfter: snap2 });

    expect(repo.getPrevSnapshot('wf-1', c1.id)).toBeUndefined();
    expect(repo.getPrevSnapshot('wf-1', c2.id)).toEqual(snap1);
  });

  it('getPrevSnapshot scopes by workflow_id (does not leak across workflows)', () => {
    new WorkflowsRepo(db, () => clock).create(makeWorkflow('wf-2'));
    new ConversationsRepo(db, () => clock).create({ id: 'c2', workflowId: 'wf-2' });

    create({ summary: 'wf-1 change' });
    const wf2Change = repo.create({
      workflowId: 'wf-2',
      conversationId: 'c2',
      source: 'user',
      scope: 'structural',
      ops: [],
      summary: 'wf-2 change',
      snapshotAfter: { version: 1, id: 'wf-2', name: '', nodes: [], edges: [] },
    });

    expect(repo.getPrevSnapshot('wf-2', wf2Change.id)).toBeUndefined();
  });
});
