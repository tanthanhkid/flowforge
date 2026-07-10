/**
 * SPEC-step3.md §6 — api-workflows.test.ts.
 * CRUD roundtrip; POST id trùng -> 409; PUT upsert; DELETE -> GET 404;
 * POST body sai shape -> 400; /validate trả issues đúng (type-mismatch).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createCounterNode, registerBaseMocks } from './helpers/mockNodes.js';

function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  const { node: counterNode } = createCounterNode();
  registry.register(counterNode);
  return registry;
}

describe('api-workflows', () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-artifacts-'));
    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry: makeRegistry() });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const validWorkflow = {
    version: 1,
    id: 'wf-1',
    name: 'Test workflow',
    nodes: [{ id: 'n1', type: 'mock.text', params: { value: 'hello' } }],
    edges: [],
  };

  it('CRUD roundtrip', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/workflows', payload: validWorkflow });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ id: 'wf-1' });

    const list = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(list.statusCode).toBe(200);
    const summaries = list.json() as Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe('wf-1');
    expect(summaries[0]?.name).toBe('Test workflow');
    expect(typeof summaries[0]?.createdAt).toBe('number');
    expect(typeof summaries[0]?.updatedAt).toBe('number');

    const get = await app.inject({ method: 'GET', url: '/api/workflows/wf-1' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(validWorkflow);

    const updated = { ...validWorkflow, name: 'Renamed workflow' };
    const put = await app.inject({ method: 'PUT', url: '/api/workflows/wf-1', payload: updated });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ id: 'wf-1' });

    const getAfterPut = await app.inject({ method: 'GET', url: '/api/workflows/wf-1' });
    expect(getAfterPut.json()).toMatchObject({ name: 'Renamed workflow' });

    const del = await app.inject({ method: 'DELETE', url: '/api/workflows/wf-1' });
    expect(del.statusCode).toBe(204);

    const getAfterDelete = await app.inject({ method: 'GET', url: '/api/workflows/wf-1' });
    expect(getAfterDelete.statusCode).toBe(404);
  });

  it('POST with a duplicate id returns 409', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/workflows', payload: validWorkflow });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/api/workflows', payload: validWorkflow });
    expect(second.statusCode).toBe(409);
  });

  it('PUT upserts a workflow that did not exist yet', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/workflows/new-id', payload: { ...validWorkflow, id: 'ignored' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ id: 'new-id' });

    const get = await app.inject({ method: 'GET', url: '/api/workflows/new-id' });
    expect(get.statusCode).toBe(200);
    // The url's :id wins over whatever id the body carried.
    expect(get.json()).toMatchObject({ id: 'new-id' });
  });

  it('POST with a shape-invalid body returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { id: 'bad', nodes: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('POST /api/workflows/validate reports type-mismatch issues for a bad edge', async () => {
    const badWorkflow = {
      version: 1,
      id: 'wf-bad',
      name: '',
      nodes: [
        { id: 'a', type: 'mock.counter', params: {} },
        { id: 'b', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'a', port: 'count' }, to: { node: 'b', port: 'text' } }],
    };

    const res = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: badWorkflow });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; issues: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.issues.some((issue) => issue.code === 'type-mismatch')).toBe(true);
  });

  it('POST /api/workflows/validate reports ok:true for a valid workflow', async () => {
    const okWorkflow = {
      version: 1,
      id: 'wf-ok',
      name: '',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 'hi' } },
        { id: 'b', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'text' } }],
    };

    const res = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: okWorkflow });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, issues: [] });
  });
});
