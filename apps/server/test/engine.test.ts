import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import { createDelayNode, registerBaseMocks } from './helpers/mockNodes.js';

function newEngine(opts?: { concurrency?: number }) {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  const runStore = new InMemoryRunStore();
  const cacheStore = new InMemoryCacheStore();
  const engine = new Engine(registry, { runs: runStore, cache: cacheStore }, opts);
  return { registry, runStore, cacheStore, engine };
}

describe('Engine.run — chain execution', () => {
  it('runs A->B->C in dependency order with outputs passed through', async () => {
    const { engine } = newEngine();
    const events: { nodeId: string; state: string }[] = [];
    engine.on('node:state', (e: { nodeId: string; state: string }) => events.push({ nodeId: e.nodeId, state: e.state }));

    const wf: Workflow = {
      version: 1,
      id: 'chain',
      name: '',
      nodes: [
        { id: 'A', type: 'mock.text', params: { value: 'hi' } },
        { id: 'B', type: 'mock.upper', params: {} },
        { id: 'C', type: 'mock.concat', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'B', port: 'text' } },
        { id: 'e2', from: { node: 'B', port: 'text' }, to: { node: 'C', port: 'a' } },
      ],
    };

    const result = await engine.run(wf);
    expect(result.status).toBe('success');
    expect(result.nodes.A?.outputs?.text).toBe('hi');
    expect(result.nodes.B?.outputs?.text).toBe('HI');
    expect(result.nodes.C?.outputs?.text).toBe('HI');

    for (const id of ['A', 'B', 'C']) {
      const seq = events.filter((e) => e.nodeId === id).map((e) => e.state);
      expect(seq).toEqual(['pending', 'running', 'success']);
    }

    const runningIdx = (id: string) => events.findIndex((e) => e.nodeId === id && e.state === 'running');
    const successIdx = (id: string) => events.findIndex((e) => e.nodeId === id && e.state === 'success');
    expect(successIdx('A')).toBeLessThan(runningIdx('B'));
    expect(successIdx('B')).toBeLessThan(runningIdx('C'));
  });

  it('emits a run:state success event and persists node states in RunStore', async () => {
    const { engine, runStore } = newEngine();
    const runEvents: { runId: string; status: string }[] = [];
    engine.on('run:state', (e: { runId: string; status: string }) => runEvents.push(e));

    const wf: Workflow = {
      version: 1,
      id: 'single',
      name: '',
      nodes: [{ id: 'A', type: 'mock.text', params: { value: 'hi' } }],
      edges: [],
    };
    const result = await engine.run(wf);
    expect(runEvents).toEqual([{ runId: result.runId, status: 'success' }]);

    const stored = runStore.getRun(result.runId);
    expect(stored?.run.status).toBe('success');
    expect(stored?.nodes.find((n) => n.nodeId === 'A')?.state).toBe('success');
  });
});

