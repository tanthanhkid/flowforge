/**
 * buildServer (SPEC-step3.md §2): assembles one Fastify app wired to one
 * Engine instance, DI-able for tests (in-memory/tmp-dir opts).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { findRepoRoot } from './config.js';
import { openDb, SqliteCacheStore, SqliteRunStore } from './db/sqlite.js';
import { WorkflowsRepo } from './db/workflows.js';
import { Engine, WorkflowValidationError } from './engine/executor.js';
import type { NodeRegistry } from './engine/registry.js';
import { createDefaultRegistry } from './nodes/index.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerArtifactsRoutes } from './routes/artifacts.js';
import { registerEstimateRoutes } from './routes/estimate.js';
import { registerModelCatalogRoutes } from './routes/modelCatalog.js';
import { registerRegistryRoutes } from './routes/registry.js';
import { registerRunsRoutes } from './routes/runs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { MAX_UPLOAD_BYTES, registerUploadRoutes } from './routes/upload.js';
import { registerWorkflowsRoutes } from './routes/workflows.js';
import { RunManager } from './runManager.js';

export interface ServerOpts {
  registry?: NodeRegistry;
  /** DB file path, or ':memory:' for tests. Default: <repoRoot>/data/flowforge.db */
  dbPath?: string;
  /** Default: <repoRoot>/data/artifacts */
  artifactsDir?: string;
  /** Default: false */
  logger?: boolean;
  /** Env file read/written by /api/settings. Default: <repoRoot>/.env.local */
  envFilePath?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    runManager: RunManager;
  }
}

function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return findRepoRoot(here) ?? process.cwd();
}

export async function buildServer(opts: ServerOpts = {}): Promise<FastifyInstance> {
  const registry = opts.registry ?? createDefaultRegistry();
  const repoRoot = defaultRepoRoot();
  const dbPath = opts.dbPath ?? path.join(repoRoot, 'data', 'flowforge.db');
  const artifactsDir = opts.artifactsDir ?? path.join(repoRoot, 'data', 'artifacts');
  const envFilePath = opts.envFilePath ?? path.join(repoRoot, '.env.local');

  if (dbPath !== ':memory:') {
    await mkdir(path.dirname(dbPath), { recursive: true });
  }

  const db = openDb(dbPath);
  const runStore = new SqliteRunStore(db);
  const cacheStore = new SqliteCacheStore(db);
  const engine = new Engine(registry, { runs: runStore, cache: cacheStore }, { artifactsDir });
  const runManager = new RunManager(engine, runStore, registry);
  const workflowsRepo = new WorkflowsRepo(db);

  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.decorate('runManager', runManager);

  app.setErrorHandler((err: FastifyError | WorkflowValidationError, request, reply) => {
    if (err instanceof WorkflowValidationError) {
      reply.code(400).send({ error: err.message, issues: err.issues });
      return;
    }
    // Fastify body-parser / route-validation failures already carry a 4xx
    // statusCode (e.g. malformed JSON) — surface those as 400 without the
    // stack trace; anything else is an unexpected 500.
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: err.message });
      return;
    }
    request.log.error(err);
    reply.code(500).send({ error: err.message || 'Internal Server Error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  registerRegistryRoutes(app, registry);
  registerModelCatalogRoutes(app, { db });
  registerWorkflowsRoutes(app, { workflowsRepo, registry });
  registerRunsRoutes(app, { runManager, workflowsRepo, db });
  registerArtifactsRoutes(app, artifactsDir);
  registerUploadRoutes(app, artifactsDir);
  registerAgentRoutes(app, { registry });
  registerSettingsRoutes(app, { envFilePath });
  registerEstimateRoutes(app);

  app.addHook('onClose', async () => {
    db.close();
  });

  return app;
}
