#!/usr/bin/env tsx
/**
 * seed-samples (SPEC-step8.md §4): reads every `samples/*.json` file at the
 * repo root, validates each against `validateWorkflow()` +
 * `createDefaultRegistry()`, and upserts the valid ones into the app's
 * SQLite DB via `WorkflowsRepo` so they show up in the WorkflowList without
 * needing the server running.
 *
 * DB path: `FLOWFORGE_DB_PATH` env var if set, else `<repoRoot>/data/flowforge.db`
 * (same default as server.ts). Idempotent: re-running upserts by id, no
 * duplicates. Makes no outbound network calls.
 *
 *   pnpm --filter server seed
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../src/config.js';
import { openDb } from '../src/db/sqlite.js';
import { WorkflowsRepo } from '../src/db/workflows.js';
import { validateWorkflow } from '../src/engine/schema.js';
import { createDefaultRegistry } from '../src/nodes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here) ?? path.join(here, '..', '..', '..');
const samplesDir = path.join(repoRoot, 'samples');

function main(): void {
  const files = readdirSync(samplesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error(`seed-samples: không tìm thấy file .json nào trong ${samplesDir}`);
    process.exit(1);
  }

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

    repo.upsert(result.workflow);
    seeded.push(result.workflow.id);
  }

  db.close();

  console.log(`seed-samples: đã seed ${seeded.length} workflow mẫu vào ${dbPath}:`);
  for (const id of seeded) {
    console.log(`  - ${id}`);
  }
}

main();
