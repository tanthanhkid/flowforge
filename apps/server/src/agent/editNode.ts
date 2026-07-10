/**
 * `editNode` (SPEC-step5.md §4): workflow + target nodeId + free-form
 * instruction -> a JSON patch (see patch.ts) applied on top of the workflow,
 * via OpenRouter with the same validate-and-retry loop as generateWorkflow.
 */
import type { ZodError } from 'zod';
import { getEnv } from '../config.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, type ValidationIssue, type Workflow } from '../engine/schema.js';
import { chatCompletion, type ChatMessage } from '../nodes/providers/openrouter.js';
import { AgentValidationError, issuesToFeedback } from './generateWorkflow.js';
import { extractJson } from './json.js';
import { applyPatch, PatchError, PatchOpArraySchema, type PatchOp } from './patch.js';
import { buildEditSystemPrompt } from './promptBuilder.js';

const MAX_ATTEMPTS = 3;

const PARSE_ISSUE: ValidationIssue = {
  code: 'parse',
  message: 'Không parse được JSON từ phản hồi của model.',
};

/** Thrown when `nodeId` doesn't exist in `workflow` — checked *before* any
 * LLM call (SPEC-step5.md §4: "nodeId không tồn tại trong workflow -> throw
 * ngay ... không gọi LLM"). routes/agent.ts maps this to a 400. */
export class NodeNotFoundError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Node "${nodeId}" không tồn tại trong workflow.`);
    this.name = 'NodeNotFoundError';
    this.nodeId = nodeId;
  }
}

export interface EditNodeArgs {
  workflow: Workflow;
  nodeId: string;
  instruction: string;
  model?: string;
  registry: NodeRegistry;
}

export interface EditNodeResult {
  workflow: Workflow;
  ops: PatchOp[];
  attempts: number;
}

function zodErrorToIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'parse',
    message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }));
}

export async function editNode(args: EditNodeArgs): Promise<EditNodeResult> {
  const { workflow, nodeId, instruction, registry } = args;

  if (!workflow.nodes.some((n) => n.id === nodeId)) {
    throw new NodeNotFoundError(nodeId);
  }

  const model = args.model ?? getEnv('OPENROUTER_DEFAULT_MODEL');

  const messages: ChatMessage[] = [
    { role: 'system', content: buildEditSystemPrompt(registry, workflow, nodeId) },
    { role: 'user', content: instruction },
  ];

  let lastRaw = '';
  let lastIssues: ValidationIssue[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await chatCompletion({ model, messages, temperature: 0.2 });
    lastRaw = raw;

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch {
      lastIssues = [PARSE_ISSUE];
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    const opsParsed = PatchOpArraySchema.safeParse(parsed);
    if (!opsParsed.success) {
      lastIssues = zodErrorToIssues(opsParsed.error);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    let patched: Workflow;
    try {
      patched = applyPatch(workflow, opsParsed.data);
    } catch (err) {
      const message = err instanceof PatchError ? err.message : err instanceof Error ? err.message : String(err);
      lastIssues = [{ code: 'patch', message }];
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
      continue;
    }

    const result = validateWorkflow(patched, registry);
    if (result.ok) {
      return { workflow: result.workflow, ops: opsParsed.data, attempts: attempt };
    }

    lastIssues = result.issues;
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
  }

  throw new AgentValidationError(lastIssues, lastRaw);
}
