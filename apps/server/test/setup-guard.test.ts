/**
 * Self-test for test/setup.ts's unmocked-fetch guard (SPEC-step3.md §6: the
 * guard must "vẫn chặn mọi host khác" — still block every other host).
 *
 * No test in the rest of the suite ever exercises the block path directly:
 * api-sse.test.ts only exercises the loopback allow-path. Without a direct
 * assertion here, a future refactor of unmockedFetch()/isLoopbackHost() that
 * accidentally widens the allow-list (inverted condition, hostname-parse
 * fallback matching, etc.) would leave the whole suite green while quietly
 * removing the no-real-network safety net.
 */
import { describe, expect, it } from 'vitest';

describe('test/setup.ts unmocked-fetch guard', () => {
  it('throws synchronously for a non-loopback host', () => {
    expect(() => fetch('https://example.com/')).toThrow(/unmocked fetch: https:\/\/example\.com\//);
  });

  it('throws for other real provider-shaped hosts too', () => {
    expect(() => fetch('https://openrouter.ai/api/v1/chat/completions')).toThrow(/unmocked fetch/);
    expect(() => fetch('https://queue.fal.run/fal-ai/flux/dev')).toThrow(/unmocked fetch/);
  });

  it('does not throw synchronously for a loopback URL (allow-path stays open)', async () => {
    // Nothing listens on port 1, so the real connection attempt this
    // reaches (realFetch) will reject — but asynchronously, as a rejected
    // promise. The guard itself must not throw synchronously before ever
    // calling realFetch, which is exactly the observable difference between
    // "blocked" (throws synchronously) and "allowed" (delegates to
    // realFetch). Await-and-swallow the doomed connection so it doesn't
    // surface as an unhandled rejection.
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = fetch('http://127.0.0.1:1/') as unknown as Promise<unknown>;
    }).not.toThrow();
    await pending?.catch(() => {});
  });
});
