/**
 * SPEC-step33.md §33c — GateRegistry unit tests (independent of Engine).
 */
import { describe, expect, it } from 'vitest';
import { GateRegistry } from '../src/engine/gateRegistry.js';

describe('GateRegistry', () => {
  it('resolve() settles the register() promise with the given value, and clears hasPending', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    const promise = gate.register('run-1', 'node-1', { plan: {} }, controller.signal);

    expect(gate.hasPending('run-1', 'node-1')).toBe(true);
    expect(gate.resolve('run-1', 'node-1', { edited: true })).toBe(true);
    expect(gate.hasPending('run-1', 'node-1')).toBe(false);
    await expect(promise).resolves.toEqual({ edited: true });
  });

  it('reject() settles the register() promise with an error', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    const promise = gate.register('run-2', 'node-1', {}, controller.signal);

    expect(gate.reject('run-2', 'node-1', new Error('nope'))).toBe(true);
    await expect(promise).rejects.toThrow('nope');
  });

  it('resolve()/reject() return false when there is no pending gate', () => {
    const gate = new GateRegistry();
    expect(gate.resolve('run-x', 'node-x', 1)).toBe(false);
    expect(gate.reject('run-x', 'node-x', new Error('x'))).toBe(false);
  });

  it('aborting the signal rejects the pending promise and clears it', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    const promise = gate.register('run-3', 'node-1', {}, controller.signal);

    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
    expect(gate.hasPending('run-3', 'node-1')).toBe(false);
  });

  it('registering against an already-aborted signal rejects immediately', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    controller.abort();

    const promise = gate.register('run-4', 'node-1', {}, controller.signal);
    await expect(promise).rejects.toThrow('aborted');
  });

  it('rejects after timeoutMs elapses when nothing resolves it (tiny timeout)', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    const promise = gate.register('run-5', 'node-1', {}, controller.signal, 20);

    await expect(promise).rejects.toThrow(/hết thời gian|timeout/i);
    expect(gate.hasPending('run-5', 'node-1')).toBe(false);
  });

  it('registering twice for the same (runId, nodeId) while one is pending throws synchronously', async () => {
    const gate = new GateRegistry();
    const controller = new AbortController();
    const first = gate.register('run-6', 'node-1', {}, controller.signal);
    expect(() => gate.register('run-6', 'node-1', {}, controller.signal)).toThrow();

    // Clean up `first`'s pending timer/listener (default timeout is 30 min,
    // not unref'd — see gateRegistry.ts) so this test doesn't leave a
    // dangling real timer alive after the suite finishes.
    controller.abort();
    await expect(first).rejects.toThrow('aborted');
  });
});
