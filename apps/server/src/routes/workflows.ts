/**
 * Workflow CRUD + /validate (SPEC-step3.md §4).
 *
 * POST/PUT only shape-validate (WorkflowSchema) — a saved draft is allowed to
 * be topologically incomplete (missing edges, dangling required inputs,
 * etc.); only /api/workflows/validate runs the full validateWorkflow()
 * (schema + graph + registry) check.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodError } from 'zod';
import type { ChangesRepo } from '../db/changes.js';
import type { ConversationsRepo } from '../db/conversations.js';
import type { WorkflowsRepo } from '../db/workflows.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, WorkflowSchema, type ValidationIssue, type Workflow } from '../engine/schema.js';

export interface WorkflowsRouteDeps {
  workflowsRepo: WorkflowsRepo;
  registry: NodeRegistry;
  /** SPEC-step31.md F8 point 2: PUT logs a change row when nodes/edges
   * actually change. Both optional so any test/caller that only needs
   * plain CRUD (no change-log audit trail) can keep constructing
   * `WorkflowsRouteDeps` without them — PUT then silently skips logging,
   * same as a workflow with no paired conversation already does below. */
  conversationsRepo?: ConversationsRepo;
  changesRepo?: ChangesRepo;
}

/** SPEC-step31.md F8 point 2: "so sánh JSON.stringify bản cũ/mới" — only
 * `nodes`/`edges` matter (a rename-only PUT must NOT log, "tránh noise"). */
function structureChanged(before: Pick<Workflow, 'nodes' | 'edges'>, after: Pick<Workflow, 'nodes' | 'edges'>): boolean {
  return JSON.stringify(before.nodes) !== JSON.stringify(after.nodes) || JSON.stringify(before.edges) !== JSON.stringify(after.edges);
}

function zodErrorToIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'schema',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

export function registerWorkflowsRoutes(app: FastifyInstance, deps: WorkflowsRouteDeps): void {
  const { workflowsRepo, registry, conversationsRepo, changesRepo } = deps;

  app.get('/api/workflows', async () => workflowsRepo.list());

  app.post('/api/workflows', async (request, reply) => {
    const parsed = WorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid workflow', issues: zodErrorToIssues(parsed.error) });
      return;
    }
    const workflow = parsed.data;
    if (workflowsRepo.exists(workflow.id)) {
      reply.code(409).send({ error: `Workflow "${workflow.id}" already exists` });
      return;
    }
    workflowsRepo.create(workflow);
    reply.code(201).send({ id: workflow.id });
  });

  app.get('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = workflowsRepo.get(id);
    if (!workflow) {
      reply.code(404).send({ error: `Workflow "${id}" not found` });
      return;
    }
    reply.send(workflow);
  });

  app.put('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = WorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid workflow', issues: zodErrorToIssues(parsed.error) });
      return;
    }
    // The URL's :id is the source of truth for storage — always upsert under
    // it, regardless of whatever id the body itself carries.
    const workflow = { ...parsed.data, id };
    const before = workflowsRepo.get(id);
    workflowsRepo.upsert(workflow);

    // SPEC-step31.md F8 point 2: log a "Cập nhật thủ công (Save/JSON)" change
    // row when nodes/edges actually changed — the old Save button + JSON-view
    // Apply used to upsert silently, leaving a hole in the change-log chain
    // that made a later revert jump straight past this edit. Rename-only
    // PUTs stay silent (tránh noise). A workflow with no paired conversation
    // (legacy POST /api/workflows callers) also stays silent instead of
    // erroring — PUT's contract has never required a conversation.
    if (conversationsRepo && changesRepo && structureChanged(before ?? { nodes: [], edges: [] }, workflow)) {
      const conversation = conversationsRepo.getByWorkflowId(id);
      if (conversation) {
        changesRepo.create({
          workflowId: id,
          conversationId: conversation.id,
          source: 'user',
          scope: 'structural',
          ops: [],
          summary: 'Cập nhật thủ công (Save/JSON)',
          snapshotAfter: workflow,
        });
      }
    }

    reply.send({ id });
  });

  app.delete('/api/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    workflowsRepo.delete(id);
    reply.code(204).send();
  });

  app.post('/api/workflows/validate', async (request) => {
    const result = validateWorkflow(request.body, registry);
    return result.ok ? { ok: true, issues: [] } : { ok: false, issues: result.issues };
  });
}
