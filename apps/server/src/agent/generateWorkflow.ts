/**
 * `generateWorkflow` (SPEC-step5.md §4): description -> workflow JSON, via
 * OpenRouter with a validate-and-retry loop (up to 3 attempts total).
 */
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config.js';
import type { NodeRegistry } from '../engine/registry.js';
import { validateWorkflow, type ValidationIssue, type Workflow } from '../engine/schema.js';
import { chatCompletion, type ChatMessage } from '../nodes/providers/openrouter.js';
import { autoLayout } from './layout.js';
import { extractJson } from './json.js';
import { buildGenerateSystemPrompt } from './promptBuilder.js';

const MAX_ATTEMPTS = 3;

/**
 * Thrown by `generateWorkflow`/`editNode` when the LLM still hasn't produced
 * a valid workflow/patch after `MAX_ATTEMPTS` tries. Carries the last
 * validation issues (for the caller/route to relay to the user) and the raw
 * last LLM response (for debugging) — routes/agent.ts maps this to a 422.
 */
export class AgentValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly rawLastResponse: string;

  constructor(issues: ValidationIssue[], rawLastResponse: string) {
    super(`Agent không tạo được workflow hợp lệ sau ${MAX_ATTEMPTS} lần thử: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'AgentValidationError';
    this.issues = issues;
    this.rawLastResponse = rawLastResponse;
  }
}

/** Formats validation issues as the feedback message sent back to the LLM
 * for the next retry attempt (shared by generateWorkflow.ts / editNode.ts). */
export function issuesToFeedback(issues: ValidationIssue[]): string {
  const lines = issues.map((issue) => {
    const refs = [
      issue.nodeId ? `nodeId: ${issue.nodeId}` : undefined,
      issue.edgeId ? `edgeId: ${issue.edgeId}` : undefined,
    ]
      .filter((s): s is string => s !== undefined)
      .join(', ');
    return `- ${issue.code}: ${issue.message}${refs ? ` (${refs})` : ''}`;
  });
  return `Workflow/patch chưa hợp lệ, sửa và trả về JSON đầy đủ. Lỗi:\n${lines.join('\n')}`;
}

const PARSE_ISSUE: ValidationIssue = {
  code: 'parse',
  message: 'Không parse được JSON từ phản hồi của model.',
};

/** Fills in `id` (randomUUID), `version` (1), `name` (first 6-8 words of the
 * description) on the parsed JSON when the LLM left them out. Only touches
 * a field that is genuinely missing/blank — never overrides a value the LLM
 * did provide (even if that value later turns out to be invalid; that's
 * validateWorkflow()'s job to report so the LLM can fix it itself). */
export function injectWorkflowDefaults(json: unknown, description: string): unknown {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return json;

  const obj = { ...(json as Record<string, unknown>) };

  const idMissing = typeof obj.id !== 'string' || obj.id.trim() === '';
  if (idMissing) obj.id = randomUUID();

  if (obj.version === undefined || obj.version === null) obj.version = 1;

  const nameMissing = typeof obj.name !== 'string' || obj.name.trim() === '';
  if (nameMissing) {
    const words = description.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    obj.name = words.length > 0 ? words.join(' ') : 'Untitled workflow';
  }

  return obj;
}

export interface GenerateWorkflowArgs {
  description: string;
  model?: string;
  registry: NodeRegistry;
}

export interface GenerateWorkflowResult {
  workflow: Workflow;
  attempts: number;
}

export async function generateWorkflow(args: GenerateWorkflowArgs): Promise<GenerateWorkflowResult> {
  const { description, registry } = args;
  const model = args.model ?? getEnv('OPENROUTER_DEFAULT_MODEL');

  const messages: ChatMessage[] = [
    { role: 'system', content: buildGenerateSystemPrompt(registry) },
    { role: 'user', content: description },
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

    const withDefaults = injectWorkflowDefaults(parsed, description);
    const laidOut = autoLayout(withDefaults);
    const result = validateWorkflow(laidOut, registry);

    if (result.ok) {
      return { workflow: result.workflow, attempts: attempt };
    }

    lastIssues = result.issues;
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: issuesToFeedback(lastIssues) });
  }

  throw new AgentValidationError(lastIssues, lastRaw);
}
