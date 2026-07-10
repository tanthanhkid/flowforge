/**
 * RunManager (SPEC-step3.md §3): starts Engine.run() in the background (never
 * awaited by the caller) and fans out its three events ('node:state',
 * 'node:log', 'run:state') to per-run subscriber sets, for routes/runs.ts's
 * SSE endpoint to consume.
 *
 * start() must validate the workflow *synchronously* so an invalid workflow
 * throws immediately (route turns that into a 400 with issues) rather than
 * surfacing only once engine.run()'s promise rejects — an async function's
 * internal throws never escape synchronously to the caller, even for code
 * before its first `await`. That requires calling validateWorkflow()
 * ourselves before handing the (now-known-valid) workflow to engine.run(),
 * hence the registry dependency alongside Engine/RunStore.
 */
import { randomUUID } from 'node:crypto';
import type { Engine } from './engine/executor.js';
import { WorkflowValidationError } from './engine/executor.js';
import type { NodeRegistry } from './engine/registry.js';
import { validateWorkflow, type Workflow } from './engine/schema.js';
import type { NodeRunRecord, RunRecord, RunStore } from './engine/stores.js';
import type { NodeState, RunStatus } from './engine/types.js';

export interface RunEvent {
  type: 'node:state' | 'node:log' | 'run:state';
  data: unknown;
}

export type RunEventListener = (event: RunEvent) => void;

interface EngineNodeStateEvent {
  runId: string;
  nodeId: string;
  state: NodeState;
  error?: string;
  cached?: boolean;
}

interface EngineNodeLogEvent {
  runId: string;
  nodeId: string;
  message: string;
}

interface EngineRunStateEvent {
  runId: string;
  status: RunStatus;
}

export class RunManager {
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly runStore: RunStore,
    private readonly registry: NodeRegistry,
  ) {
    this.engine.on('node:state', (event: EngineNodeStateEvent) => {
      this.dispatch(event.runId, { type: 'node:state', data: event });
    });
    this.engine.on('node:log', (event: EngineNodeLogEvent) => {
      this.dispatch(event.runId, { type: 'node:log', data: event });
    });
    this.engine.on('run:state', (event: EngineRunStateEvent) => {
      this.dispatch(event.runId, { type: 'run:state', data: event });
      this.activeRuns.delete(event.runId);
      // Spec §3: once run:state has been broadcast, drop the (now-useless)
      // subscriber set for this runId.
      this.listeners.delete(event.runId);
    });
  }

  /** Validates, then kicks off engine.run() in the background (not awaited). Throws WorkflowValidationError synchronously on invalid workflows. */
  start(workflow: Workflow, options?: { forceNodes?: string[] }): { runId: string } {
    const validation = validateWorkflow(workflow, this.registry);
    if (!validation.ok) {
      throw new WorkflowValidationError(validation.issues);
    }

    const runId = randomUUID();
    this.activeRuns.add(runId);

    this.engine.run(validation.workflow, { runId, forceNodes: options?.forceNodes }).catch((err: unknown) => {
      // engine.run() is designed to always resolve a RunResult (node-level
      // failures route through finishNodeError, not a rejection) — this
      // catch is a last-resort safety net for a truly unexpected failure
      // (e.g. the run store itself throwing) so it never becomes an
      // unhandled promise rejection. Subscribers simply won't see a
      // run:state for this runId in that case.
      this.activeRuns.delete(runId);
      // eslint-disable-next-line no-console
      console.error(`[RunManager] run ${runId} failed unexpectedly:`, err);
    });

    return { runId };
  }

  /** Subscribes to events for a runId; returns an unsubscribe function. */
  subscribe(runId: string, listener: RunEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  isActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  /** Convenience passthrough used by routes/runs.ts (not part of the spec's minimal sketch, but avoids leaking the RunStore itself). */
  getRun(runId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined {
    return this.runStore.getRun(runId);
  }

  private dispatch(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) listener(event);
  }
}
