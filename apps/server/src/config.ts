import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

/**
 * FlowForge server config loader (SPEC-step2.md §2).
 *
 * Loads `.env.local` from the monorepo root (found by walking up from this
 * file's own directory until a `pnpm-workspace.yaml` is found) and exposes a
 * small typed accessor for the handful of secrets the server needs.
 *
 * NEVER log the values returned by getEnv().
 */

export type EnvKey =
  | 'OPENROUTER_API_KEY'
  | 'OPENROUTER_DEFAULT_MODEL'
  | 'OPENROUTER_BASE_URL'
  | 'FAL_KEY'
  | 'VBEE_APP_ID'
  | 'VBEE_TOKEN';

const DEFAULTS: Partial<Record<EnvKey, string>> = {
  OPENROUTER_DEFAULT_MODEL: 'x-ai/grok-4.5',
  // SPEC-step28.md §2 — additive: only ever overridden by e2e's free-tier
  // webServer env (playwright.config.ts), pointing this at the local mock
  // OpenRouter server (e2e/mock-openrouter.ts) instead of the real API, at
  // zero cost. Production/dev/real-tier e2e never set this, so
  // `openrouter.ts` keeps hitting the real `https://openrouter.ai/api/v1`.
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
};

/**
 * Walk up from `startDir` until a directory containing `pnpm-workspace.yaml`
 * is found (the monorepo root). Returns undefined if none is found.
 * Exported (in addition to the spec's mandated loadEnv/getEnv) so it can be
 * unit-tested in isolation against a fixture directory tree.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let didLoad = false;

/**
 * Finds the repo root and loads `<root>/.env.local` into process.env via
 * dotenv, with `override: false` so any value already present in
 * process.env wins over the file. Idempotent: subsequent calls are no-ops.
 */
export function loadEnv(): void {
  if (didLoad) return;
  didLoad = true;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) return;

  dotenvConfig({ path: path.join(repoRoot, '.env.local'), override: false, quiet: true });
}

/**
 * Returns the value of `key` from process.env (after ensuring `.env.local`
 * has been loaded), falling back to the built-in default for
 * OPENROUTER_DEFAULT_MODEL when unset.
 *
 * Throws a clear error (naming the missing variable) unless
 * `opts.optional` is true, in which case a missing value resolves to ''.
 */
export function getEnv(key: EnvKey, opts?: { optional?: boolean }): string {
  loadEnv();

  // `||` (not `??`): a blank assignment in `.env.local` (e.g. `KEY=`) sets
  // process.env[key] to '' rather than leaving it unset, and an empty
  // string should fall through to DEFAULTS[key] the same way an unset
  // variable does (e.g. OPENROUTER_DEFAULT_MODEL must still resolve to its
  // 'x-ai/grok-4.5' fallback instead of throwing).
  const value = process.env[key] || DEFAULTS[key];
  if (value) return value;

  if (opts?.optional) return '';

  throw new Error(`Thiếu biến môi trường "${key}" — vui lòng cấu hình trong .env.local`);
}