describe('Engine.run — parallel execution', () => {
  it('overlaps two independent delay branches in time', async () => {
    const { registry, engine } = newEngine();
    const { node: delayNode, log } = createDelayNode();
    registry.register(delayNode);

    const wf: Workflow = {
      version: 1,
      id: 'parallel',
      name: '',
      nodes: [
        { id: 'A', type: 'mock.delay', params: { ms: 50 } },
        { id: 'B', type: 'mock.delay', params: { ms: 50 } },
      ],
      edges: [],
    };

    const result = await engine.run(wf);
    expect(result.status).toBe('success');
    const a = log.find((e) => e.nodeId === 'A');
    const b = log.find((e) => e.nodeId === 'B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b!.start).toBeLessThan(a!.end);
    expect(a!.start).toBeLessThan(b!.end);
  });

  it('caps concurrent execution at the configured concurrency', async () => {
    const { registry, engine } = newEngine({ concurrency: 2 });
    const { node: delayNode, tracker } = createDelayNode();
    registry.register(delayNode);

    const wf: Workflow = {
      version: 1,
      id: 'concurrency',
      name: '',
      nodes: [
        { id: 'A', type: 'mock.delay', params: { ms: 30 } },
        { id: 'B', type: 'mock.delay', params: { ms: 30 } },
        { id: 'C', type: 'mock.delay', params: { ms: 30 } },
        { id: 'D', type: 'mock.delay', params: { ms: 30 } },
      ],
      edges: [],
    };

    const result = await engine.run(wf);
    expect(result.status).toBe('success');
    expect(tracker.max).toBeLessThanOrEqual(2);
    expect(tracker.max).toBe(2);
  });
});

describe('Engine.run — error branch handling', () => {
  it('marks the failing node error, cascades skip to its descendants, and lets independent branches finish', async () => {
    const { engine, runStore } = newEngine();

    const wf: Workflow = {
      version: 1,
      id: 'errbranch',
      name: '',
      nodes: [
        { id: 'A', type: 'mock.text', params: { value: 'x' } },
        { id: 'fail', type: 'mock.fail', params: {} },
        { id: 'C', type: 'mock.upper', params: {} },
        { id: 'D', type: 'mock.text', params: { value: 'd' } },
        { id: 'E', type: 'mock.upper', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'fail', port: 'text' } },
        { id: 'e2', from: { node: 'fail', port: 'text' }, to: { node: 'C', port: 'text' } },
        { id: 'e3', from: { node: 'D', port: 'text' }, to: { node: 'E', port: 'text' } },
      ],
    };

    const result = await engine.run(wf);
    expect(result.status).toBe('error');
    expect(result.nodes.fail?.state).toBe('error');
    expect(result.nodes.fail?.error).toContain('boom');
    expect(result.nodes.C?.state).toBe('skipped');
    expect(result.nodes.D?.state).toBe('success');
    expect(result.nodes.E?.state).toBe('success');
    expect(result.nodes.A?.state).toBe('success');

    const stored = runStore.getRun(result.runId);
    expect(stored?.run.status).toBe('error');
    const byId = new Map(stored?.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get('fail')?.state).toBe('error');
    expect(byId.get('fail')?.error).toContain('boom');
    expect(byId.get('C')?.state).toBe('skipped');
    expect(byId.get('D')?.state).toBe('success');
    expect(byId.get('E')?.state).toBe('success');
  });

  it('emits node:state error and skipped events for the failing branch', async () => {
    const { engine } = newEngine();
    const events: { nodeId: string; state: string; error?: string }[] = [];
    engine.on('node:state', (e: { nodeId: string; state: string; error?: string }) => events.push(e));

    const wf: Workflow = {
      version: 1,
      id: 'errevents',
      name: '',
      nodes: [
        { id: 'fail', type: 'mock.fail', params: {} },
        { id: 'C', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'fail', port: 'text' }, to: { node: 'C', port: 'text' } }],
    };
    await engine.run(wf);

    const failSeq = events.filter((e) => e.nodeId === 'fail').map((e) => e.state);
    expect(failSeq).toEqual(['pending', 'running', 'error']);
    const failError = events.find((e) => e.nodeId === 'fail' && e.state === 'error');
    expect(failError?.error).toContain('boom');

    const cSeq = events.filter((e) => e.nodeId === 'C').map((e) => e.state);
    expect(cSeq).toEqual(['pending', 'skipped']);
  });
});

describe('Engine.run — mock.poller (ctx.poll wiring through the real ExecutionContext)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a node using ctx.poll() with the value from the Nth check', async () => {
    const { engine } = newEngine();
    const wf: Workflow = {
      version: 1,
      id: 'poller-wf',
      name: '',
      nodes: [{ id: 'P', type: 'mock.poller', params: { times: 3, value: 'ready' } }],
      edges: [],
    };

    const runPromise = engine.run(wf);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await runPromise;

    expect(result.status).toBe('success');
    expect(result.nodes.P?.state).toBe('success');
    expect(result.nodes.P?.outputs?.text).toBe('ready');
  });

  it('aborting RunOptions.signal errors a node that is mid-poll', async () => {
    const { engine } = newEngine();
    const controller = new AbortController();
    const wf: Workflow = {
      version: 1,
      id: 'poller-abort-wf',
      name: '',
      nodes: [{ id: 'P', type: 'mock.poller', params: { times: 5, value: 'ready' } }],
      edges: [],
    };

    const runPromise = engine.run(wf, { signal: controller.signal });
    // Let the first check() run and ctx.poll() settle into its backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await runPromise;

    expect(result.status).toBe('error');
    expect(result.nodes.P?.state).toBe('error');
    expect(result.nodes.P?.error).toContain('aborted');
  });
});
