import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../src/engine/context.js';

describe('poll()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the correct value once check() reports done (after 3 checks)', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    const controller = new AbortController();

    const promise = poll<string>(
      async () => {
        calls += 1;
        timestamps.push(Date.now());
        if (calls >= 3) return { done: true, value: 'ok' };
        return { done: false };
      },
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const value = await promise;

    expect(value).toBe('ok');
    expect(calls).toBe(3);
    // delay(0) = 1000ms between check 1 -> 2, delay(1) = 1500ms between check 2 -> 3.
    expect(timestamps[1]! - timestamps[0]!).toBe(1000);
    expect(timestamps[2]! - timestamps[1]!).toBe(1500);
  });

  it('increases delay per exponential backoff: 1000, 1500, 2250, ...', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    const controller = new AbortController();

    const promise = poll<string>(
      async () => {
        calls += 1;
        timestamps.push(Date.now());
        if (calls >= 4) return { done: true, value: 'ok' };
        return { done: false };
      },
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    const deltas = timestamps.slice(1).map((t, i) => t - timestamps[i]!);
    expect(deltas).toEqual([1000, 1500, 2250]);
  });

  it('caps the delay at maxDelayMs', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    const controller = new AbortController();

    const promise = poll<string>(
      async () => {
        calls += 1;
        timestamps.push(Date.now());
        if (calls >= 4) return { done: true, value: 'ok' };
        return { done: false };
      },
      controller.signal,
      { initialDelayMs: 1000, factor: 2, maxDelayMs: 1500 },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    const deltas = timestamps.slice(1).map((t, i) => t - timestamps[i]!);
    // Uncapped would be 1000, 2000, 4000 — capped at maxDelayMs=1500.
    expect(deltas).toEqual([1000, 1500, 1500]);
  });

  it('rejects with an error containing "timeout" once timeoutMs elapses', async () => {
    const controller = new AbortController();
    const promise = poll<string>(async () => ({ done: false }), controller.signal, {
      timeoutMs: 5000,
      initialDelayMs: 1000,
      factor: 1,
      maxDelayMs: 1000,
    });

    const assertion = expect(promise).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = poll<string>(async () => ({ done: false }), controller.signal);
    await expect(promise).rejects.toThrow('aborted');
  });

  it('rejects when the abort signal fires while waiting between checks', async () => {
    const controller = new AbortController();
    let calls = 0;

    const promise = poll<string>(
      async () => {
        calls += 1;
        return { done: false };
      },
      controller.signal,
      { initialDelayMs: 5000 },
    );

    // Let the first check() resolve so poll() enters its backoff sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
  });
});
