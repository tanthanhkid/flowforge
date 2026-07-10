/**
 * SPEC-step5.md §7 — api-agent.test.ts. Routes registered via `buildServer`,
 * injected with a fully mocked OpenRouter `fetch`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { NodeRegistry } from '../src/engine/registry.js';
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

function makeRegistry(): NodeRegistry {
  return createDefaultRegistry();
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

const EDITABLE_WORKFLOW = {
  version: 1,
  id: 'wf-edit',
  name: 'Editable',
  nodes: [
    { id: 'a', type: 'input.text', params: { value: 'hi' } },
    { id: 'b', type: 'llm.generate', params: { temperature: 0.7 } },
  ],
  edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'prompt' } }],
};

describe('api-agent', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-artifacts-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry: makeRegistry() });
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_DEFAULT_MODEL = 'test/dummy-model';
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('POST /api/agent/generate-workflow: 200 with { workflow, attempts }', async () => {
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify(VALID_WORKFLOW))) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/generate-workflow',
      payload: { description: 'a simple workflow' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workflow: unknown; attempts: number };
    expect(body.attempts).toBe(1);
    expect(body.workflow).toMatchObject({ id: 'wf-gen' });
  });

  it('POST /api/agent/generate-workflow: missing description -> 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/generate-workflow', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('POST /api/agent/generate-workflow: LLM never converges -> 422 with issues', async () => {
    const invalid = {
      ...VALID_WORKFLOW,
      edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'promptx' } }],
    };
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify(invalid))) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/generate-workflow',
      payload: { description: 'a simple workflow' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; issues: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('POST /api/agent/generate-workflow: OpenRouter failure -> 502, message never contains the key', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(401, { error: 'unauthorized' }),
    ) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/generate-workflow',
      payload: { description: 'a simple workflow' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string };
    expect(body.error).not.toContain('test-openrouter-key');
  });

  it('POST /api/agent/edit-node: 200 with { workflow, ops, attempts }', async () => {
    const ops = [{ op: 'update-node', nodeId: 'b', params: { temperature: 0.9 } }];
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify(ops))) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/edit-node',
      payload: { workflow: EDITABLE_WORKFLOW, nodeId: 'b', instruction: 'be more creative' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workflow: { nodes: Array<{ id: string; params: Record<string, unknown> }> }; ops: unknown[]; attempts: number };
    expect(body.attempts).toBe(1);
    expect(body.ops).toEqual(ops);
    expect(body.workflow.nodes.find((n) => n.id === 'b')?.params).toEqual({ temperature: 0.9 });
  });

  it('POST /api/agent/edit-node: unknown nodeId -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/edit-node',
      payload: { workflow: EDITABLE_WORKFLOW, nodeId: 'does-not-exist', instruction: 'anything' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/agent/edit-node: missing instruction -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/edit-node',
      payload: { workflow: EDITABLE_WORKFLOW, nodeId: 'b' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/agent/edit-node: LLM never converges -> 422 with issues', async () => {
    const badOps = [{ op: 'remove-edge', edgeId: 'e1' }];
    globalThis.fetch = vi.fn(async () => chatResponse(JSON.stringify(badOps))) as unknown as typeof fetch;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/edit-node',
      payload: { workflow: EDITABLE_WORKFLOW, nodeId: 'b', instruction: 'disconnect prompt' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
