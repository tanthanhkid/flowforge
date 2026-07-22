/**
 * store/flow.ts — SPEC-step33.md §33e-1: the `awaitingGate` state + the
 * `resumeAwaiting`/`cancelAwaiting` actions that drive `CutPlanReview.tsx`.
 * Kept in its own file (mirrors flow-store.step31.test.ts) rather than
 * extending test/store.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventHandlers } from '../src/api/client.ts';
import type { CutPlan, RunSnapshot, Workflow } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    createRun: vi.fn(),
    getRun: vi.fn(),
    openRunEvents: vi.fn(),
    resumeRun: vi.fn(),
    stopRun: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import { useFlowStore } from '../src/store/flow.ts';

function baseWorkflow(id: string): Workflow {
  return { version: 1, id, name: 'Test', nodes: [], edges: [] };
}

const samplePlan: CutPlan = {
  moments: [{ id: 'm1', start: 0, end: 5, title: 'Đoạn 1' }],
};

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    registry: [],
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    awaitingGate: null,
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
    rightTab: 'params',
    scrollToNodeId: null,
    nodeSizes: {},
    fitViewNonce: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore(baseWorkflow('wf1'));
});

describe('run() → onNodeState "awaiting"', () => {
  it('sets awaitingGate from the event payload pendingApproval.plan', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });

    await useFlowStore.getState().run();

    handlers.onNodeState?.({ runId: 'run1', nodeId: 'gate1', state: 'awaiting', pendingApproval: { plan: samplePlan } });

    expect(useFlowStore.getState().awaitingGate).toEqual({ runId: 'run1', nodeId: 'gate1', plan: samplePlan });
    // No fallback fetch needed — the event already carried the plan.
    expect(api.getRun).not.toHaveBeenCalled();
  });

  it('falls back to getRun when the event has no pendingApproval', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });
    const snapshot: RunSnapshot = {
      run: { id: 'run1', workflowId: 'wf1', workflowJson: '{}', status: 'running', createdAt: 0 },
      nodes: [
        {
          runId: 'run1',
          nodeId: 'gate1',
          state: 'awaiting',
          logs: [],
          cacheHit: false,
          outputs: { pendingApproval: { plan: samplePlan } },
        },
      ],
    };
    vi.mocked(api.getRun).mockResolvedValue(snapshot);

    await useFlowStore.getState().run();
    handlers.onNodeState?.({ runId: 'run1', nodeId: 'gate1', state: 'awaiting' });

    await vi.waitFor(() => {
      expect(useFlowStore.getState().awaitingGate).toEqual({ runId: 'run1', nodeId: 'gate1', plan: samplePlan });
    });
  });

  it('clears awaitingGate on a terminal run:state', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });

    await useFlowStore.getState().run();
    handlers.onNodeState?.({ runId: 'run1', nodeId: 'gate1', state: 'awaiting', pendingApproval: { plan: samplePlan } });
    expect(useFlowStore.getState().awaitingGate).not.toBeNull();

    handlers.onRunState?.({ runId: 'run1', status: 'success' });
    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });
});

describe('resumeAwaiting', () => {
  it('calls api.resumeRun with the edited plan and clears the gate', async () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    vi.mocked(api.resumeRun).mockResolvedValue({ resumed: true });

    const edited: CutPlan = { moments: [{ id: 'm1', start: 1, end: 4, title: 'Sửa rồi' }] };
    await useFlowStore.getState().resumeAwaiting(edited);

    expect(api.resumeRun).toHaveBeenCalledWith('run1', 'gate1', edited);
    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });

  it('propagates an error and leaves the gate untouched', async () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    vi.mocked(api.resumeRun).mockRejectedValue(new api.ApiError(400, 'output không hợp lệ'));

    await expect(useFlowStore.getState().resumeAwaiting(samplePlan)).rejects.toThrow('output không hợp lệ');
    expect(useFlowStore.getState().awaitingGate).not.toBeNull();
  });

  it('is a no-op when there is no pending gate', async () => {
    await useFlowStore.getState().resumeAwaiting(samplePlan);
    expect(api.resumeRun).not.toHaveBeenCalled();
  });
});

describe('cancelAwaiting', () => {
  it('calls api.stopRun and clears the gate', async () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    vi.mocked(api.stopRun).mockResolvedValue({ stopped: true });

    await useFlowStore.getState().cancelAwaiting();

    expect(api.stopRun).toHaveBeenCalledWith('run1');
    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });

  it('clears the gate even if stopRun rejects (already-inactive run)', async () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    vi.mocked(api.stopRun).mockRejectedValue(new api.ApiError(409, 'not active'));

    await useFlowStore.getState().cancelAwaiting();

    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });
});

// Post-review fix (HIGH) — a gate left over from workflow/conversation A
// must not keep `CutPlanReview`'s full-canvas overlay stuck up after
// switching away to workflow/conversation B.
describe('stale awaitingGate is dropped on workflow switch / historical-run view', () => {
  it('newWorkflow() clears awaitingGate', () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    useFlowStore.getState().newWorkflow();
    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });

  it('adoptWorkflow() clears awaitingGate', () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    useFlowStore.getState().adoptWorkflow(baseWorkflow('wf2'));
    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });

  it('openRun() clears awaitingGate (viewing a historical run)', async () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: samplePlan } });
    const snapshot: RunSnapshot = {
      run: { id: 'run2', workflowId: 'wf1', workflowJson: '{}', status: 'success', createdAt: 0, finishedAt: 1 },
      nodes: [],
    };
    vi.mocked(api.getRun).mockResolvedValue(snapshot);

    await useFlowStore.getState().openRun('run2');

    expect(useFlowStore.getState().awaitingGate).toBeNull();
  });
});

// Post-review fix (MEDIUM) — SPEC-step33.md §33e: surviving an
// EventSource reconnect mid-gate. A reconnect replays `snapshot`, not the
// original `node:state`, so `onSnapshot` must itself be able to (re)open
// `awaitingGate` for an already-awaiting node.
describe('run() → onSnapshot reconnect mid-gate', () => {
  it('sets awaitingGate from a snapshot node already in the "awaiting" state', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });

    await useFlowStore.getState().run();
    expect(useFlowStore.getState().awaitingGate).toBeNull();

    handlers.onSnapshot?.({
      run: { id: 'run1', workflowId: 'wf1', workflowJson: '{}', status: 'running', createdAt: 0 },
      nodes: [
        {
          runId: 'run1',
          nodeId: 'gate1',
          state: 'awaiting',
          logs: [],
          cacheHit: false,
          outputs: { pendingApproval: { plan: samplePlan } },
        },
      ],
    });

    expect(useFlowStore.getState().awaitingGate).toEqual({ runId: 'run1', nodeId: 'gate1', plan: samplePlan });
  });

  it('does not clobber an already-tracked gate for the same run (e.g. a user mid-edit)', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });

    await useFlowStore.getState().run();
    const trackedPlan: CutPlan = { moments: [{ id: 'm1', start: 0, end: 1, title: 'Đã sửa' }] };
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan: trackedPlan } });

    handlers.onSnapshot?.({
      run: { id: 'run1', workflowId: 'wf1', workflowJson: '{}', status: 'running', createdAt: 0 },
      nodes: [
        {
          runId: 'run1',
          nodeId: 'gate1',
          state: 'awaiting',
          logs: [],
          cacheHit: false,
          outputs: { pendingApproval: { plan: samplePlan } },
        },
      ],
    });

    expect(useFlowStore.getState().awaitingGate).toEqual({ runId: 'run1', nodeId: 'gate1', plan: trackedPlan });
  });
});
