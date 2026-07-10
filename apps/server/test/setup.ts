/**
 * Global vitest setup (SPEC-step2.md §9, extended by SPEC-step3.md §6), wired
 * via vitest.config.ts's `test.setupFiles`. Runs once per test file, before
 * that file's own tests.
 *
 * Three responsibilities:
 *
 * 1. Unmocked-fetch guard — stub `globalThis.fetch` before every test to a
 *    function that always throws `'unmocked fetch: ' + url`. This makes any
 *    test that forgets to mock `fetch` fail loudly instead of silently
 *    reaching the real network. Individual tests override `globalThis.fetch`
 *    with their own mock.
 *
 *    Exception: requests to 127.0.0.1/localhost (any port) are let through to
 *    the *real* fetch — api-sse.test.ts spins up a real HTTP server
 *    (`app.listen({ port: 0 })`) and talks to it over loopback, which isn't a
 *    "real network call" in the sense this guard exists to prevent. Every
 *    other host still throws.
 *
 * 2. Real-secret guard — force all 5 config.ts env keys to obviously-fake
 *    dummy values before every test. `config.ts`'s `loadEnv()` discovers the
 *    repo root by walking up from its own real source location, so any test
 *    that exercises a provider (openrouter/fal/vbee) without first mocking
 *    the `dotenv` module would otherwise cause the REAL `.env.local` (which
 *    holds live API keys) to be parsed into `process.env` via dotenv's
 *    `override: false` (since nothing would already occupy those keys).
 *    Pre-populating dummy values here closes that hole: `override: false`
 *    means these dummies always win over whatever the real file contains.
 *    Tests that specifically need to exercise "missing key" behavior
 *    (config.test.ts) delete/override these locally within their own
 *    beforeEach/it and restore them afterward.
 */
import { beforeEach } from 'vitest';

// Captured once, at module-load time — before the first beforeEach() ever
// overwrites globalThis.fetch — so the loopback exception below always calls
// the real, unmocked fetch implementation.
const realFetch = globalThis.fetch;

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function unmockedFetch(input: unknown, init?: RequestInit): unknown {
  const url = urlOf(input);
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = undefined;
  }

  if (hostname && isLoopbackHost(hostname)) {
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }

  throw new Error(`unmocked fetch: ${url}`);
}

const DUMMY_ENV: Record<string, string> = {
  OPENROUTER_API_KEY: 'test-openrouter-key',
  OPENROUTER_DEFAULT_MODEL: 'test/dummy-model',
  FAL_KEY: 'test-fal-key-id:test-fal-key-secret',
  VBEE_APP_ID: 'test-vbee-app-id',
  VBEE_TOKEN: 'test-vbee-token',
};

beforeEach(() => {
  globalThis.fetch = unmockedFetch as unknown as typeof fetch;
  for (const [key, value] of Object.entries(DUMMY_ENV)) {
    process.env[key] = value;
  }
});
