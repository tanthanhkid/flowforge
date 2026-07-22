/**
 * SPEC-step2.md §9 — config.test.ts.
 *
 * IMPORTANT: never let these tests touch the real `.env.local` (it holds
 * live API keys). Every test that calls `getEnv()`/`loadEnv()` mocks the
 * `dotenv` module to a no-op first, so the real repo-root `.env.local` is
 * never actually parsed. The one test that verifies dotenv's file-parsing +
 * override semantics uses the *real* `dotenv` package but only against a
 * throwaway fixture file this test creates itself.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_DEFAULT_MODEL',
  'FAL_KEY',
  'FAL_QUEUE_BASE_URL',
  'FAL_REST_BASE_URL',
  'VBEE_APP_ID',
  'VBEE_TOKEN',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  // setup.ts's global beforeEach already forced dummy values for these keys;
  // snapshot them so each test can freely delete/mutate and we restore after.
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.doUnmock('dotenv');
  vi.resetModules();
});

describe('findRepoRoot', () => {
  it('walks up from a nested directory to the one containing pnpm-workspace.yaml', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-reporoot-'));
    try {
      writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
      const deep = path.join(tmp, 'apps', 'server', 'src');
      mkdirSync(deep, { recursive: true });

      const { findRepoRoot } = await import('../src/config.js');
      expect(findRepoRoot(deep)).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns undefined when no pnpm-workspace.yaml exists anywhere up the tree', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-noreporoot-'));
    try {
      const { findRepoRoot } = await import('../src/config.js');
      expect(findRepoRoot(tmp)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadEnv() wiring', () => {
  it('calls dotenv.config with override:false, quiet:true, and a path ending in .env.local; is idempotent', async () => {
    const dotenvConfigMock = vi.fn();
    vi.doMock('dotenv', () => ({ config: dotenvConfigMock }));
    vi.resetModules();

    const { loadEnv } = await import('../src/config.js');
    loadEnv();

    expect(dotenvConfigMock).toHaveBeenCalledTimes(1);
    const arg = dotenvConfigMock.mock.calls[0]![0] as { path: string; override: boolean; quiet: boolean };
    expect(arg.path.endsWith('.env.local')).toBe(true);
    expect(arg.override).toBe(false);
    expect(arg.quiet).toBe(true);

    // Second call is a no-op (idempotent).
    loadEnv();
    expect(dotenvConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe('dotenv override:false semantics (fixture, real dotenv package)', () => {
  it('file value fills in an unset key; a pre-set process.env value wins over the file', async () => {
    // Exercises the exact mechanism config.ts's loadEnv() relies on
    // (dotenv.config({ override: false })), using a throwaway fixture file —
    // never the real repo-root .env.local.
    const { config: dotenvConfig } = await vi.importActual<typeof import('dotenv')>('dotenv');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ff-dotenv-fixture-'));
    const envPath = path.join(tmp, '.env.local');
    try {
      writeFileSync(envPath, 'FF_TEST_FILE_ONLY=from-file\nFF_TEST_ENV_WINS=from-file\n');
      delete process.env.FF_TEST_FILE_ONLY;
      process.env.FF_TEST_ENV_WINS = 'from-process-env';

      dotenvConfig({ path: envPath, override: false, quiet: true });

      expect(process.env.FF_TEST_FILE_ONLY).toBe('from-file');
      expect(process.env.FF_TEST_ENV_WINS).toBe('from-process-env');
    } finally {
      delete process.env.FF_TEST_FILE_ONLY;
      delete process.env.FF_TEST_ENV_WINS;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('getEnv()', () => {
  async function importFreshConfig() {
    vi.doMock('dotenv', () => ({ config: vi.fn() })); // no-op: never touch the real .env.local
    vi.resetModules();
    return import('../src/config.js');
  }

  it('throws a clear error naming the missing variable and pointing at .env.local', async () => {
    delete process.env.FAL_KEY;
    const { getEnv } = await importFreshConfig();
    expect(() => getEnv('FAL_KEY')).toThrow(/FAL_KEY/);
    expect(() => getEnv('FAL_KEY')).toThrow(/\.env\.local/);
  });

  it('OPENROUTER_DEFAULT_MODEL falls back to "x-ai/grok-4.5" when unset', async () => {
    delete process.env.OPENROUTER_DEFAULT_MODEL;
    const { getEnv } = await importFreshConfig();
    expect(getEnv('OPENROUTER_DEFAULT_MODEL')).toBe('x-ai/grok-4.5');
  });

  it('returns an explicitly-set process.env value untouched', async () => {
    process.env.OPENROUTER_API_KEY = 'explicit-test-value-123';
    const { getEnv } = await importFreshConfig();
    expect(getEnv('OPENROUTER_API_KEY')).toBe('explicit-test-value-123');
  });

  // SPEC-step33.md §33e-2 — additive fal.ai host overrides for
  // `nodes/providers/fal.ts`: asserts the defaults stay exactly the real
  // hosts (byte-identical prod/dev/real-tier e2e behavior) when unset, same
  // as OPENROUTER_BASE_URL's own default is never asserted-broken here.
  it('FAL_QUEUE_BASE_URL falls back to "https://queue.fal.run" when unset', async () => {
    delete process.env.FAL_QUEUE_BASE_URL;
    const { getEnv } = await importFreshConfig();
    expect(getEnv('FAL_QUEUE_BASE_URL')).toBe('https://queue.fal.run');
  });

  it('FAL_REST_BASE_URL falls back to "https://rest.fal.ai" when unset', async () => {
    delete process.env.FAL_REST_BASE_URL;
    const { getEnv } = await importFreshConfig();
    expect(getEnv('FAL_REST_BASE_URL')).toBe('https://rest.fal.ai');
  });

  it('opts.optional:true returns "" instead of throwing when the key is missing', async () => {
    delete process.env.VBEE_TOKEN;
    const { getEnv } = await importFreshConfig();
    expect(getEnv('VBEE_TOKEN', { optional: true })).toBe('');
  });

  it('never logs key values (sanity: error message for a present-but-checked key omits its value)', async () => {
    process.env.VBEE_APP_ID = 'super-secret-app-id-value';
    const { getEnv } = await importFreshConfig();
    // Getting a present key just returns it (no throw, nothing printed) —
    // assert the call is silent (no console.log/error) as a light guard
    // against the code accidentally logging.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(getEnv('VBEE_APP_ID')).toBe('super-secret-app-id-value');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
