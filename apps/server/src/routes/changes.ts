/**
 * Workflow-changes HTTP routes (SPEC-step22.md §5): listing the change log,
 * logging a manual ("tay") edit as one shared PatchOp batch, and reverting
 * to the snapshot right before a given change.
 *
 * POST here deliberately only shape-validates the patched workflow
 * (WorkflowSchema) instead of running the full validateWorkflow() (schema +
 * graph + registry) — a manual, step-by-step edit from the canvas routinely
 * passes through in-between states (a node with no edges yet, a dangling
 * required input) exactly like the existing PUT /api/workflows/:id already
 * tolerates for drafts. Full validation stays reserved for AI turns
 * (chatTurn.ts), which must always hand back a runnable workflow.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { summarizeOps } from '../agent/chatTurn.js';
import { applyPatch, changeScope, PatchError, PatchOpArraySchema } from '../agent/patch.js';
import type { WorkflowChange } from '../db/changes.js';
import type { ChangesRepo } from '../db/changes.js';
import type { ConversationsRepo } from '../db/conversations.js';
import { VersionConflictError, type WorkflowsRepo } from '../db/workflows.js';
import { emptyWorkflow, WorkflowSchema, type ValidationIssue, type Workflow } from '../engine/schema.js';

export interface ChangesRouteDeps {
  workflowsRepo: WorkflowsRepo;
  changesRepo: ChangesRepo;
  conversationsRepo: ConversationsRepo;
}

const ChangesRequestSchema = z.object({
  ops: PatchOpArraySchema.min(1),
  summary: z.string().min(1).optional(),
  expectedVersion: z.number(),
});

function zodErrorToIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'schema',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

/** Drops `snapshotAfter` (SPEC §5: "KHÔNG trả snapshotAfter" — it's heavy and
 * only ever needed internally by `getPrevSnapshot()` for revert). */
function toPublicChange(change: WorkflowChange): Omit<WorkflowChange, 'snapshotAfter'> {
  const { snapshotAfter: _snapshotAfter, ...rest } = change;
  return rest;
}

/**
 * Every workflow is expected to have exactly one paired conversation (the
 * 1-1 invariant DESIGN-ai-native.md's migration/backfill maintains) — a
 * manual change always needs a `conversation_id` to log against. Missing one
 * here means the invariant broke somewhere upstream, which is a genuine bug
 * rather than a normal 4xx the caller could act on.
 */
function requireConversationId(conversationsRepo: ConversationsRepo, workflowId: string): string {
  const conversation = conversationsRepo.getByWorkflowId(workflowId);
  if (!conversation) {
    throw new Error(`Workflow "${workflowId}" không có conversation 1-1 tương ứng (dữ liệu không nhất quán).`);
  }
  return conversation.id;
}

export function registerChangesRoutes(app: FastifyInstance, deps: ChangesRouteDeps): void {
  const { workflowsRepo, changesRepo, conversationsRepo } = deps;

  app.get('/api/workflows/:id/changes', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workflowsRepo.exists(id)) {
      reply.code(404).send({ error: `Workflow "${id}" not found` });
      return;
    }

    const query = request.query as { since?: string; limit?: string; includeCosmetic?: string };
    const sinceId = query.since !== undefined && Number.isFinite(Number(query.since)) ? Number(query.since) : undefined;
    const parsedLimit = query.limit !== undefined ? Number(query.limit) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 100;
    const includeCosmetic = query.includeCosmetic === 'true';

    const changes = changesRepo.listByWorkflow(id, { sinceId, limit, includeCosmetic });
    reply.send({ changes: changes.map(toPublicChange) });
  });

  app.post('/api/workflows/:id/changes', async (request, reply) => {
    const { id } = request.params as { id: string };

    const current = workflowsRepo.getWithVersion(id);
    if (!current) {
      reply.code(404).send({ error: `Workflow "${id}" not found` });
      return;
    }

    const parsed = ChangesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid request body', issues: zodErrorToIssues(parsed.error) });
      return;
    }
    const { ops, summary, expectedVersion } = parsed.data;

    if (current.version !== expectedVersion) {
      reply.code(409).send({ error: 'version-conflict', workflow: current.workflow, version: current.version });
      return;
    }

    let patched: Workflow;
    try {
      patched = applyPatch(current.workflow, ops);
    } catch (err) {
      const message = err instanceof PatchError ? err.message : err instanceof Error ? err.message : String(err);
      reply.code(422).send({ error: message, issues: [{ code: 'patch', message }] });
      return;
    }

    const shapeParsed = WorkflowSchema.safeParse(patched);
    if (!shapeParsed.success) {
      reply.code(422).send({ error: 'Invalid workflow', issues: zodErrorToIssues(shapeParsed.error) });
      return;
    }
    const next = shapeParsed.data;

    // Must run BEFORE saveVersioned() below: this throws (→ 500) when the
    // workflow has no paired conversation, and saveVersioned() commits its
    // write immediately (better-sqlite3's db.transaction() is synchronous).
    // Checking first keeps a missing-conversation request a no-op instead of
    // mutating + version-bumping the workflow with no workflow_changes row
    // to show for it (partial write — the bug this order fixes).
    const conversationId = requireConversationId(conversationsRepo, id);

    let newVersion: number;
    try {
      newVersion = workflowsRepo.saveVersioned(next, expectedVersion);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        const latest = workflowsRepo.getWithVersion(id)!;
        reply.code(409).send({ error: 'version-conflict', workflow: latest.workflow, version: latest.version });
        return;
      }
      throw err;
    }

    const change = changesRepo.create({
      workflowId: id,
      conversationId,
      source: 'user',
      scope: changeScope(ops),
      ops,
      summary: summary || summarizeOps(ops),
      snapshotAfter: next,
    });

    reply.code(200).send({ change: toPublicChange(change), workflow: next, version: newVersion });
  });

  app.post('/api/workflows/:id/changes/:changeId/revert', async (request, reply) => {
    const { id, changeId } = request.params as { id: string; changeId: string };
    const changeIdNum = Number(changeId);
    const change = Number.isFinite(changeIdNum) ? changesRepo.get(changeIdNum) : undefined;
    if (!change || change.workflowId !== id) {
      reply.code(404).send({ error: `Change "${changeId}" not found` });
      return;
    }

    const currentWorkflow = workflowsRepo.get(id);
    const prevSnapshot = changesRepo.getPrevSnapshot(id, change.id) as Workflow | undefined;
    const prev = prevSnapshot ?? emptyWorkflow(id, currentWorkflow?.name ?? '');

    // Must run BEFORE saveVersioned() below — same partial-write hazard as
    // the POST /changes route above: saveVersioned() commits synchronously,
    // so checking the conversation first keeps a missing-conversation
    // request a no-op instead of reverting the workflow with no
    // workflow_changes row logged for it.
    const conversationId = requireConversationId(conversationsRepo, id);

    // Deliberately no `expectedVersion` (SPEC §5: "revert là hành động chủ
    // đích") — a chat turn racing this will see the new version itself and
    // take its own version-conflict branch (SPEC-step21.md §4.5).
    const newVersion = workflowsRepo.saveVersioned(prev);

    const newChange = changesRepo.create({
      workflowId: id,
      conversationId,
      source: 'user',
      scope: 'structural',
      ops: [],
      summary: `Khôi phục về trước thay đổi #${change.id}`,
      snapshotAfter: prev,
    });

    reply.code(200).send({ change: toPublicChange(newChange), workflow: prev, version: newVersion });
  });
}
