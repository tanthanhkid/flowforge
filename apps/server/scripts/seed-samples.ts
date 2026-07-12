#!/usr/bin/env tsx
/**
 * seed-samples (SPEC-step8.md §4, extended by SPEC-step11.md §3): reads
 * every `samples/*.json` file at the repo root, validates each against
 * `validateWorkflow()` + `createDefaultRegistry()`, and upserts the valid
 * ones into the app's SQLite DB via `WorkflowsRepo` so they show up in the
 * WorkflowList without needing the server running.
 *
 * Before validating, copies every file in `samples/assets/*` to
 * `<artifactsDir>/uploads/sample-<filename>` (overwrite ok — idempotent), so
 * the new input.image/input.pdf/input.markdown samples that reference
 * `uploads/sample-<filename>` can run without any manual upload step. Then,
 * for every sample node param that looks like an `uploads/...` path, checks
 * the file actually exists on disk after the copy — missing → exit 1.
 *
 * DB path: `FLOWFORGE_DB_PATH` env var if set, else `<repoRoot>/data/flowforge.db`
 * (same default as server.ts). Artifacts dir: `FLOWFORGE_ARTIFACTS_DIR` env
 * var if set, else `<repoRoot>/data/artifacts` (same default as server.ts).
 * Idempotent: re-running upserts by id / overwrites copied assets, no
 * duplicates. Makes no outbound network calls.
 *
 *   pnpm --filter server seed
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../src/config.js';
import { backfillConversations } from '../src/db/backfill.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import { validateWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const samplesDir = path.join(repoRoot, 'samples');
const assetsDir = path.join(samplesDir, 'assets');
const artifactsDir = process.env.FLOWFORGE_ARTIFACTS_DIR ?? path.join(repoRoot, 'data', 'artifacts');
const uploadsDir = path.join(artifactsDir, 'uploads');

// Copies every file in samples/assets/* to <artifactsDir>/uploads/sample-<filename>
// so samples referencing `uploads/sample-<filename>` can run without a manual
// upload step. Idempotent — overwrites on every run.
function copySampleAssets(): void {
  if (!existsSync(assetsDir)) return;
  mkdirSync(uploadsDir, { recursive: true });
  const assetFiles = readdirSync(assetsDir).filter((f) => statSync(path.join(assetsDir, f)).isFile());
  for (const file of assetFiles) {
    copyFileSync(path.join(assetsDir, file), path.join(uploadsDir, `sample-${file}`));
  }
}

// Recursively collects every string value found under a node's `params`
// that looks like an `uploads/...` relative path (as used by
// input.image/input.pdf/input.markdown's `path` param).
function collectUploadPaths(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('uploads/')) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUploadPaths(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUploadPaths(item, out);
  }
}

function main(): void {
  const files = readdirSync(samplesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`seed-samples: không tìm thấy file .json nào trong ${samplesDir}`);
    process.exit(1);
  }

  copySampleAssets();

  const registry = createDefaultRegistry();
  const dbPath = process.env.FLOWFORGE_DB_PATH ?? path.join(repoRoot, 'data', 'flowforge.db');
  const db = openDb(dbPath);
  const repo = new WorkflowsRepo(db);

  const seeded: string[] = [];

  for (const file of files) {
    const fullPath = path.join(samplesDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (err) {
      console.error(`seed-samples: lỗi parse JSON "${file}": ${(err as Error).message}`);
      process.exit(1);
    }

    const result = validateWorkflow(raw, registry);
    if (!result.ok) {
      console.error(`seed-samples: "${file}" không hợp lệ:`);
      for (const issue of result.issues) {
        console.error(`  - [${issue.code}] ${issue.message}`);
      }
      process.exit(1);
    }

    const uploadPaths: string[] = [];
    for (const node of result.workflow.nodes) {
      collectUploadPaths(node.params, uploadPaths);
    }
    for (const uploadPath of uploadPaths) {
      const resolved = path.join(artifactsDir, uploadPath);
      if (!existsSync(resolved)) {
        console.error(
          `seed-samples: "${file}" tham chiếu "${uploadPath}" nhưng không tìm thấy file tại "${resolved}" sau khi copy assets — kiểm tra lại samples/assets/.`,
        );
        process.exit(1);
      }
    }

    repo.upsert(result.workflow);
    seeded.push(result.workflow.id);
  }

  // SPEC-step20.md §4: give every seeded sample a conversation right away
  // (don't rely on the server-startup migration for the first seed run).
  const backfilledCount = backfillConversations(db);

  db.close();

  console.log(`seed-samples: đã seed ${seeded.length} workflow mẫu vào ${dbPath}:`);
  for (const id of seeded) {
    console.log(`  - ${id}`);
  }
  if (backfilledCount > 0) {
    console.log(`seed-samples: đã tạo ${backfilledCount} conversation cho workflow mẫu`);
  }
}

main();
