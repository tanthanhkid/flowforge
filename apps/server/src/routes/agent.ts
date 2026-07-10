/**
 * Agent layer routes (SPEC-step5.md §5): natural-language -> workflow JSON
 * (generate) and workflow + nodeId + instruction -> patched workflow (edit).
 *
 * Both handlers delegate all the retry/validate work to
 * agent/generateWorkflow.ts and agent/editNode.ts — this file only maps
 * body shape + the errors those throw onto HTTP status codes:
 *   - 400: missing/malformed request body, or (edit-node) unknown nodeId
 *   - 422: AgentValidationError (LLM never produced a valid
 *     workflow/patch after MAX_ATTEMPTS) — includes `issues`
 *   - 502: anything else (OpenRouter HttpError, network failure, ...) —
 *     chatCompletion() (nodes/providers/openrouter.ts) already strips any
 *     header/key value out of its error message before it gets here, so
 *     relaying `err.message` verbatim is safe.
 */
import type { FastifyInstance } from 'fastify';
import { editNode, NodeNotFoundError } from '../agent/editNode.js';
import { AgentValidationError, generateWorkflow } from '../agent/generateWorkflow.js';
import type { NodeRegistry } from '../engine/registry.js';
import { WorkflowSchema } from '../engine/schema.js';

export interface AgentRouteDeps {
  registry: NodeRegistry;
}

interface GenerateWorkflowBody {
  description?: unknown;
  model?: unknown;
}

interface EditNodeBody {
  workflow?: unknown;
  nodeId?: unknown;
  instruction?: unknown;
  model?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { registry } = deps;

  app.post('/api/agent/generate-workflow', async (request, reply) => {
    const body = (request.body ?? {}) as GenerateWorkflowBody;

    if (typeof body.description !== 'string' || body.description.trim().length < 3) {
      reply.code(400).send({ error: 'description is required (string, min length 3)' });
      return;
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      reply.code(400).send({ error: 'model must be a string' });
      return;
    }

    try {
      const result = await generateWorkflow({ description: body.description, model: body.model, registry });
      reply.code(200).send(result);
    } catch (err) {
      if (err instanceof AgentValidationError) {
        reply.code(422).send({ error: err.message, issues: err.issues });
        return;
      }
      reply.code(502).send({ error: errorMessage(err) });
    }
  });

  app.post('/api/agent/edit-node', async (request, reply) => {
    const body = (request.body ?? {}) as EditNodeBody;

    if (body.workflow === undefined || body.workflow === null || typeof body.workflow !== 'object') {
      reply.code(400).send({ error: 'workflow is required' });
      return;
    }
    const workflowParsed = WorkflowSchema.safeParse(body.workflow);
    if (!workflowParsed.success) {
      reply.code(400).send({ error: 'workflow is invalid', issues: workflowParsed.error.issues });
      return;
    }
    if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) {
      reply.code(400).send({ error: 'nodeId is required' });
      return;
    }
    if (typeof body.instruction !== 'string' || body.instruction.trim().length === 0) {
      reply.code(400).send({ error: 'instruction is required' });
      return;
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      reply.code(400).send({ error: 'model must be a string' });
      return;
    }

    try {
      const result = await editNode({
        workflow: workflowParsed.data,
        nodeId: body.nodeId,
        instruction: body.instruction,
        model: body.model,
        registry,
      });
      reply.code(200).send(result);
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      if (err instanceof AgentValidationError) {
        reply.code(422).send({ error: err.message, issues: err.issues });
        return;
      }
      reply.code(502).send({ error: errorMessage(err) });
    }
  });
}
