/**
 * Run lifecycle + SSE (SPEC-step3.md §4).
 *
 * The `runs` table already exists in db/sqlite.ts's SCHEMA_SQL and is fully
 * owned/written by the engine's SqliteRunStore; listing history here reads
 * it directly via a raw Database handle rather than growing the RunStore
 * interface (kept minimal per the implementation brief — engine/stores.ts is
 * untouched).
 */
import type { OutgoingHttpHeaders } from 'node:http';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { WorkflowsRepo } from '../db/workflows.js';
import { WorkflowValidationError } from '../engine/executor.js';
import type { Workflow } from '../engine/schema.js';
import type { RunManager } from '../runManager.js';

export interface RunsRouteDeps {
  runManager: RunManager;
  workflowsRepo: WorkflowsRepo;
  db: Database.Database;
}

interface CreateRunBody {
  workflowId?: string;
  workflow?: Workflow;
  forceNodes?: string[];
}

interface RunListRow {
  id: string;
  workflow_id: string | null;
  status: string;
  created_at: number | null;
  finished_at: number | null;
}

const HEARTBEAT_MS = 15_000;

export function registerRunsRoutes(app: FastifyInstance, deps: RunsRouteDeps): void {
  const { runManager, workflowsRepo, db } = deps;

  app.post('/api/runs', async (request, reply) => {
    const body = (request.body ?? {}) as CreateRunBody;
    const hasWorkflowId = typeof body.workflowId === 'string' && body.workflowId.length > 0;
    const hasWorkflow = body.workflow !== undefined && body.workflow !== null;

    if (hasWorkflowId === hasWorkflow) {
      reply.code(400).send({ error: 'Provide exactly one of workflowId or workflow' });
      return;
    }

    let workflow: Workflow;
    if (hasWorkflowId) {
      const found = workflowsRepo.get(body.workflowId as string);
      if (!found) {
        reply.code(404).send({ error: `Workflow "${body.workflowId}" not found` });
        return;
      }
      workflow = found;
    } else {
      workflow = body.workflow as Workflow;
    }

    try {
      const { runId } = runManager.start(workflow, { forceNodes: body.forceNodes });
      reply.code(202).send({ runId });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        reply.code(400).send({ error: err.message, issues: err.issues });
        return;
      }
      throw err;
    }
  });

  app.get('/api/runs', async (request) => {
    const query = request.query as { workflowId?: string; limit?: string };
    const parsedLimit = query.limit !== undefined ? Number(query.limit) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50;

    const rows = (
      query.workflowId
        ? db
            .prepare(
              `SELECT id, workflow_id, status, created_at, finished_at FROM runs
               WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(query.workflowId, limit)
        : db
            .prepare(
              `SELECT id, workflow_id, status, created_at, finished_at FROM runs
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
    ) as RunListRow[];

    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id ?? '',
      status: row.status,
      createdAt: row.created_at ?? 0,
      finishedAt: row.finished_at ?? undefined,
    }));
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = runManager.getRun(id);
    if (!found) {
      reply.code(404).send({ error: `Run "${id}" not found` });
      return;
    }
    reply.send(found);
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const snapshot = runManager.getRun(id);
    if (!snapshot) {
      reply.code(404).send({ error: `Run "${id}" not found` });
      return;
    }

    // reply.hijack() bypasses Fastify's normal reply serialization, which is
    // the only thing that ever flushes headers set by onRequest hooks (e.g.
    // @fastify/cors's Access-Control-Allow-Origin via reply.header()) onto
    // the wire. Merge whatever the hook already accumulated on the reply
    // into the raw writeHead() call so cross-origin EventSource requests
    // (the step-4 frontend, per spec §2's cors origin:true) still see CORS
    // headers on this endpoint.
    // reply.getHeaders() is typed against Fastify's broader HttpHeader key
    // set (values may be `number`, e.g. content-length) whereas Node's
    // OutgoingHttpHeaders types most headers as string-only — the values
    // Fastify/cors actually put there (Access-Control-Allow-Origin etc.) are
    // always strings, so the cast is safe.
    const sseHeaders = {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    } as unknown as OutgoingHttpHeaders;
    reply.raw.writeHead(200, sseHeaders);
    // Take full manual control of the raw response: we're going to keep it
    // open and write to it from event listeners well after this async
    // handler returns, which Fastify's normal reply-lifecycle doesn't
    // support.
    reply.hijack();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', snapshot);

    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let finished = false;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      request.raw.off('close', finish);
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    // A run persisted as 'running' is only trustworthy while RunManager
    // still considers it active in this process. Engine.run() writes
    // status='running' at the very start and only reaches a terminal status
    // once it completes in-process — a restart (e.g. `tsx watch` reloading
    // on every save in dev) orphans the row at 'running' forever with no
    // in-process emitter left to ever produce a run:state for it.
    // isActive() is the source of truth for "will this run ever emit again".
    if (snapshot.run.status !== 'running' || !runManager.isActive(id)) {
      send('done', {});
      finish();
      return;
    }

    heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    unsubscribe = runManager.subscribe(id, (event) => {
      send(event.type, event.data);
      if (event.type === 'run:state') {
        send('done', {});
        finish();
      }
    });

    request.raw.on('close', finish);
  });
}
