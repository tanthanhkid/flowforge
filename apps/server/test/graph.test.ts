import { describe, expect, it } from 'vitest';
import { detectCycle, topoSort } from '../src/engine/graph.js';
import { NodeRegistry } from '../src/engine/registry.js';
import { validateWorkflow, type Workflow } from '../src/engine/schema.js';
import { Engine } from '../src/engine/executor.js';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import { registerBaseMocks } from './helpers/mockNodes.js';

function diamondWorkflow(): Workflow {
  return {
    version: 1,
    id: 'diamond',
    name: '',
    nodes: [
      { id: 'A', type: 'mock.text', params: { value: 'a' } },
      { id: 'B', type: 'mock.upper', params: {} },
      { id: 'C', type: 'mock.upper', params: {} },
      { id: 'D', type: 'mock.concat', params: {} },
    ],
    edges: [
      { id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'B', port: 'text' } },
      { id: 'e2', from: { node: 'A', port: 'text' }, to: { node: 'C', port: 'text' } },
      { id: 'e3', from: { node: 'B', port: 'text' }, to: { node: 'D', port: 'a' } },
      { id: 'e4', from: { node: 'C', port: 'text' }, to: { node: 'D', port: 'b' } },
    ],
  };
}

function cyclicWorkflow(): Workflow {
  return {
    version: 1,
    id: 'cyclic',
    name: '',
    nodes: [
      { id: 'A', type: 'mock.upper', params: {} },
      { id: 'B', type: 'mock.upper', params: {} },
      { id: 'C', type: 'mock.upper', params: {} },
    ],
    edges: [
      { id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'B', port: 'text' } },
      { id: 'e2', from: { node: 'B', port: 'text' }, to: { node: 'C', port: 'text' } },
      { id: 'e3', from: { node: 'C', port: 'text' }, to: { node: 'A', port: 'text' } },
    ],
  };
}

describe('topoSort', () => {
  it('orders a diamond graph so A precedes B/C and B/C precede D', () => {
    const wf = diamondWorkflow();
    const order = topoSort(wf);
    expect(order).toHaveLength(4);
    const idx = (id: string) => order.indexOf(id);
    expect(idx('A')).toBeLessThan(idx('B'));
    expect(idx('A')).toBeLessThan(idx('C'));
    expect(idx('B')).toBeLessThan(idx('D'));
    expect(idx('C')).toBeLessThan(idx('D'));
  });

  it('throws on a cyclic workflow', () => {
    const wf = cyclicWorkflow();
    expect(() => topoSort(wf)).toThrow();
  });
});

describe('detectCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(detectCycle(diamondWorkflow())).toBeNull();
  });

  it('returns exactly the cyclic node ids for a 3-node cycle', () => {
    const cycle = detectCycle(cyclicWorkflow());
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['A', 'B', 'C']));
  });
});

describe('validateWorkflow + cycle', () => {
  it('produces a "cycle" issue for a cyclic workflow', () => {
    const registry = new NodeRegistry();
    registerBaseMocks(registry);
    const result = validateWorkflow(cyclicWorkflow(), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'cycle')).toBe(true);
    }
  });
});

describe('Engine.run + cycle', () => {
  it('throws when running a cyclic workflow', async () => {
    const registry = new NodeRegistry();
    registerBaseMocks(registry);
    const engine = new Engine(registry, { runs: new InMemoryRunStore(), cache: new InMemoryCacheStore() });
    await expect(engine.run(cyclicWorkflow())).rejects.toThrow();
  });
});
