/**
 * api-estimate.test.ts (SPEC-step15.md §2/§5): POST /api/estimate — 200 with
 * the CostEstimate shape for a valid workflow body, 400 for a body that
 * fails WorkflowSchema.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

function validWorkflowBody() {
  return {
    version: 1,
    id: 'wf-estimate-test',
    name: 'estimate test',
    nodes: [
      { id: 'a', type: 'input.text', params: { value: 'hello' }, position: { x: 0, y: 0 } },
      { id: 'b', type: 'output.collect', params: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'in1' } }],
  };
}

describe('POST /api/estimate', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('200: returns a CostEstimate shape for a valid workflow body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/estimate', payload: validWorkflowBody() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalUsd: number;
      unknownCount: number;
      nodes: Array<{ nodeId: string; type: string; usd: number | null; basis: string }>;
      disclaimer: string;
    };
    expect(typeof body.totalUsd).toBe('number');
    expect(typeof body.unknownCount).toBe('number');
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes).toHaveLength(2);
    expect(typeof body.disclaimer).toBe('string');
    expect(body.totalUsd).toBe(0);
  });

  it('400: body failing WorkflowSchema (missing required fields)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/estimate', payload: { not: 'a workflow' } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBeTruthy();
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
