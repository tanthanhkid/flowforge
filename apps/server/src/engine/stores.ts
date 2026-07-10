import type { NodeState, PortValue, RunStatus } from './types.js';

export interface NodeRunRecord {
  runId: string;
  nodeId: string;
  state: NodeState;
  outputs?: Record<string, PortValue>;
  error?: string;
  logs: string[];
  cacheHit: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowJson: string;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
}

export interface RunStore {
  createRun(run: RunRecord): void;
  finishRun(runId: string, status: RunStatus, finishedAt: number): void;
  upsertNodeRun(rec: NodeRunRecord): void;
  appendNodeLog(runId: string, nodeId: string, message: string): void;
  getRun(runId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly nodeRuns = new Map<string, Map<string, NodeRunRecord>>();

  createRun(run: RunRecord): void {
    this.runs.set(run.id, { ...run });
    if (!this.nodeRuns.has(run.id)) {
      this.nodeRuns.set(run.id, new Map());
    }
  }

  finishRun(runId: string, status: RunStatus, finishedAt: number): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.finishedAt = finishedAt;
  }

  upsertNodeRun(rec: NodeRunRecord): void {
    let nodes = this.nodeRuns.get(rec.runId);
    if (!nodes) {
      nodes = new Map();
      this.nodeRuns.set(rec.runId, nodes);
    }
    nodes.set(rec.nodeId, { ...rec, logs: [...rec.logs] });
  }

  appendNodeLog(runId: string, nodeId: string, message: string): void {
    const rec = this.nodeRuns.get(runId)?.get(nodeId);
    if (rec) {
      rec.logs.push(message);
    }
  }

  getRun(runId: string): { run: RunRecord; nodes: NodeRunRecord[] } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const nodes = Array.from(this.nodeRuns.get(runId)?.values() ?? []).map((n) => ({ ...n, logs: [...n.logs] }));
    return { run: { ...run }, nodes };
  }
}
