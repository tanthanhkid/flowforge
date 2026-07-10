import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cacheKey, type CacheStore } from './cache.js';
import { createContext } from './context.js';
import { buildGraph, descendantsOf } from './graph.js';
import type { NodeRegistry } from './registry.js';
import { validateWorkflow, type ValidationIssue, type Workflow } from './schema.js';
import type { NodeRunRecord, RunStore } from './stores.js';
import type { NodeState, PortValue, RunStatus } from './types.js';

export interface EngineOptions {
  artifactsDir?: string;
  concurrency?: number;
  now?: () => number;
}

export interface RunOptions {
  forceNodes?: string[];
  signal?: AbortSignal;
  /**
   * Explicit run id to use instead of generating a fresh one (SPEC-step3.md
   * §3). RunManager.start() needs to know the run id synchronously — before
   * engine.run()'s promise settles — so it can hand `{ runId }` back to the
   * caller and register SSE subscribers against it. Optional and
   * backward-compatible: omitted, behavior is unchanged (randomUUID()).
   */
  runId?: string;
}

export interface NodeResult {
  state: NodeState;
  outputs?: Record<string, PortValue>;
  error?: string;
  cached: boolean;
  durationMs?: number;
}

export interface RunResult {
  runId: string;
  status: 'success' | 'error';
  nodes: Record<string, NodeResult>;
}

/** Thrown by Engine.run() when validateWorkflow() reports issues. */
export class WorkflowValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Workflow validation failed: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

const DEFAULT_ARTIFACTS_DIR = './data/artifacts';

export class Engine extends EventEmitter {
  private readonly registry: NodeRegistry;
  private readonly runStore: RunStore;
  private readonly cacheStore: CacheStore;
  private readonly artifactsDir: string;
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(registry: NodeRegistry, stores: { runs: RunStore; cache: CacheStore }, opts: EngineOptions = {}) {
    super();
    this.registry = registry;
    this.runStore = stores.runs;
    this.cacheStore = stores.cache;
    this.artifactsDir = opts.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;
    this.concurrency = opts.concurrency ?? Infinity;
    this.now = opts.now ?? Date.now;
  }

  async run(workflow: Workflow, options: RunOptions = {}): Promise<RunResult> {
    const validation = validateWorkflow(workflow, this.registry);
    if (!validation.ok) {
      throw new WorkflowValidationError(validation.issues);
    }
    const wf = validation.workflow;

    const runId = options.runId ?? randomUUID();
    const forceNodes = new Set(options.forceNodes ?? []);
    const runSignal = options.signal ?? new AbortController().signal;

    this.runStore.createRun({
      id: runId,
      workflowId: wf.id,
      workflowJson: JSON.stringify(wf),
      status: 'running',
      createdAt: this.now(),
    });

    const graph = buildGraph(wf);
    const nodeById = new Map(wf.nodes.map((n) => [n.id, n]));
    const edgesByTarget = new Map<string, Workflow['edges']>();
    for (const edge of wf.edges) {
      const list = edgesByTarget.get(edge.to.node);
      if (list) list.push(edge);
      else edgesByTarget.set(edge.to.node, [edge]);
    }

    const indegree = new Map(graph.indegree);
    const results: Record<string, NodeResult> = {};
    const outputsByNode = new Map<string, Record<string, PortValue>>();
    const nodeLogs = new Map<string, string[]>();
    const finished = new Set<string>();
    const ready: string[] = wf.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
    const inFlight = new Map<string, Promise<void>>();
    let hasError = false;

    const emitNodeState = (
      nodeId: string,
      state: NodeState,
      extra?: { error?: string; cached?: boolean },
    ): void => {
      this.emit('node:state', { runId, nodeId, state, ...extra });
    };

    const upsertNode = (rec: Omit<NodeRunRecord, 'runId' | 'logs'>): void => {
      this.runStore.upsertNodeRun({ runId, logs: nodeLogs.get(rec.nodeId) ?? [], ...rec });
    };

    // Seed every node as pending.
    for (const node of wf.nodes) {
      upsertNode({ nodeId: node.id, state: 'pending', cacheHit: false });
      emitNodeState(node.id, 'pending');
    }

    const decrementDependents = (nodeId: string): void => {
      for (const dep of graph.dependents.get(nodeId) ?? []) {
        if (finished.has(dep)) continue;
        const deg = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, deg);
        if (deg === 0 && !ready.includes(dep)) {
          ready.push(dep);
        }
      }
    };

