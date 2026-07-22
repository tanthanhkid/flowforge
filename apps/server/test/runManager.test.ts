/**
 * SPEC-step33.md §33c.0/§33c — RunManager's run-abort (`stopRun`) and gate
 * passthrough (`resolveGate`/`rejectGate`) wiring, at the RunManager level
 * (below HTTP — routes/runs.ts's stop/resume endpoints are covered by
 * api-runs-gate.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { GateRegistry } from '../src/engine/gateRegistry.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import { flowApproveGateNode } from '../src/nodes/flow.approveGate.js';
import { RunManager } from '../src/runManager.js';
import { registerBaseMocks } from './helpers/mockNodes.js';

function waitForRunState(runManager: RunManager, runId: string, timeoutMs = 2000): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const snapshot = runManager.getRun(runId);
      if (snapshot && snapshot.run.status !== 'running') {
        resolve({ status: snapshot.run.status });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`run ${runId} did not finish within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForNodeState(runManager: RunManager, runId: string, nodeId: string, state: string, timeoutMs = 2000) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const snapshot = runManager.getRun(runId);
      const rec = snapshot?.nodes.find((n) => n.nodeId === nodeId);
      if (rec?.state === state) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`node ${nodeId} did not reach state "${state}" within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function setup(withGate: boolean) {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  registry.register(flowApproveGateNode);
  const runStore = new InMemoryRunStore();
  const cacheStore = new InMemoryCacheStore();
  const gate = withGate ? new GateRegistry() : undefined;
  const engine = new Engine(registry, { runs: runStore, cache: cacheStore }, { gate });
  const runManager = new RunManager(engine, runStore, registry, gate);
  return { registry, runManager, gate };
}

describe('RunManager — stopRun (SPEC-step33.md §33c.0)', () => {
  it('stopRun on an active run aborts it: the running node errors, run ends error', async () => {
    const { runManager } = setup(false);
    const wf: Workflow = {
      version: 1,
      id: 'wf-abort',
      name: '',
      nodes: [{ id: 'H', type: 'mock.awaitAbort', params: {} }],
      edges: [],
    };

    const { runId } = runManager.start(wf);
    await waitForNodeState(runManager, runId, 'H', 'running');

    expect(runManager.stopRun(runId)).toBe(true);

    const finished = await waitForRunState(runManager, runId);
    expect(finished.status).toBe('error');
    const rec = runManager.getRun(runId)?.nodes.find((n) => n.nodeId === 'H');
    expect(rec?.state).toBe('error');
    expect(rec?.error).toContain('aborted');
  });

  it('stopRun on an unknown/inactive runId returns false', () => {
    const { runManager } = setup(false);
    expect(runManager.stopRun('does-not-exist')).toBe(false);
  });

  it('isActive() flips to false once the run finishes, and stopRun no longer works after that', async () => {
    const { runManager } = setup(false);
    const wf: Workflow = {
      version: 1,
      id: 'wf-quick',
      name: '',
      nodes: [{ id: 'A', type: 'mock.text', params: { value: 'x' } }],
      edges: [],
    };
    const { runId } = runManager.start(wf);
    await waitForRunState(runManager, runId);
    expect(runManager.isActive(runId)).toBe(false);
    expect(runManager.stopRun(runId)).toBe(false);
  });
});

describe('RunManager — resolveGate/rejectGate (SPEC-step33.md §33c)', () => {
  function gateWorkflow(): Workflow {
    return {
      version: 1,
      id: 'wf-gate',
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
  }

  it('resolveGate resolves the parked node and lets the run finish success', async () => {
    const { runManager } = setup(true);
    const { runId } = runManager.start(gateWorkflow());
    await waitForNodeState(runManager, runId, 'gate', 'awaiting');

    expect(runManager.resolveGate(runId, 'gate', { moments: [] })).toBe(true);

    const finished = await waitForRunState(runManager, runId);
    expect(finished.status).toBe('success');
    const down = runManager.getRun(runId)?.nodes.find((n) => n.nodeId === 'down');
    expect(down?.outputs?.plan).toEqual({ moments: [] });
  });

  it('rejectGate errors the parked node, run ends error', async () => {
    const { runManager } = setup(true);
    const { runId } = runManager.start(gateWorkflow());
    await waitForNodeState(runManager, runId, 'gate', 'awaiting');

    expect(runManager.rejectGate(runId, 'gate', new Error('huỷ'))).toBe(true);

    const finished = await waitForRunState(runManager, runId);
    expect(finished.status).toBe('error');
    const gateRec = runManager.getRun(runId)?.nodes.find((n) => n.nodeId === 'gate');
    expect(gateRec?.error).toContain('huỷ');
  });

  it('resolveGate/rejectGate return false when the RunManager has no GateRegistry', () => {
    const { runManager } = setup(false);
    expect(runManager.resolveGate('r', 'n', {})).toBe(false);
    expect(runManager.rejectGate('r', 'n', new Error('x'))).toBe(false);
  });

  it('resolveGate returns false for a nodeId with no pending gate', async () => {
    const { runManager } = setup(true);
    const { runId } = runManager.start(gateWorkflow());
    await waitForNodeState(runManager, runId, 'gate', 'awaiting');

    expect(runManager.resolveGate(runId, 'not-a-gate', {})).toBe(false);

    // Clean up: resolve the real gate so the run doesn't dangle.
    runManager.resolveGate(runId, 'gate', { moments: [] });
    await waitForRunState(runManager, runId);
  });

  it('stopRun while a run is awaiting a gate rejects the gate too (run-abort propagates through GateRegistry)', async () => {
    const { runManager } = setup(true);
    const { runId } = runManager.start(gateWorkflow());
    await waitForNodeState(runManager, runId, 'gate', 'awaiting');

    expect(runManager.stopRun(runId)).toBe(true);

    const finished = await waitForRunState(runManager, runId);
    expect(finished.status).toBe('error');
    const gateRec = runManager.getRun(runId)?.nodes.find((n) => n.nodeId === 'gate');
    expect(gateRec?.state).toBe('error');
    expect(gateRec?.error).toContain('aborted');
  });
});
