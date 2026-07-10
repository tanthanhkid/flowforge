/**
 * SPEC-step3.md §6 — api-runs.test.ts.
 * POST /api/runs with a chain + fail-branch workflow -> 202 runId; poll
 * GET /api/runs/:id until done -> success/error/skipped states; invalid
 * workflow -> 400 + issues; unknown workflowId -> 404; forceNodes propagates
 * (second run forcing one node -> that node's cacheHit is false); GET
 * /api/runs history is ordered newest-first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { buildServer } from '../src/server.js';
import { createCounterNode, registerBaseMocks } from './helpers/mockNodes.js';

interface NodeRunJson {
  nodeId: string;
  state: string;
  cacheHit: boolean;
}

interface RunJson {
  run: { id: string; workflowId: string; status: string; createdAt: number; finishedAt?: number };
  nodes: NodeRunJson[];
}

async function waitForRunDone(app: FastifyInstance, runId: string, timeoutMs = 5000): Promise<RunJson> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RunJson;
    if (body.run.status !== 'running') return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeRegistry(): { registry: NodeRegistry; counter: { count: number } } {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  const { node: counterNode, counter } = createCounterNode();
  registry.register(counterNode);
  return { registry, counter };
}

describe('api-runs', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-runs-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs a chain + fail-branch workflow inline, ending with success/error/skipped states', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const workflow = {
      version: 1,
      id: 'wf-chain',
      name: '',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 'hi' } },
        { id: 'ok', type: 'mock.upper', params: {} },
        { id: 'fail', type: 'mock.fail', params: {} },
        { id: 'downstream', type: 'mock.upper', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'ok', port: 'text' } },
        { id: 'e2', from: { node: 'a', port: 'text' }, to: { node: 'fail', port: 'text' } },
        { id: 'e3', from: { node: 'fail', port: 'text' }, to: { node: 'downstream', port: 'text' } },
      ],
    };

    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json() as { runId: string };
    expect(typeof runId).toBe('string');

    const finished = await waitForRunDone(app, runId);
    expect(finished.run.status).toBe('error');

    const byId = new Map(finished.nodes.map((n) => [n.nodeId, n.state]));
    expect(byId.get('a')).toBe('success');
    expect(byId.get('ok')).toBe('success');
    expect(byId.get('fail')).toBe('error');
    expect(byId.get('downstream')).toBe('skipped');
  });

  it('rejects an invalid workflow with 400 + issues', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const badWorkflow = {
      version: 1,
      id: 'wf-bad',
      name: '',
      nodes: [{ id: 'a', type: 'unknown.type', params: {} }],
      edges: [],
    };

    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: badWorkflow } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: Array<{ code: string }> };
    expect(body.issues.some((i) => i.code === 'unknown-node-type')).toBe(true);
  });

  it('returns 404 for an unknown workflowId', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: 'does-not-exist' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a body with neither or both of workflowId/workflow', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const neither = await app.inject({ method: 'POST', url: '/api/runs', payload: {} });
    expect(neither.statusCode).toBe(400);

    const both = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflowId: 'x', workflow: { version: 1, id: 'x', name: '', nodes: [], edges: [] } },
    });
    expect(both.statusCode).toBe(400);
  });

  it('propagates forceNodes (a forced node reports cacheHit:false even on a repeat run)', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const workflow = {
      version: 1,
      id: 'wf-cache',
      name: '',
      nodes: [{ id: 'c', type: 'mock.counter', params: { value: 'x' } }],
      edges: [],
    };
    const create = await app.inject({ method: 'POST', url: '/api/workflows', payload: workflow });
    expect(create.statusCode).toBe(201);

    // Run 1: first execution, never cached.
    const run1 = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: 'wf-cache' } });
    const { runId: runId1 } = run1.json() as { runId: string };
    const finished1 = await waitForRunDone(app, runId1);
    expect(finished1.nodes.find((n) => n.nodeId === 'c')?.cacheHit).toBe(false);

    // Run 2: identical params/inputs -> cache hit.
    const run2 = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: 'wf-cache' } });
    const { runId: runId2 } = run2.json() as { runId: string };
    const finished2 = await waitForRunDone(app, runId2);
    expect(finished2.nodes.find((n) => n.nodeId === 'c')?.cacheHit).toBe(true);

    // Run 3: forced -> cache bypassed for that node.
    const run3 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflowId: 'wf-cache', forceNodes: ['c'] },
    });
    const { runId: runId3 } = run3.json() as { runId: string };
    const finished3 = await waitForRunDone(app, runId3);
    expect(finished3.nodes.find((n) => n.nodeId === 'c')?.cacheHit).toBe(false);
  });

  it('GET /api/runs returns history newest-first', async () => {
    const { registry } = makeRegistry();
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });

    const workflow = {
      version: 1,
      id: 'wf-history',
      name: '',
      nodes: [{ id: 'a', type: 'mock.text', params: { value: 'x' } }],
      edges: [],
    };
    await app.inject({ method: 'POST', url: '/api/workflows', payload: workflow });

    const runIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: 'wf-history' } });
      const { runId } = res.json() as { runId: string };
      await waitForRunDone(app, runId);
      runIds.push(runId);
    }

    const list = await app.inject({ method: 'GET', url: '/api/runs?workflowId=wf-history' });
    expect(list.statusCode).toBe(200);
    const history = list.json() as Array<{ id: string }>;
    expect(history.map((r) => r.id)).toEqual([...runIds].reverse());
  });
});
