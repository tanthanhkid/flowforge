import { describe, expect, it } from 'vitest';
import { openDb, SqliteCacheStore, SqliteRunStore } from '../src/db/sqlite.js';
import { Engine } from '../src/engine/executor.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { registerBaseMocks } from './helpers/mockNodes.js';

describe('openDb', () => {
  it('creates the expected schema tables on an in-memory database', () => {
    const db = openDb(':memory:');
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[];
    const tables = rows.map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['workflows', 'runs', 'node_runs', 'cache', 'settings']));
    db.close();
  });
});

describe('SqliteRunStore', () => {
  it('round-trips run + node state + logs', () => {
    const db = openDb(':memory:');
    const store = new SqliteRunStore(db);

    store.createRun({ id: 'run1', workflowId: 'wf1', workflowJson: '{}', status: 'running', createdAt: 100 });
    store.upsertNodeRun({
      runId: 'run1',
      nodeId: 'A',
      state: 'running',
      logs: [],
      cacheHit: false,
      startedAt: 100,
    });
    store.appendNodeLog('run1', 'A', 'log line 1');
    store.appendNodeLog('run1', 'A', 'log line 2');
    store.upsertNodeRun({
      runId: 'run1',
      nodeId: 'A',
      state: 'success',
      outputs: { text: 'hi' },
      logs: ['log line 1', 'log line 2'],
      cacheHit: false,
      startedAt: 100,
      finishedAt: 200,
    });
    store.finishRun('run1', 'success', 200);

    const result = store.getRun('run1');
    expect(result).toBeDefined();
    expect(result?.run.status).toBe('success');
    expect(result?.run.finishedAt).toBe(200);

    const nodeA = result?.nodes.find((n) => n.nodeId === 'A');
    expect(nodeA?.state).toBe('success');
    expect(nodeA?.outputs).toEqual({ text: 'hi' });
    expect(nodeA?.logs).toEqual(['log line 1', 'log line 2']);
    expect(nodeA?.cacheHit).toBe(false);
    expect(nodeA?.startedAt).toBe(100);
    expect(nodeA?.finishedAt).toBe(200);

    db.close();
  });

  it('returns undefined for a run id that does not exist', () => {
    const db = openDb(':memory:');
    const store = new SqliteRunStore(db);
    expect(store.getRun('missing')).toBeUndefined();
    db.close();
  });

  describe('latestRunForWorkflow (SPEC-step30.md §2)', () => {
    it('returns the most recently created run for that workflow, full node detail included', () => {
      const db = openDb(':memory:');
      const store = new SqliteRunStore(db);

      store.createRun({ id: 'run-old', workflowId: 'wf-1', workflowJson: '{}', status: 'success', createdAt: 100 });
      store.createRun({ id: 'run-new', workflowId: 'wf-1', workflowJson: '{}', status: 'error', createdAt: 200 });
      store.upsertNodeRun({ runId: 'run-new', nodeId: 'A', state: 'error', logs: [], cacheHit: false });
      // a different workflow's run, newer still — must not "win" over wf-1's own latest.
      store.createRun({ id: 'run-other-wf', workflowId: 'wf-2', workflowJson: '{}', status: 'success', createdAt: 300 });

      const found = store.latestRunForWorkflow('wf-1');
      expect(found?.run.id).toBe('run-new');
      expect(found?.nodes.map((n) => n.nodeId)).toEqual(['A']);

      db.close();
    });

    it('returns undefined when the workflow has never been run', () => {
      const db = openDb(':memory:');
      const store = new SqliteRunStore(db);
      expect(store.latestRunForWorkflow('never-run')).toBeUndefined();
      db.close();
    });
  });
});

describe('SqliteCacheStore', () => {
  it('set() then get() returns the exact outputs written', () => {
    const db = openDb(':memory:');
    const store = new SqliteCacheStore(db);
    expect(store.get('key1')).toBeUndefined();
    store.set('key1', 'mock.counter', { text: 'hello', count: 1 });
    expect(store.get('key1')).toEqual({ text: 'hello', count: 1 });
    db.close();
  });
});

describe('Engine + sqlite-backed stores (end-to-end)', () => {
  it('runs a workflow with mock nodes and records full node_runs rows', async () => {
    const db = openDb(':memory:');
    const runStore = new SqliteRunStore(db);
    const cacheStore = new SqliteCacheStore(db);
    const registry = new NodeRegistry();
    registerBaseMocks(registry);
    const engine = new Engine(registry, { runs: runStore, cache: cacheStore });

    const wf: Workflow = {
      version: 1,
      id: 'sqlite-wf',
      name: '',
      nodes: [
        { id: 'A', type: 'mock.text', params: { value: 'hi' } },
        { id: 'B', type: 'mock.upper', params: {} },
      ],
      edges: [{ id: 'e1', from: { node: 'A', port: 'text' }, to: { node: 'B', port: 'text' } }],
    };

    const result = await engine.run(wf);
    expect(result.status).toBe('success');

    const stored = runStore.getRun(result.runId);
    expect(stored).toBeDefined();
    expect(stored?.nodes).toHaveLength(2);

    const byId = new Map(stored?.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get('A')?.state).toBe('success');
    expect(byId.get('A')?.outputs).toEqual({ text: 'hi' });
    expect(byId.get('B')?.state).toBe('success');
    expect(byId.get('B')?.outputs).toEqual({ text: 'HI' });

    // Cache entries were persisted to sqlite too — a second run should cache-hit.
    const result2 = await engine.run(wf);
    expect(result2.status).toBe('success');
    expect(result2.nodes.B?.cached).toBe(true);

    db.close();
  });
});
