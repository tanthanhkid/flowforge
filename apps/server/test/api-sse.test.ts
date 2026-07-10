/**
 * SPEC-step3.md §6 — api-sse.test.ts.
 * Start a run with a delay node, open SSE -> snapshot first, then >=1
 * node:state, finally done. Opening SSE on an already-finished run -> just
 * snapshot + done. Unknown run -> 404. Uses a *real* listening server + real
 * fetch to 127.0.0.1 (test/setup.ts's loopback exception allows this).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { buildServer } from '../src/server.js';
import { createDelayNode, mockHangNode, registerBaseMocks } from './helpers/mockNodes.js';

interface SseEvent {
  event: string;
  data: unknown;
}

interface CollectResult {
  events: SseEvent[];
  headers: Headers;
}

async function collectSseEvents(url: string, opts: { timeoutMs?: number } = {}): Promise<SseEvent[]> {
  return (await collectSseEventsWithHeaders(url, opts)).events;
}

async function collectSseEventsWithHeaders(
  url: string,
  opts: { timeoutMs?: number; origin?: string } = {},
): Promise<CollectResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: opts.origin ? { Origin: opts.origin } : undefined,
  });
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`SSE request failed: ${res.status}`);
  }
  const headers = res.headers;

  const events: SseEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!chunk.trim() || chunk.startsWith(':')) continue; // heartbeat comment

        const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;

        const event = eventLine.slice('event: '.length);
        const data: unknown = JSON.parse(dataLine.slice('data: '.length));
        events.push({ event, data });

        if (event === 'done') return { events, headers };
      }
    }
    return { events, headers };
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

describe('api-sse', () => {
  let app: FastifyInstance;
  let tmp: string;
  let baseUrl: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-sse-'));
    const registry = new NodeRegistry();
    registerBaseMocks(registry);
    const { node: delayNode } = createDelayNode();
    registry.register(delayNode);

    app = await buildServer({ dbPath: ':memory:', artifactsDir: tmp, registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('streams snapshot, then node:state events, then done, for an in-progress run', async () => {
    const workflow = {
      version: 1,
      id: 'wf-sse',
      name: '',
      nodes: [{ id: 'd', type: 'mock.delay', params: { ms: 150 } }],
      edges: [],
    };

    const start = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };

    const events = await collectSseEvents(`${baseUrl}/api/runs/${runId}/events`);

    expect(events[0]?.event).toBe('snapshot');
    expect(events.some((e) => e.event === 'node:state')).toBe(true);
    expect(events.some((e) => e.event === 'run:state')).toBe(true);
    expect(events[events.length - 1]?.event).toBe('done');

    const runStateEvent = events.find((e) => e.event === 'run:state');
    expect((runStateEvent?.data as { status: string }).status).toBe('success');
  });

  it('sends snapshot + done immediately for an already-finished run', async () => {
    const workflow = {
      version: 1,
      id: 'wf-sse-fast',
      name: '',
      nodes: [{ id: 't', type: 'mock.text', params: { value: 'hi' } }],
      edges: [],
    };

    const start = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    const { runId } = (await start.json()) as { runId: string };

    // Wait for the run to actually finish before opening the SSE connection.
    const deadline = Date.now() + 5000;
    for (;;) {
      const res = await fetch(`${baseUrl}/api/runs/${runId}`);
      const body = (await res.json()) as { run: { status: string } };
      if (body.run.status !== 'running') break;
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const events = await collectSseEvents(`${baseUrl}/api/runs/${runId}/events`);
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'done']);
    expect((events[0]?.data as { run: { status: string } }).run.status).toBe('success');
  });

  it('returns 404 for an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/runs/does-not-exist/events`);
    expect(res.status).toBe(404);
  });

  it('reflects the request Origin in Access-Control-Allow-Origin (CORS survives reply.hijack())', async () => {
    const workflow = {
      version: 1,
      id: 'wf-sse-cors',
      name: '',
      nodes: [{ id: 't', type: 'mock.text', params: { value: 'hi' } }],
      edges: [],
    };

    const start = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const origin = 'http://localhost:5173';
    const { headers } = await collectSseEventsWithHeaders(`${baseUrl}/api/runs/${runId}/events`, { origin });
    expect(headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('treats a run persisted as "running" but orphaned (not active in this process) as finished', async () => {
    // Simulates a server restart mid-run (e.g. `tsx watch` reloading on save,
    // per SPEC-step3.md's dev script): use a real file-backed db so a *second*
    // buildServer() can reattach to the same `runs` row a *first* instance
    // left at status='running' after being closed mid-execution (its
    // mock.hang node never resolves, so it never reaches a terminal state).
    // The second instance's RunManager never started that run, so
    // isActive() is false even though the persisted status still says
    // 'running' — the SSE handler must not subscribe-and-wait forever.
    const dbFile = path.join(tmp, 'orphan.db');
    const workflow = {
      version: 1,
      id: 'wf-orphan',
      name: '',
      nodes: [{ id: 'h', type: 'mock.hang', params: {} }],
      edges: [],
    };

    const registryA = new NodeRegistry();
    registerBaseMocks(registryA);
    registryA.register(mockHangNode);
    const appA = await buildServer({ dbPath: dbFile, artifactsDir: tmp, registry: registryA });
    await appA.listen({ port: 0, host: '127.0.0.1' });
    const addressA = appA.server.address() as AddressInfo;
    const baseUrlA = `http://127.0.0.1:${addressA.port}`;

    const start = await fetch(`${baseUrlA}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const statusRes = await fetch(`${baseUrlA}/api/runs/${runId}`);
    const statusBody = (await statusRes.json()) as { run: { status: string } };
    expect(statusBody.run.status).toBe('running');

    await appA.close(); // process "shutdown" mid-run; the hanging node's promise is simply abandoned.

    const registryB = new NodeRegistry();
    registerBaseMocks(registryB);
    registryB.register(mockHangNode);
    const appB = await buildServer({ dbPath: dbFile, artifactsDir: tmp, registry: registryB });
    await appB.listen({ port: 0, host: '127.0.0.1' });
    const addressB = appB.server.address() as AddressInfo;
    const baseUrlB = `http://127.0.0.1:${addressB.port}`;

    try {
      const events = await collectSseEvents(`${baseUrlB}/api/runs/${runId}/events`, { timeoutMs: 2000 });
      expect(events.map((e) => e.event)).toEqual(['snapshot', 'done']);
      expect((events[0]?.data as { run: { status: string } }).run.status).toBe('running');
    } finally {
      await appB.close();
    }
  });
});
