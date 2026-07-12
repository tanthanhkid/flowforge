/**
 * SPEC-step22.md §7 points 5-6 — POST/GET /api/workflows/:id/changes (manual
 * "tay" edits, shape-validate only, no full validateWorkflow) + POST
 * .../changes/:changeId/revert.
 *
 * Uses a file-backed db (not ':memory:') throughout so the revert test can
 * open a second, direct `ChangesRepo`/`WorkflowsRepo` connection to seed
 * changes "qua ChangesRepo trực tiếp" per SPEC §7.6, alongside the live
 * server under test — mirrors api-sse.test.ts's dbFile-reuse pattern.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChangeDigest } from '../src/agent/changeDigest.js';
import { ChangesRepo, type WorkflowChange } from '../src/db/changes.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import type { Workflow } from '../src/engine/schema.js';
import { buildServer } from '../src/server.js';

describe('api-changes', () => {
  let app: FastifyInstance;
  let tmp: string;
  let dbPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-changes-'));
    dbPath = path.join(tmp, 'test.db');
    app = await buildServer({ dbPath, artifactsDir: tmp });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(): Promise<{ workflowId: string; conversationId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const conversation = (res.json() as { conversation: { id: string; workflowId: string } }).conversation;
    return { workflowId: conversation.workflowId, conversationId: conversation.id };
  }

  describe('POST /api/workflows/:id/changes', () => {
    it('happy path: version bump, source=user, scope correct, no snapshotAfter in the response', async () => {
      const { workflowId } = await setup();
      const ops = [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } }];

      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: { ops, expectedVersion: 0 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        change: Record<string, unknown>;
        workflow: { nodes: unknown[] };
        version: number;
      };
      expect(body.version).toBe(1);
      expect(body.workflow.nodes).toHaveLength(1);
      expect(body.change.source).toBe('user');
      expect(body.change.scope).toBe('structural');
      expect(body.change).not.toHaveProperty('snapshotAfter');

      const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/changes` });
      expect(list.statusCode).toBe(200);
      const changes = (list.json() as { changes: Array<{ id: number }> }).changes;
      expect(changes).toHaveLength(1);
    });

    it('409 on expectedVersion mismatch, includes current workflow + version, leaves the workflow untouched', async () => {
      const { workflowId } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: {
          ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } }],
          expectedVersion: 5,
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; workflow: { id: string; nodes: unknown[] }; version: number };
      expect(body.error).toBe('version-conflict');
      expect(body.version).toBe(0);
      expect(body.workflow.id).toBe(workflowId);
      expect(body.workflow.nodes).toEqual([]);
    });

    it('422 on PatchError (op referencing a node id that does not exist)', async () => {
      const { workflowId } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: {
          ops: [{ op: 'update-node', nodeId: 'does-not-exist', params: { x: 1 } }],
          expectedVersion: 0,
        },
      });
      expect(res.statusCode).toBe(422);
      const body = res.json() as { issues: Array<{ code: string }> };
      expect(body.issues[0]?.code).toBe('patch');
    });

    it('400 on a malformed body (missing expectedVersion, or empty ops array)', async () => {
      const { workflowId } = await setup();

      const missingVersion = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: { ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } }] },
      });
      expect(missingVersion.statusCode).toBe(400);

      const emptyOps = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: { ops: [], expectedVersion: 0 },
      });
      expect(emptyOps.statusCode).toBe(400);
    });

    it('404 for an unknown workflow id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workflows/does-not-exist/changes',
        payload: { ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } }], expectedVersion: 0 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('500 + leaves workflow untouched + logs no change when the workflow has no paired conversation', async () => {
      // Regression for SPEC-step22.md review finding: requireConversationId()
      // must run BEFORE saveVersioned() commits, otherwise a workflow created
      // via the legacy POST /api/workflows (which never pairs a conversation)
      // gets silently mutated + version-bumped even though the request 500s
      // and no workflow_changes row is written (partial write, no audit/revert
      // point).
      const workflowId = 'no-conversation-wf';
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        payload: { version: 1, id: workflowId, name: 'Không có conversation', nodes: [], edges: [] },
      });
      expect(createRes.statusCode).toBe(201);

      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: {
          ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'hi' } } }],
          expectedVersion: 0,
        },
      });
      expect(res.statusCode).toBe(500);

      const stillRaw = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}` });
      const stillWorkflow = stillRaw.json() as { nodes: unknown[] };
      expect(stillWorkflow.nodes).toEqual([]); // untouched, not patched

      const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/changes` });
      expect((list.json() as { changes: unknown[] }).changes).toEqual([]); // no audit row written

      // version must also stay at 0 -- saveVersioned() must not have committed.
      let raw: Database.Database | undefined;
      try {
        raw = openDb(dbPath);
        expect(new WorkflowsRepo(raw).getVersion(workflowId)).toBe(0);
      } finally {
        raw?.close();
      }
    });

    it('accepts a structurally-draft workflow (required input left unwired) -- 200, NOT full-validated', async () => {
      const { workflowId } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes`,
        payload: {
          // llm.generate's `prompt` input is required but has no edge feeding
          // it here -- validateWorkflow() would reject this; the manual-edit
          // route only shape-validates (WorkflowSchema), mirroring the
          // existing PUT /api/workflows draft tolerance.
          ops: [{ op: 'add-node', node: { id: 'lonely', type: 'llm.generate', params: {} } }],
          expectedVersion: 0,
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/workflows/:id/changes/:changeId/revert', () => {
    function snapshotWithNodes(workflowId: string, nodes: Workflow['nodes']): Workflow {
      return { version: 1, id: workflowId, name: 'Workflow mới', nodes, edges: [] };
    }

    /** Seeds 2 AI changes directly via ChangesRepo/WorkflowsRepo (SPEC §7.6:
     * "qua ChangesRepo trực tiếp") on a second, direct connection to the same
     * db file the live `app` is already serving. */
    function seedTwoAiChanges(workflowId: string, conversationId: string): { first: WorkflowChange; second: WorkflowChange } {
      let raw: Database.Database | undefined;
      try {
        raw = openDb(dbPath);
        const workflows = new WorkflowsRepo(raw);
        const changes = new ChangesRepo(raw);

        const snap1 = snapshotWithNodes(workflowId, [{ id: 'n1', type: 'input.text', params: { value: 'a' } }]);
        workflows.saveVersioned(snap1, 0);
        const first = changes.create({
          workflowId,
          conversationId,
          source: 'ai',
          scope: 'structural',
          ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'a' } } }],
          summary: 'AI: +1 node',
          snapshotAfter: snap1,
        });

        const snap2 = snapshotWithNodes(workflowId, [
          ...snap1.nodes,
          { id: 'n2', type: 'output.collect', params: {} },
        ]);
        workflows.saveVersioned(snap2, 1);
        const second = changes.create({
          workflowId,
          conversationId,
          source: 'ai',
          scope: 'structural',
          ops: [{ op: 'add-node', node: { id: 'n2', type: 'output.collect', params: {} } }],
          summary: 'AI: +1 node',
          snapshotAfter: snap2,
        });

        return { first, second };
      } finally {
        raw?.close();
      }
    }

    it('reverting the 2nd change restores the snapshot right after the 1st', async () => {
      const { workflowId, conversationId } = await setup();
      const { first, second } = seedTwoAiChanges(workflowId, conversationId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes/${second.id}/revert`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { change: Record<string, unknown>; workflow: Workflow; version: number };
      expect(body.version).toBe(3); // 2 seeded versions + this revert's own bump
      expect(body.workflow).toEqual(first.snapshotAfter);
      expect(body.change.source).toBe('user');
      expect(body.change.scope).toBe('structural');
      expect(body.change.summary).toBe(`Khôi phục về trước thay đổi #${second.id}`);
      expect(body.change).not.toHaveProperty('snapshotAfter');
    });

    it('reverting the FIRST change restores an emptyWorkflow with the name kept', async () => {
      const { workflowId, conversationId } = await setup();
      const { first } = seedTwoAiChanges(workflowId, conversationId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes/${first.id}/revert`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { workflow: Workflow };
      expect(body.workflow).toEqual({ version: 1, id: workflowId, name: 'Workflow mới', nodes: [], edges: [] });
    });

    it('404 for an unknown changeId, or one belonging to a different workflow', async () => {
      const { workflowId, conversationId } = await setup();
      const { first } = seedTwoAiChanges(workflowId, conversationId);

      const missing = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes/999999/revert`,
      });
      expect(missing.statusCode).toBe(404);

      const other = await setup();
      const wrongWorkflow = await app.inject({
        method: 'POST',
        url: `/api/workflows/${other.workflowId}/changes/${first.id}/revert`,
      });
      expect(wrongWorkflow.statusCode).toBe(404);
    });

    it('500 + leaves workflow untouched + logs no new change when the workflow has no paired conversation', async () => {
      // Same regression as the POST /changes test above, for the revert
      // route: requireConversationId() must run BEFORE saveVersioned(prev)
      // commits. Seeds a pre-existing change row directly (workflow_changes
      // has no FK enforcement, per db/conversations.ts's comment) against a
      // workflow created via the legacy, conversation-less POST /api/workflows.
      const workflowId = 'no-conversation-wf-revert';
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/workflows',
        payload: { version: 1, id: workflowId, name: 'Không có conversation', nodes: [], edges: [] },
      });
      expect(createRes.statusCode).toBe(201);

      let seeded: WorkflowChange;
      let raw: Database.Database | undefined;
      try {
        raw = openDb(dbPath);
        const workflows = new WorkflowsRepo(raw);
        const changes = new ChangesRepo(raw);
        const snap = snapshotWithNodes(workflowId, [{ id: 'n1', type: 'input.text', params: { value: 'a' } }]);
        workflows.saveVersioned(snap, 0);
        seeded = changes.create({
          workflowId,
          conversationId: 'orphan-conversation-id',
          source: 'user',
          scope: 'structural',
          ops: [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: { value: 'a' } } }],
          summary: 'seed',
          snapshotAfter: snap,
        });
      } finally {
        raw?.close();
      }

      const res = await app.inject({
        method: 'POST',
        url: `/api/workflows/${workflowId}/changes/${seeded.id}/revert`,
      });
      expect(res.statusCode).toBe(500);

      const list = await app.inject({
        method: 'GET',
        url: `/api/workflows/${workflowId}/changes?includeCosmetic=true`,
      });
      expect((list.json() as { changes: unknown[] }).changes).toHaveLength(1); // only the seeded row, no revert row added

      let raw2: Database.Database | undefined;
      try {
        raw2 = openDb(dbPath);
        expect(new WorkflowsRepo(raw2).getVersion(workflowId)).toBe(1); // still the seeded version, not bumped again
      } finally {
        raw2?.close();
      }
    });

    it('logs a new ops:[] change whose digest line the next AI turn would see', async () => {
      const { workflowId, conversationId } = await setup();
      const { second } = seedTwoAiChanges(workflowId, conversationId);

      await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/changes/${second.id}/revert` });

      const list = await app.inject({
        method: 'GET',
        url: `/api/workflows/${workflowId}/changes?includeCosmetic=true`,
      });
      const changes = (list.json() as { changes: unknown[] }).changes as WorkflowChange[];

      const revertChange = changes.find((c) => c.ops.length === 0);
      expect(revertChange?.summary).toBe(`Khôi phục về trước thay đổi #${second.id}`);

      const digest = buildChangeDigest(changes);
      expect(digest).toContain(`[tay] Khôi phục về trước thay đổi #${second.id}`);
    });
  });
});
