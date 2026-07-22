/**
 * SPEC-step33.md §33c — engine approval-gate tests: `flow.approveGate` +
 * `GateRegistry` wired through `Engine`'s optional `EngineOptions.gate`.
 * Complements `engine.test.ts` (unchanged, still green) — this file only
 * exercises the new gate/abort behavior.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCacheStore } from '../src/engine/cache.js';
import { Engine } from '../src/engine/executor.js';
import { GateRegistry } from '../src/engine/gateRegistry.js';
import { NodeRegistry } from '../src/engine/registry.js';
import type { Workflow } from '../src/engine/schema.js';
import { InMemoryRunStore } from '../src/engine/stores.js';
import { flowApproveGateNode } from '../src/nodes/flow.approveGate.js';
import { registerBaseMocks } from './helpers/mockNodes.js';

/** Lets already-queued microtasks (sync node chains) settle before we peek
 * at intermediate state — nothing here uses real timers/fake timers, so a
 * couple of macrotask turns is enough for everything except the parked gate
 * node to reach its final state. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SAMPLE_PLAN = { moments: [{ id: 'm1', start: 0, end: 1, title: 'Khoảnh khắc 1' }] };
const EDITED_PLAN = { moments: [{ id: 'm1', start: 0, end: 2, title: 'Khoảnh khắc 1 (sửa)' }] };

function gateWorkflow(): Workflow {
  return {
    version: 1,
    id: 'gate-wf',
    name: '',
    nodes: [
      { id: 'plan', type: 'mock.plan', params: { value: SAMPLE_PLAN } },
      { id: 'gate', type: 'flow.approveGate', params: {} },
      { id: 'down', type: 'mock.echoJson', params: {} },
      { id: 'sibling', type: 'mock.text', params: { value: 'ok' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'plan', port: 'plan' }, to: { node: 'gate', port: 'plan' } },
      { id: 'e2', from: { node: 'gate', port: 'plan' }, to: { node: 'down', port: 'plan' } },
    ],
  };
}

function newGatedEngine() {
  const registry = new NodeRegistry();
  registerBaseMocks(registry);
  registry.register(flowApproveGateNode);
  const runStore = new InMemoryRunStore();
  const cacheStore = new InMemoryCacheStore();
  const gate = new GateRegistry();
  const engine = new Engine(registry, { runs: runStore, cache: cacheStore }, { gate });
  return { registry, runStore, cacheStore, gate, engine };
}

describe('Engine.run — approval gate (flow.approveGate + GateRegistry)', () => {
  it('parks the gate node at "awaiting" (with pendingApproval), keeps the run "running", and still finishes an independent sibling branch', async () => {
    const { engine, runStore, gate } = newGatedEngine();
    const runId = 'run-parks';

    const runPromise = engine.run(gateWorkflow(), { runId });
    await flush();

    const snapshot = runStore.getRun(runId);
    expect(snapshot?.run.status).toBe('running');

    const gateRec = snapshot?.nodes.find((n) => n.nodeId === 'gate');
    expect(gateRec?.state).toBe('awaiting');
    expect(gateRec?.outputs?.pendingApproval).toEqual({ plan: SAMPLE_PLAN });

    const siblingRec = snapshot?.nodes.find((n) => n.nodeId === 'sibling');
    expect(siblingRec?.state).toBe('success');

    const downRec = snapshot?.nodes.find((n) => n.nodeId === 'down');
    expect(downRec?.state).toBe('pending');

    // Let it finish so the test doesn't leave a dangling promise.
    gate.resolve(runId, 'gate', SAMPLE_PLAN);
    const result = await runPromise;
    expect(result.status).toBe('success');
  });

  it('resolveGate with an edited plan runs downstream with the edited plan, run ends success', async () => {
    const { engine, gate } = newGatedEngine();
    const runId = 'run-edit';

    const runPromise = engine.run(gateWorkflow(), { runId });
    await flush();
    expect(gate.hasPending(runId, 'gate')).toBe(true);

    const resolved = gate.resolve(runId, 'gate', EDITED_PLAN);
    expect(resolved).toBe(true);
    expect(gate.hasPending(runId, 'gate')).toBe(false);

    const result = await runPromise;
    expect(result.status).toBe('success');
    expect(result.nodes.gate?.outputs?.plan).toEqual(EDITED_PLAN);
    expect(result.nodes.down?.outputs?.plan).toEqual(EDITED_PLAN);
  });

  it('aborting the run while awaiting rejects the gate, errors the gate node, cascades skip downstream, run ends error', async () => {
    const { engine } = newGatedEngine();
    const controller = new AbortController();
    const runId = 'run-abort';

    const runPromise = engine.run(gateWorkflow(), { runId, signal: controller.signal });
    await flush();

    controller.abort();
    const result = await runPromise;

    expect(result.status).toBe('error');
    expect(result.nodes.gate?.state).toBe('error');
    expect(result.nodes.gate?.error).toContain('aborted');
    expect(result.nodes.down?.state).toBe('skipped');
    // Independent branch is unaffected by the abort of a *different* node's
    // gate promise — only the run-level signal fires, which every node
    // shares; mock.text's execute() already resolved by the time abort()
    // fires, so it stays success.
    expect(result.nodes.sibling?.state).toBe('success');
  });

  it('headless (no GateRegistry) — flow.approveGate passes the plan straight through, run succeeds without parking', async () => {
    const registry = new NodeRegistry();
    registerBaseMocks(registry);
    registry.register(flowApproveGateNode);
    const runStore = new InMemoryRunStore();
    const cacheStore = new InMemoryCacheStore();
    const engine = new Engine(registry, { runs: runStore, cache: cacheStore }); // no `gate` opt

    const result = await engine.run(gateWorkflow());
    expect(result.status).toBe('success');
    expect(result.nodes.gate?.state).toBe('success');
    expect(result.nodes.gate?.outputs?.plan).toEqual(SAMPLE_PLAN);
    expect(result.nodes.down?.outputs?.plan).toEqual(SAMPLE_PLAN);
  });

  it('rejectGate errors the gate node explicitly (not just via abort)', async () => {
    const { engine, gate } = newGatedEngine();
    const runId = 'run-reject';

    const runPromise = engine.run(gateWorkflow(), { runId });
    await flush();

    const rejected = gate.reject(runId, 'gate', new Error('user cancelled'));
    expect(rejected).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe('error');
    expect(result.nodes.gate?.state).toBe('error');
    expect(result.nodes.gate?.error).toContain('user cancelled');
    expect(result.nodes.down?.state).toBe('skipped');
  });
});

// Note: "Run-abort of a normal running node → node error + cascade skip"
// (a mid-poll ctx.poll() node) is already covered by
// `engine.test.ts`'s "aborting RunOptions.signal errors a node that is
// mid-poll" — unchanged and still green; not duplicated here.
