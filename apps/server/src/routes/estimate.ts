/**
 * POST /api/estimate (SPEC-step15.md §2): body = workflow JSON (shape-parsed
 * via `WorkflowSchema`, same "shape only, not full graph validation" rule as
 * POST/PUT /api/workflows — an estimate should still work on a draft that
 * isn't fully wired up yet) -> `CostEstimate`. Never calls a real API.
 */
import type { FastifyInstance } from 'fastify';
import { estimateWorkflowCost } from '../engine/costEstimate.js';
import { WorkflowSchema } from '../engine/schema.js';

export function registerEstimateRoutes(app: FastifyInstance): void {
  app.post('/api/estimate', async (request, reply) => {
    const parsed = WorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'Invalid workflow',
        issues: parsed.error.issues.map((issue) => ({
          code: 'schema',
          message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        })),
      });
      return;
    }
    reply.send(estimateWorkflowCost(parsed.data));
  });
}
