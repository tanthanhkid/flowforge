import { describe, expect, it } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import { createCounterNode, registerBaseMocks } from './helpers/mockNodes.js';

function newEngine() {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  const runStore = new InMemoryRunStore();
  const cacheStore = new InMemoryCacheStore();
  const engine = new Engine(registry, { runs: runStore, cache: cacheStore });
  return { registry, runStore, cacheStore, engine };
}

function chainWorkflow(textValue: string, counterValue: string): Workflow {
  return {
    version: 1,
    id: 'cache-wf',
    name: '',
    nodes: [
      { id: 'A', type: 'mock.text', params: { value: textValue } },
      { id: 'counter', type: 'mock.counter', params: { value: counterValue } },
    ],
    edges: [{ id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'counter', port: 'in' } }],
  };
}

describe('Engine cache behavior', () => {
  it('hits the cache on a second identical run (no re-execute)', async () => {
    const { registry, engine } = newEngine();
    const { node, counter } = createCounterNode();
    registry.register(node);

    const wf = chainWorkflow('v1', 'p1');
    const r1 = await engine.run(wf);
    expect(r1.nodes.counter?.cached).toBe(false);
    expect(counter.count).toBe(1);

    const r2 = await engine.run(wf);
    expect(r2.nodes.counter?.cached).toBe(true);
    expect(counter.count).toBe(1);
    expect(r2.nodes.counter?.outputs).toEqual(r1.nodes.counter?.outputs);
  });

  it('misses the cache when the node\'s own params change', async () => {
    const { registry, engine } = newEngine();
    const { node, counter } = createCounterNode();
    registry.register(node);

    await engine.run(chainWorkflow('v1', 'p1'));
    expect(counter.count).toBe(1);

    const r2 = await engine.run(chainWorkflow('v1', 'p2'));
    expect(counter.count).toBe(2);
    expect(r2.nodes.counter?.cached).toBe(false);
  });

  it('misses the cache when an upstream node\'s output changes', async () => {
    const { registry, engine } = newEngine();
    const { node, counter } = createCounterNode();
    registry.register(node);

    await engine.run(chainWorkflow('v1', 'p1'));
    expect(counter.count).toBe(1);

    // Same counter params, but upstream `A` now emits a different value ->
    // counter's resolved inputs differ -> cache miss even though its own
    // params didn't change.
    const r2 = await engine.run(chainWorkflow('v2', 'p1'));
    expect(counter.count).toBe(2);
    expect(r2.nodes.counter?.cached).toBe(false);
  });

  it('forceNodes re-executes only the forced node; others still cache-hit', async () => {
    const { registry, engine } = newEngine();
    const { node: nodeA, counter: counterA } = createCounterNode({ type: 'mock.counterA' });
    const { node: nodeB, counter: counterB } = createCounterNode({ type: 'mock.counterB' });
    registry.register(nodeA);
    registry.register(nodeB);

    const wf: Workflow = {
      version: 1,
      id: 'force-wf',
      name: '',
      nodes: [
        { id: 'ca', type: 'mock.counterA', params: { value: 'x' } },
        { id: 'cb', type: 'mock.counterB', params: { value: 'y' } },
      ],
      edges: [],
    };

    await engine.run(wf);
    expect(counterA.count).toBe(1);
    expect(counterB.count).toBe(1);

    const r2 = await engine.run(wf, { forceNodes: ['ca'] });
    expect(counterA.count).toBe(2);
    expect(counterB.count).toBe(1);
    expect(r2.nodes.ca?.cached).toBe(false);
    expect(r2.nodes.cb?.cached).toBe(true);

    // Forcing writes a fresh cache entry too: a plain third run should hit cache for both.
    const r3 = await engine.run(wf);
    expect(counterA.count).toBe(2);
    expect(counterB.count).toBe(1);
    expect(r3.nodes.ca?.cached).toBe(true);
    expect(r3.nodes.cb?.cached).toBe(true);
  });

  it('cacheable: false always re-executes', async () => {
    const { registry, engine } = newEngine();
    const { node, counter } = createCounterNode({ cacheable: false });
    registry.register(node);

    const wf: Workflow = {
      version: 1,
      id: 'nocache-wf',
      name: '',
      nodes: [{ id: 'c', type: 'mock.counter', params: { value: 'x' } }],
      edges: [],
    };

    const r1 = await engine.run(wf);
    expect(counter.count).toBe(1);
    expect(r1.nodes.c?.cached).toBe(false);

    const r2 = await engine.run(wf);
    expect(counter.count).toBe(2);
    expect(r2.nodes.c?.cached).toBe(false);
  });
});
