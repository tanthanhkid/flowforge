/**
 * SPEC-step5.md §7 — agent-edit.test.ts. `editNode`'s validate-and-retry
 * loop against a fully mocked OpenRouter `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentValidationError } from '../src/agent/generateWorkflow.js';
import { editNode, NodeNotFoundError } from '../src/agent/editNode.js';
import { createDefaultRegistry } from '../src/nodes/index.js';
import type { Workflow } from '../src/engine/schema.js';

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

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.OPENROUTER_DEFAULT_MODEL = 'test/dummy-model';
});

const workflow: Workflow = {
  version: 1,
  id: 'wf-edit',
  name: 'Editable',
  nodes: [
    { id: 'a', type: 'input.text', params: { value: 'hi' } },
    { id: 'b', type: 'llm.generate', params: { temperature: 0.7 } },
  ],
  edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }],
};

describe('editNode', () => {
  const registry = createDefaultRegistry();

  it('happy path: applies the ops the LLM returns and validates the resulting workflow', async () => {
    const ops = [{ op: 'update-node', nodeId: 'b', params: { temperature: 0.9 } }];
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(ops)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editNode({ workflow, nodeId: 'b', instruction: 'make it more creative', registry });
    expect(result.attempts).toBe(1);
    expect(result.ops).toEqual(ops);
    expect(result.workflow.nodes.find((n) => n.id === 'b')?.params).toEqual({ temperature: 0.9 });
  });

  it('an unknown nodeId throws NodeNotFoundError WITHOUT calling the LLM', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      editNode({ workflow, nodeId: 'does-not-exist', instruction: 'anything', registry }),
    ).rejects.toBeInstanceOf(NodeNotFoundError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries when the patch produces an invalid workflow, then succeeds', async () => {
    // First response references a nonexistent node -> applyPatch throws
    // PatchError -> reported back as a 'patch' issue.
    const badOps = [{ op: 'update-node', nodeId: 'does-not-exist-either', params: {} }];
    const goodOps = [{ op: 'update-node', nodeId: 'b', params: { temperature: 0.5 } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify(badOps)))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(goodOps)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editNode({ workflow, nodeId: 'b', instruction: 'tweak temperature', registry });
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCall = fetchMock.mock.calls[1]!;
    const secondBody = JSON.parse((secondCall[1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const feedback = secondBody.messages[secondBody.messages.length - 1]!;
    expect(feedback.content).toContain('patch');
  });

  it('retries when the patched workflow fails validateWorkflow (e.g. leaves a required input unconnected)', async () => {
    // remove-edge disconnects b's required "prompt" input -> missing-required-input.
    const badOps = [{ op: 'remove-edge', edgeId: 'e1' }];
    const goodOps = [{ op: 'update-node', nodeId: 'b', params: { temperature: 0.5 } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify(badOps)))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(goodOps)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editNode({ workflow, nodeId: 'b', instruction: 'tweak temperature', registry });
    expect(result.attempts).toBe(2);
  });

  it('throws AgentValidationError after 3 failed attempts', async () => {
    const badOps = [{ op: 'remove-edge', edgeId: 'e1' }];
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(badOps)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      editNode({ workflow, nodeId: 'b', instruction: 'tweak temperature', registry }),
    ).rejects.toBeInstanceOf(AgentValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
