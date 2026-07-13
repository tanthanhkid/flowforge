/**
 * SPEC-step31.md F8 — data-loss revert fix:
 *  1. `ChangesRepo.seedInitialSnapshots()` (db/changes.ts), wired into the
 *     same startup call site as `backfillConversations` (server.ts) and the
 *     seed script — every workflow with a conversation but zero change rows
 *     gets one `ops: []` "Trạng thái khởi tạo" row so a revert of its first
 *     real change has a correct predecessor instead of falling back to
 *     `emptyWorkflow()`.
 *  2. `PUT /api/workflows/:id` (routes/workflows.ts) logs a
 *     "Cập nhật thủ công (Save/JSON)" change row when nodes/edges actually
 *     change; rename-only PUTs stay silent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChangeDigest } from '../src/agent/changeDigest.js';
import { ChangesRepo, type WorkflowChange } from '../src/db/changes.js';
import { ConversationsRepo } from '../src/db/conversations.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';
import { buildServer } from '../src/server.js';

function makeWorkflow(id: string, nodes: Workflow['nodes'] = [], name = ''): Workflow {
  return { version: 1, id, name, nodes, edges: [] };
}

function legacyFourNodeWorkflow(id: string): Workflow {
  return makeWorkflow(
    id,
    [
      { id: 'n1', type: 'input.text', params: { value: 'a' } },
      { id: 'n2', type: 'input.text', params: { value: 'b' } },
      { id: 'n3', type: 'input.text', params: { value: 'c' } },
      { id: 'n4', type: 'input.text', params: { value: 'd' } },
    ],
    'Legacy workflow',
  );
}

describe('ChangesRepo.seedInitialSnapshots', () => {
  let db: ReturnType<typeof openDb>;

  afterEach(() => {
    db.close();
  });

  it('inserts exactly 1 ops:[] "Trạng thái khởi tạo" row per workflow that has a conversation but no change row', () => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(legacyFourNodeWorkflow('wf-1'));
    new ConversationsRepo(db).create({ id: 'c1', workflowId: 'wf-1' });
    const changes = new ChangesRepo(db);

    const created = changes.seedInitialSnapshots(() => 5000);
    expect(created).toBe(1);

    const rows = changes.listByWorkflow('wf-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'user',
      scope: 'structural',
      ops: [],
      summary: 'Trạng thái khởi tạo',
    });
    expect(rows[0]?.snapshotAfter).toEqual(legacyFourNodeWorkflow('wf-1'));
  });

  it('is idempotent: a second run creates 0 more rows, total stays 1', () => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(legacyFourNodeWorkflow('wf-1'));
    new ConversationsRepo(db).create({ id: 'c1', workflowId: 'wf-1' });
    const changes = new ChangesRepo(db);

    expect(changes.seedInitialSnapshots(() => 1000)).toBe(1);
    expect(changes.seedInitialSnapshots(() => 2000)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workflow_changes`).get()).toEqual({ n: 1 });
  });

  it('skips a workflow with no paired conversation', () => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(legacyFourNodeWorkflow('orphan-no-conv'));
    const changes = new ChangesRepo(db);

    expect(changes.seedInitialSnapshots()).toBe(0);
    expect(changes.listByWorkflow('orphan-no-conv')).toHaveLength(0);
  });

  it('skips a workflow that already has at least one change row (does not double-seed)', () => {
    db = openDb(':memory:');
    new WorkflowsRepo(db).create(legacyFourNodeWorkflow('wf-1'));
    new ConversationsRepo(db).create({ id: 'c1', workflowId: 'wf-1' });
    const changes = new ChangesRepo(db);
    changes.create({
      workflowId: 'wf-1',
      conversationId: 'c1',
      source: 'ai',
      scope: 'structural',
      ops: [{ op: 'add-node' }],
      summary: 'already has history',
      snapshotAfter: legacyFourNodeWorkflow('wf-1'),
    });

    expect(changes.seedInitialSnapshots()).toBe(0);
    expect(changes.listByWorkflow('wf-1')).toHaveLength(1);
    expect(changes.listByWorkflow('wf-1')[0]?.summary).toBe('already has history');
  });
});

describe('server startup wires seedInitialSnapshots after backfillConversations (regression for the real data-loss bug)', () => {
  let app: FastifyInstance;
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step31-'));
    dbPath = path.join(tmp, 'test.db');
  });

  afterEach(async () => {
    await app?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a pre-existing 4-node workflow with zero change rows gets an initial snapshot on boot, then survives a revert of its first real change', async () => {
    // Simulate a workflow that predates the change-log epoch: created
    // directly via WorkflowsRepo (no conversation, no change rows) before
    // the server has ever booted against this db file — mirrors the 11
    // samples / any hand-created workflow backfill step 20 already handles.
    const seedDb = openDb(dbPath);
    new WorkflowsRepo(seedDb).create(legacyFourNodeWorkflow('wf-legacy'));
    seedDb.close();

    app = await buildServer({ dbPath, artifactsDir: tmp });

    const before = await app.inject({
      method: 'GET',
      url: '/api/workflows/wf-legacy/changes?includeCosmetic=true',
    });
    expect(before.statusCode).toBe(200);
    const beforeChanges = (before.json() as { changes: WorkflowChange[] }).changes;
    expect(beforeChanges).toHaveLength(1);
    expect(beforeChanges[0]).toMatchObject({ ops: [], summary: 'Trạng thái khởi tạo', scope: 'structural', source: 'user' });

    const addNode = await app.inject({
      method: 'POST',
      url: '/api/workflows/wf-legacy/changes',
      payload: {
        ops: [{ op: 'add-node', node: { id: 'n5', type: 'input.text', params: { value: 'e' } } }],
        expectedVersion: 0,
      },
    });
    expect(addNode.statusCode).toBe(200);
    const addBody = addNode.json() as { change: { id: number }; workflow: { nodes: unknown[] } };
    expect(addBody.workflow.nodes).toHaveLength(5);

    const revert = await app.inject({
      method: 'POST',
      url: `/api/workflows/wf-legacy/changes/${addBody.change.id}/revert`,
    });
    expect(revert.statusCode).toBe(200);
    const revertBody = revert.json() as { workflow: Workflow };

    // The bug this fixes: without the seeded initial snapshot, this would
    // have fallen back to emptyWorkflow() and lost all 4 original nodes.
    expect(revertBody.workflow.nodes).toHaveLength(4);
    expect(revertBody.workflow.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(revertBody.workflow.name).toBe('Legacy workflow');
  });
});

describe('PUT /api/workflows/:id logs a manual change row on structural edits (F8 point 2)', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-step31-put-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(): Promise<{ workflowId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const conversation = (res.json() as { conversation: { workflowId: string } }).conversation;
    return { workflowId: conversation.workflowId };
  }

  it('a PUT that adds nodes logs one "Cập nhật thủ công (Save/JSON)" change row; digest renders it as one clean line', async () => {
    const { workflowId } = await setup();

    const put = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflowId}`,
      payload: {
        version: 1,
        id: workflowId,
        name: 'Workflow mới',
        nodes: [{ id: 'n1', type: 'input.text', params: { value: 'hi' } }],
        edges: [],
      },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/changes` });
    const changes = (list.json() as { changes: WorkflowChange[] }).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ops: [],
      scope: 'structural',
      source: 'user',
      summary: 'Cập nhật thủ công (Save/JSON)',
    });

    // Same ops:[] rendering path as a revert row -- one clean digest line,
    // no crash, no per-op noise.
    const digest = buildChangeDigest(changes);
    expect(digest).toBe('[tay] Cập nhật thủ công (Save/JSON)');
  });

  it('a PUT that only renames the workflow logs no change row (tránh noise)', async () => {
    const { workflowId } = await setup();

    const withNode = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflowId}`,
      payload: {
        version: 1,
        id: workflowId,
        name: 'Workflow mới',
        nodes: [{ id: 'n1', type: 'input.text', params: { value: 'hi' } }],
        edges: [],
      },
    });
    expect(withNode.statusCode).toBe(200);

    const renameOnly = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${workflowId}`,
      payload: {
        version: 1,
        id: workflowId,
        name: 'Đổi tên thôi',
        nodes: [{ id: 'n1', type: 'input.text', params: { value: 'hi' } }],
        edges: [],
      },
    });
    expect(renameOnly.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/changes` });
    const changes = (list.json() as { changes: WorkflowChange[] }).changes;
    // Still just the one row from the structural PUT above -- the
    // rename-only PUT added nothing.
    expect(changes).toHaveLength(1);
  });

  it('a PUT against a workflow with no paired conversation (legacy POST /api/workflows) still 200s and logs nothing', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { version: 1, id: 'no-conv-wf', name: '', nodes: [], edges: [] },
    });
    expect(create.statusCode).toBe(201);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/workflows/no-conv-wf',
      payload: {
        version: 1,
        id: 'no-conv-wf',
        name: '',
        nodes: [{ id: 'n1', type: 'input.text', params: { value: 'hi' } }],
        edges: [],
      },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/workflows/no-conv-wf/changes' });
    expect((list.json() as { changes: unknown[] }).changes).toEqual([]);
  });
});
