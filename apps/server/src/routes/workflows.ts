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
import type { WorkflowsRepo } from '../db/workflows.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, WorkflowSchema, type ValidationIssue } from '../engine/schema.js';

export interface WorkflowsRouteDeps {
  workflowsRepo: WorkflowsRepo;
  registry: NodeRegistry;
}

function zodErrorToIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'schema',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

export function registerWorkflowsRoutes(app: FastifyInstance, deps: WorkflowsRouteDeps): void {
  const { workflowsRepo, registry } = deps;

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
    workflowsRepo.upsert(workflow);
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
