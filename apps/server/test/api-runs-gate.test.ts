/**
 * SPEC-step33.md §33c/§33c.0 — HTTP layer for the approval gate and
 * run-abort: `POST /api/runs/:id/stop` and `POST /api/runs/:id/resume`.
 * Mirrors api-runs.test.ts's DI style (custom registry via `buildServer`'s
 * `registry` opt) plus `mock.plan`/`flow.approveGate`/`mock.echoJson` so no
 * network calls are involved.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { flowApproveGateNode } from '../src/nodes/flow.approveGate.js';
import { buildServer } from '../src/server.js';
import { registerBaseMocks } from './helpers/mockNodes.js';

function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  registry.register(flowApproveGateNode);
  return registry;
}

const GATE_WORKFLOW = {
  version: 1,
  id: 'wf-gate-http',
  name: '',
  nodes: [
    { id: 'plan', type: 'mock.plan', params: { value: { moments: [{ id: 'm1', start: 0, end: 1, title: 't' }] } } },
    { id: 'gate', type: 'flow.approveGate', params: {} },
    { id: 'down', type: 'mock.echoJson', params: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 'plan', port: 'plan' }, to: { node: 'gate', port: 'plan' } },
    { id: 'e2', from: { node: 'gate', port: 'plan' }, to: { node: 'down', port: 'plan' } },
  ],
};

interface RunJson {
  run: { status: string };
  nodes: Array<{ nodeId: string; state: string; outputs?: Record<string, unknown>; error?: string }>;
}

async function waitForRunStatus(app: FastifyInstance, runId: string, notStatus: string, timeoutMs = 5000): Promise<RunJson> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RunJson;
    if (body.run.status !== notStatus) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} stayed "${notStatus}" past ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForNodeState(app: FastifyInstance, runId: string, nodeId: string, state: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    const body = res.json() as { nodes: Array<{ nodeId: string; state: string }> };
    const rec = body.nodes.find((n) => n.nodeId === nodeId);
    if (rec?.state === state) return rec;
    if (Date.now() > deadline) throw new Error(`node ${nodeId} did not reach "${state}" within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('api-runs — gate + stop routes', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-runs-gate-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry: makeRegistry() });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('parks at the gate, then POST /resume with a valid CutPlan continues the run to success', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: GATE_WORKFLOW } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json() as { runId: string };

    await waitForNodeState(app, runId, 'gate', 'awaiting');

    const editedPlan = { moments: [{ id: 'm1', start: 0, end: 3, title: 'Đã sửa' }] };
    const resume = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { nodeId: 'gate', output: editedPlan },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toEqual({ resumed: true });

    const finished = await waitForRunStatus(app, runId, 'running');
    expect(finished.run.status).toBe('success');
    const down = finished.nodes.find((n) => n.nodeId === 'down');
    expect(down?.outputs?.plan).toEqual(editedPlan);
  });

  it('POST /resume with an invalid CutPlan shape returns 400 with issues', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: GATE_WORKFLOW } });
    const { runId } = start.json() as { runId: string };
    await waitForNodeState(app, runId, 'gate', 'awaiting');

    const resume = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { nodeId: 'gate', output: { moments: [{ id: 'm1', start: 5, end: 1, title: 'bad: end<=start' }] } },
    });
    expect(resume.statusCode).toBe(400);
    const body = resume.json() as { issues: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('POST /resume for a nodeId with no pending gate returns 409', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow: GATE_WORKFLOW } });
    const { runId } = start.json() as { runId: string };
    await waitForNodeState(app, runId, 'gate', 'awaiting');

    const resume = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { nodeId: 'not-the-gate', output: { moments: [] } },
    });
    expect(resume.statusCode).toBe(409);

    // Clean up: resolve the real gate so afterEach's app.close() doesn't
    // race a still-running engine run.
    await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { nodeId: 'gate', output: { moments: [] } },
    });
    await waitForRunStatus(app, runId, 'running');
  });

  it('POST /resume for an unknown run returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/does-not-exist/resume',
      payload: { nodeId: 'gate', output: { moments: [] } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /stop on an active run returns 200 {stopped:true} and the run ends error', async () => {
    const workflow = {
      version: 1,
      id: 'wf-stop-http',
      name: '',
      nodes: [{ id: 'H', type: 'mock.awaitAbort', params: {} }],
      edges: [],
    };
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow } });
    const { runId } = start.json() as { runId: string };
    await waitForNodeState(app, runId, 'H', 'running');

    const stop = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ stopped: true });

    const finished = await waitForRunStatus(app, runId, 'running');
    expect(finished.run.status).toBe('error');
  });

  it('POST /stop on an unknown run returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/stop' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /stop on an already-finished run returns 409', async () => {
    const workflow = {
      version: 1,
      id: 'wf-quick-http',
      name: '',
      nodes: [{ id: 'a', type: 'mock.text', params: { value: 'x' } }],
      edges: [],
    };
    const start = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflow } });
    const { runId } = start.json() as { runId: string };
    await waitForRunStatus(app, runId, 'running');

    const stop = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` });
    expect(stop.statusCode).toBe(409);
  });
});
