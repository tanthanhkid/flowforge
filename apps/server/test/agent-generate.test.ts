/**
 * SPEC-step5.md §7 — agent-generate.test.ts. `generateWorkflow`'s
 * validate-and-retry loop against a fully mocked OpenRouter `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentValidationError, generateWorkflow, injectWorkflowDefaults } from '../src/agent/generateWorkflow.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

function chatResponse(content: string): Response {
  return jsonResponse(200, { choices: [{ message: { content } }] });
}

function requestBodyOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): { messages: Array<{ role: string; content: string }> } {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) throw new Error(`fetch was not called (call #${callIndex})`);
  return JSON.parse((call[1] as RequestInit).body as string);
}

const VALID_WORKFLOW = {
  version: 1,
  id: 'wf-gen',
  name: 'Generated',
  nodes: [
    { id: 'a', type: 'input.text', params: { value: 'hello' }, position: { x: 0, y: 0 } },
    { id: 'b', type: 'llm.generate', params: {}, position: { x: 280, y: 0 } },
  ],
  edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }],
};

// Edge references a port ("promptx") that doesn't exist on llm.generate.
const INVALID_WORKFLOW = {
  ...VALID_WORKFLOW,
  edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'promptx' } }],
};

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.OPENROUTER_DEFAULT_MODEL = 'test/dummy-model';
});

describe('generateWorkflow', () => {
  const registry = createDefaultRegistry();

  it('returns attempts=1 when the first response is already valid', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(VALID_WORKFLOW)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateWorkflow({ description: 'a simple workflow', registry });
    expect(result.attempts).toBe(1);
    expect(result.workflow.id).toBe('wf-gen');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first response is invalid, feeding the issue back, then succeeds -> attempts=2', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify(INVALID_WORKFLOW)))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(VALID_WORKFLOW)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateWorkflow({ description: 'a simple workflow', registry });
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondRequestBody = requestBodyOf(fetchMock, 1);
    const feedbackMessage = secondRequestBody.messages[secondRequestBody.messages.length - 1]!;
    expect(feedbackMessage.role).toBe('user');
    expect(feedbackMessage.content).toContain('unknown-edge-endpoint');
  });

  it('throws AgentValidationError with the last issues after 3 failed attempts', async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(INVALID_WORKFLOW)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(generateWorkflow({ description: 'a simple workflow', registry })).rejects.toBeInstanceOf(
      AgentValidationError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    try {
      await generateWorkflow({ description: 'a simple workflow', registry });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentValidationError);
      const issues = (err as AgentValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.code === 'unknown-edge-endpoint')).toBe(true);
    }
  });

  it('parse failures (non-JSON response) are reported back to the LLM as a "parse" issue', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse('Sorry, I cannot help with that.'))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(VALID_WORKFLOW)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateWorkflow({ description: 'a simple workflow', registry });
    expect(result.attempts).toBe(2);

    const secondRequestBody = requestBodyOf(fetchMock, 1);
    const feedbackMessage = secondRequestBody.messages[secondRequestBody.messages.length - 1]!;
    expect(feedbackMessage.content).toContain('parse');
  });

  it('autoLayout fills in position for nodes the LLM left without one', async () => {
    const withoutPositions = {
      ...VALID_WORKFLOW,
      nodes: VALID_WORKFLOW.nodes.map(({ position: _pos, ...rest }) => rest),
    };
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(withoutPositions)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateWorkflow({ description: 'a simple workflow', registry });
    for (const node of result.workflow.nodes) {
      expect(node.position).toBeDefined();
    }
    // node "a" (no incoming edges, depth 0) and node "b" (depth 1) per
    // SPEC-step5.md §2's autoLayout formula (x = depth * 280).
    expect(result.workflow.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 0, y: 0 });
    expect(result.workflow.nodes.find((n) => n.id === 'b')?.position).toEqual({ x: 280, y: 0 });
  });

  it('injects id/version/name when the LLM response is missing them', async () => {
    const { id: _id, version: _version, name: _name, ...withoutMeta } = VALID_WORKFLOW;
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(withoutMeta)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateWorkflow({ description: 'a lovely little test workflow please', registry });
    expect(typeof result.workflow.id).toBe('string');
    expect(result.workflow.id.length).toBeGreaterThan(0);
    expect(result.workflow.version).toBe(1);
    expect(result.workflow.name).toBe('a lovely little test workflow please');
  });

  it('never overwrites an id/name the LLM did provide', () => {
    const withIdAndName = injectWorkflowDefaults({ id: 'kept-id', name: 'Kept name' }, 'some description');
    expect(withIdAndName).toMatchObject({ id: 'kept-id', name: 'Kept name', version: 1 });
  });
});
