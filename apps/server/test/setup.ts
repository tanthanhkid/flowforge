/**
 * Global vitest setup (SPEC-step2.md §9), wired via vitest.config.ts's
 * `test.setupFiles`. Runs once per test file, before that file's own tests.
 *
 * Two responsibilities:
 *
 * 1. Unmocked-fetch guard — stub `globalThis.fetch` before every test to a
 *    function that always throws `'unmocked fetch: ' + url`. This makes any
 *    test that forgets to mock `fetch` fail loudly instead of silently
 *    reaching the real network. Individual tests override `globalThis.fetch`
 *    with their own mock.
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

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

function unmockedFetch(input: unknown): never {
  throw new Error(`unmocked fetch: ${urlOf(input)}`);
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
