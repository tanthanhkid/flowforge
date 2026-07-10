import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../src/engine/registry.js';
import { validateWorkflow, type Workflow } from '../src/engine/schema.js';
import { createCounterNode, registerBaseMocks } from './helpers/mockNodes.js';

function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  return registry;
}

describe('validateWorkflow', () => {
  it('accepts a valid workflow', () => {
    const registry = makeRegistry();
    const wf = {
      version: 1,
      id: 'wf1',
      name: 'test',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 'hi' } },
        { id: 'b', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'text' } }],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.id).toBe('wf1');
    }
  });

  it('reports code "schema" for missing version / malformed shape', () => {
    const registry = makeRegistry();
    const result = validateWorkflow({ id: 'wf1', nodes: [], edges: [] }, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.code === 'schema')).toBe(true);
    }
  });

  it('reports "schema" for completely wrong shape (not an object)', () => {
    const registry = makeRegistry();
    const result = validateWorkflow('not a workflow', registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'schema')).toBe(true);
    }
  });

  it('reports unknown-edge-endpoint for edges pointing at missing nodes/ports', () => {
    const registry = makeRegistry();
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [{ id: 'a', type: 'mock.text', params: { value: 'hi' } }],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'missing', port: 'text' } },
        { id: 'e2', from: { node: 'missing2', port: 'text' }, to: { node: 'a', port: 'text' } },
        { id: 'e3', from: { node: 'a', port: 'nope' }, to: { node: 'a', port: 'text' } },
      ],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes.filter((c) => c === 'unknown-edge-endpoint').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('reports type-mismatch when connecting incompatible port types', () => {
    const registry = makeRegistry();
    const { node: counterNode } = createCounterNode();
    registry.register(counterNode);
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [
        { id: 'c', type: 'mock.counter', params: {} },
        { id: 'u', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'c', port: 'count' }, to: { node: 'u', port: 'text' } }],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'type-mismatch')).toBe(true);
    }
  });

  it('allows an "any" port to connect with any other type', () => {
    const registry = makeRegistry();
    const { node: counterNode } = createCounterNode();
    registry.register(counterNode);
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [
        { id: 'c', type: 'mock.counter', params: {} },
        { id: 'a', type: 'mock.anyIn', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'c', port: 'count' }, to: { node: 'a', port: 'value' } }],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(true);
  });

  it('reports duplicate-node-id, invalid-params, and missing-required-input', () => {
    const registry = makeRegistry();
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 42 } }, // invalid-params (value should be string)
        { id: 'a', type: 'mock.text', params: { value: 'hi' } }, // duplicate-node-id
        { id: 'u', type: 'mock.upper', params: {} }, // missing-required-input (text not connected)
      ],
      edges: [],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('duplicate-node-id');
      expect(codes).toContain('invalid-params');
      expect(codes).toContain('missing-required-input');
    }
  });

  it('returns all issues at once rather than short-circuiting', () => {
    const registry = makeRegistry();
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 42 } }, // invalid-params
        { id: 'a', type: 'mock.text', params: { value: 'hi' } }, // duplicate-node-id
        { id: 'u', type: 'mock.upper', params: {} }, // missing-required-input
        { id: 'x', type: 'unknown.type', params: {} }, // unknown-node-type
      ],
      edges: [
        { id: 'e1', from: { node: 'nope', port: 'text' }, to: { node: 'u', port: 'text' } }, // unknown-edge-endpoint
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'u', port: 'text' } }, // duplicate-edge-id
      ],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = new Set(result.issues.map((i) => i.code));
      expect(codes).toContain('duplicate-node-id');
      expect(codes).toContain('invalid-params');
      expect(codes).toContain('unknown-node-type');
      expect(codes).toContain('unknown-edge-endpoint');
      expect(codes).toContain('duplicate-edge-id');
      // Sanity: more than one distinct issue code found -> not short-circuited.
      expect(codes.size).toBeGreaterThan(1);
    }
  });

  it('reports duplicate-input when two edges feed the same input port', () => {
    const registry = makeRegistry();
    const wf = {
      version: 1,
      id: 'wf1',
      nodes: [
        { id: 'a', type: 'mock.text', params: { value: 'hi' } },
        { id: 'b', type: 'mock.text', params: { value: 'yo' } },
        { id: 'u', type: 'mock.upper', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'u', port: 'text' } },
        { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'u', port: 'text' } },
      ],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dup = result.issues.find((i) => i.code === 'duplicate-input');
      expect(dup).toBeDefined();
      expect(dup?.nodeId).toBe('u');
    }
  });

  it('reports a cycle issue for a cyclic workflow', () => {
    const registry = makeRegistry();
    const wf: Workflow = {
      version: 1,
      id: 'wf1',
      name: '',
      nodes: [
        { id: 'a', type: 'mock.upper', params: {} },
        { id: 'b', type: 'mock.upper', params: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'text' }, to: { node: 'b', port: 'text' } },
        { id: 'e2', from: { node: 'b', port: 'text' }, to: { node: 'a', port: 'text' } },
      ],
    };
    const result = validateWorkflow(wf, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'cycle')).toBe(true);
    }
  });
});
