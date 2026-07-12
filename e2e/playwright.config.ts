/**
 * Playwright config (SPEC-step7.md §2): boots both the real server (tsx,
 * scratch DB/artifacts dir under `e2e/.tmp`) and the real web dev server
 * (vite) pointed at each other via env vars, then drives chromium against
 * the web server's baseURL.
 *
 * FREE tier only by default: nothing here sets E2E_REAL, and the server
 * reads real `.env.local` keys only because SPEC-step7.md §2 says that's
 * fine for local runs — the free-tier spec (tests/app.spec.ts) never
 * exercises a provider node, so no cost is incurred just by the server
 * being *able* to reach OpenRouter/fal.ai/Vbee.
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// `e2e/.tmp` (gitignored): wiped and recreated once per full run, before
// `webServer` starts.
//
// Two things that both look like the "obvious" fix DON'T work here (learned
// the hard way, verified against playwright@1.61.1's actual task order in
// node_modules/playwright/lib/runner/index.js `createGlobalSetupTasks`):
//
// 1. A bare top-level side effect (no guard) re-runs in every worker
//    process — Playwright re-imports this config file per worker
//    (workerProcessEntry.js -> configLoader.deserializeConfig ->
//    loadConfig) — which would wipe the DB/artifacts the already-running
//    server has open, mid-suite.
// 2. Moving the wipe into a `globalSetup` file does NOT fix that, because
//    `createGlobalSetupTasks` runs the `webServer` plugin's setup (which
//    starts the server and lets it open the DB) *before* any
//    `config.globalSetups` entry — so a globalSetup-based wipe still runs
//    after the server has already opened the DB, deleting it out from
//    under the live connection.
//
// The fix that is actually correct for this version: guard the top-level
// side effect so it only runs once, in the main process that loads this
// config before spawning any worker — `TEST_WORKER_INDEX` is unset there
// and is set (by workerProcessEntry.js) in every worker process that later
// re-imports this same file.
if (!process.env.TEST_WORKER_INDEX) {
  const tmpDirForWipe = path.join(here, '.tmp');
  rmSync(tmpDirForWipe, { recursive: true, force: true });
  mkdirSync(tmpDirForWipe, { recursive: true });
}

// `e2e/.tmp` (gitignored): scratch DB + artifacts dir for this e2e run.
// Computing this path (unlike the wipe above) has no side effect, so it's
// safe to do unconditionally — every worker needs it to read `webServer`
// env vars below.
const tmpDir = path.join(here, '.tmp');

const SERVER_PORT = 3777;
const WEB_PORT = 5273;

const isRealTier = Boolean(process.env.E2E_REAL);

export default defineConfig({
  testDir: './tests',
  timeout: isRealTier ? 240_000 : 30_000,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter server exec tsx src/index.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        FLOWFORGE_DB_PATH: path.join(tmpDir, 'e2e.db'),
        FLOWFORGE_ARTIFACTS_DIR: path.join(tmpDir, 'artifacts'),
        // SPEC-step19.md §3: e2e must never touch the real network — forces
        // GET /api/model-catalog / POST /api/catalog/refresh to always use
        // the static presets (`meta.source: 'static'`), no fal.ai/OpenRouter
        // fetch attempted.
        CATALOG_LIVE: '0',
      },
    },
    {
      // `--host 127.0.0.1` (not vite's "localhost" default): on this host
      // vite's "localhost" bind resolves to IPv6-only, and both this
      // config's own health-check request and Playwright's browser
      // (baseURL uses the literal IPv4 127.0.0.1) would otherwise get
      // ECONNREFUSED against the IPv4 loopback.
      command: `pnpm --filter web exec vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        FLOWFORGE_SERVER_PORT: String(SERVER_PORT),
      },
    },
  ],
});