    const markSkippedCascade = (fromNodeId: string): void => {
      for (const descId of descendantsOf(wf, fromNodeId)) {
        if (finished.has(descId)) continue;
        finished.add(descId);
        results[descId] = { state: 'skipped', cached: false };
        upsertNode({ nodeId: descId, state: 'skipped', cacheHit: false });
        emitNodeState(descId, 'skipped');
        const idx = ready.indexOf(descId);
        if (idx >= 0) ready.splice(idx, 1);
      }
    };

    const resolveInputs = (nodeId: string): Record<string, PortValue> => {
      const inputs: Record<string, PortValue> = {};
      for (const edge of edgesByTarget.get(nodeId) ?? []) {
        const sourceOutputs = outputsByNode.get(edge.from.node);
        inputs[edge.to.port] = sourceOutputs ? sourceOutputs[edge.from.port] : undefined;
      }
      return inputs;
    };

    const finishNodeError = (nodeId: string, message: string, startedAt: number): void => {
      hasError = true;
      const finishedAt = this.now();
      finished.add(nodeId);
      results[nodeId] = { state: 'error', error: message, cached: false, durationMs: finishedAt - startedAt };
      upsertNode({ nodeId, state: 'error', error: message, cacheHit: false, startedAt, finishedAt });
      emitNodeState(nodeId, 'error', { error: message });
      markSkippedCascade(nodeId);
    };

    const finishNodeSuccess = (
      nodeId: string,
      outputs: Record<string, PortValue>,
      cached: boolean,
      startedAt: number,
    ): void => {
      const finishedAt = this.now();
      outputsByNode.set(nodeId, outputs);
      finished.add(nodeId);
      results[nodeId] = { state: 'success', outputs, cached, durationMs: finishedAt - startedAt };
      upsertNode({
        nodeId,
        state: 'success',
        outputs,
        cacheHit: cached,
        startedAt,
        finishedAt,
      });
      emitNodeState(nodeId, 'success', { cached });
      decrementDependents(nodeId);
    };

    const runNode = async (nodeId: string): Promise<void> => {
      const node = nodeById.get(nodeId);
      const def = node ? this.registry.get(node.type) : undefined;
      if (!node || !def) {
        // Unreachable: workflow was already validated against this registry.
        finishNodeError(nodeId, `Unknown node or node type for "${nodeId}"`, this.now());
        return;
      }

      const inputs = resolveInputs(nodeId);
      const startedAt = this.now();

      let params: unknown;
      try {
        params = def.paramsSchema.parse(node.params);
      } catch (err) {
        finishNodeError(nodeId, err instanceof Error ? err.message : String(err), startedAt);
        return;
      }

      upsertNode({ nodeId, state: 'running', cacheHit: false, startedAt });
      emitNodeState(nodeId, 'running');

      // Everything below (cache-key derivation, cache lookup, node execution,
      // and cache write) can throw synchronously or reject — e.g. a
      // non-JSON-serializable upstream output (BigInt, circular object)
      // breaks cacheKey()/canonicalJson(). All of it must route through
      // finishNodeError so run() always resolves a RunResult (spec §8.10)
      // instead of letting runNode's promise reject.
      try {
        const cacheable = def.cacheable !== false;
        const key = cacheable ? cacheKey(def.type, params, inputs) : undefined;

        if (key && !forceNodes.has(nodeId)) {
          const cached = this.cacheStore.get(key);
          if (cached) {
            finishNodeSuccess(nodeId, cached, true, startedAt);
            return;
          }
        }

        const ctx = createContext({
          runId,
          nodeId,
          artifactsDir: this.artifactsDir,
          signal: runSignal,
          onLog: (message) => {
            const logs = nodeLogs.get(nodeId) ?? [];
            logs.push(message);
            nodeLogs.set(nodeId, logs);
            this.runStore.appendNodeLog(runId, nodeId, message);
            this.emit('node:log', { runId, nodeId, message });
          },
        });

        const outputs = await def.execute({ inputs, params, ctx });
        if (key) this.cacheStore.set(key, def.type, outputs);
        finishNodeSuccess(nodeId, outputs, false, startedAt);
      } catch (err) {
        finishNodeError(nodeId, err instanceof Error ? err.message : String(err), startedAt);
      }
    };

    const launchReady = (): void => {
      while (ready.length > 0 && inFlight.size < this.concurrency) {
        const nodeId = ready.shift();
        if (nodeId === undefined) break;
        const promise = runNode(nodeId).finally(() => {
          inFlight.delete(nodeId);
        });
        inFlight.set(nodeId, promise);
      }
    };

    launchReady();
    while (inFlight.size > 0) {
      await Promise.race(inFlight.values());
      launchReady();
    }

    const status: RunStatus = hasError ? 'error' : 'success';
    this.runStore.finishRun(runId, status, this.now());
    this.emit('run:state', { runId, status });

    return { runId, status, nodes: results };
  }
}
