/**
 * store/flow.ts — SPEC-step31.md F1 (`adoptWorkflow` only bumps
 * `fitViewNonce` on an id change) + F7 (`autoLayout` batches its moved
 * positions through `manualLog.ts` like a manual drag, instead of always
 * falling back to `dirty: true`). Kept in its own file (rather than
 * extending test/store.test.ts or test/flow-manual-log.test.ts) so this
 * step's parallel agents never touch the same test file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return { ...actual, getRegistry: vi.fn() };
});

vi.mock('../src/store/manualLog.ts', () => ({
  hasActiveConversation: vi.fn(),
  enqueueManualOps: vi.fn(),
  scheduleNodeParamsChange: vi.fn(),
  scheduleNodeLabelChange: vi.fn(),
  scheduleMove: vi.fn(),
  cancelPendingNodeUpdate: vi.fn(),
  cancelPendingMove: vi.fn(),
  flushManualLog: vi.fn().mockResolvedValue(undefined),
}));

// Imported after vi.mock (hoisted above these imports by Vitest).
import { layoutWorkflow } from '../src/canvas/layout.ts';
import * as manualLog from '../src/store/manualLog.ts';
import { useFlowStore } from '../src/store/flow.ts';

function baseWorkflow(id: string): Workflow {
  return { version: 1, id, name: 'Test', nodes: [], edges: [] };
}

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    registry: [],
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
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
  vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
  resetStore(baseWorkflow('wf1'));
});

describe('adoptWorkflow fitViewNonce (SPEC-step31.md F1)', () => {
  it('bumps fitViewNonce when the incoming workflow has a DIFFERENT id (conversation switch / first load)', () => {
    const before = useFlowStore.getState().fitViewNonce;

    useFlowStore.getState().adoptWorkflow(baseWorkflow('wf2'));

    expect(useFlowStore.getState().fitViewNonce).toBe(before + 1);
  });

  it('does NOT bump fitViewNonce when the incoming workflow has the SAME id (reconcile — revert / changes response)', () => {
    const before = useFlowStore.getState().fitViewNonce;
    const reconciled: Workflow = {
      ...baseWorkflow('wf1'),
      nodes: [{ id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } }],
    };

    useFlowStore.getState().adoptWorkflow(reconciled);

    expect(useFlowStore.getState().fitViewNonce).toBe(before);
    // The reconcile still has to actually replace the workflow.
    expect(useFlowStore.getState().workflow).toEqual(reconciled);
  });

  it('a second different-id adoption bumps again (every switch re-fits)', () => {
    useFlowStore.getState().adoptWorkflow(baseWorkflow('wf2'));
    const afterFirst = useFlowStore.getState().fitViewNonce;

    useFlowStore.getState().adoptWorkflow(baseWorkflow('wf3'));

    expect(useFlowStore.getState().fitViewNonce).toBe(afterFirst + 1);
  });
});

describe('autoLayout (SPEC-step31.md F7)', () => {
  const scattered: Workflow = {
    version: 1,
    id: 'wf1',
    name: 'Test',
    nodes: [
      { id: 'n1', type: 'input.text', params: {}, position: { x: 999, y: 999 } },
      { id: 'n2', type: 'input.text', params: {}, position: { x: 999, y: 999 } },
    ],
    edges: [],
  };

  it('default call (Toolbar\'s "🪄 Sắp xếp", no opts) with an active conversation: one manualLog entry batching every moved node, no dirty', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    resetStore(scattered);

    useFlowStore.getState().autoLayout();

    const expected = layoutWorkflow(scattered, {});
    expect(useFlowStore.getState().workflow.nodes).toEqual(expected.nodes);
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(manualLog.enqueueManualOps).toHaveBeenCalledTimes(1);

    const [workflowId, ops, summary] = vi.mocked(manualLog.enqueueManualOps).mock.calls[0]!;
    expect(workflowId).toBe('wf1');
    expect(summary).toBe('sắp xếp lại bố cục (2 node)');
    expect(ops).toHaveLength(2);
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: 'move-node', nodeId: 'n1', position: expected.nodes.find((n) => n.id === 'n1')!.position },
        { op: 'move-node', nodeId: 'n2', position: expected.nodes.find((n) => n.id === 'n2')!.position },
      ]),
    );
  });

  it('{ log: false } (store/chat.ts post-turn re-layout): never logs, falls back to dirty=true even with an active conversation', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    resetStore(scattered);

    useFlowStore.getState().autoLayout({ log: false });

    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('no active conversation: dirty=true fallback, never logs, even with { log: true }', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
    resetStore(scattered);

    useFlowStore.getState().autoLayout({ log: true });

    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('nothing actually moved (already laid out): no manualLog call (0 ops), still no dirty', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const alreadyLaidOut = layoutWorkflow(scattered, {});
    resetStore(alreadyLaidOut);

    useFlowStore.getState().autoLayout();

    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
    expect(useFlowStore.getState().dirty).toBe(false);
  });

  it('post-review fix — cancels each moved node\'s still-pending drag debounce BEFORE enqueueing its own batch, so a stale scheduleMove() cannot re-fire the pre-layout position afterwards', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    resetStore(scattered);
    const callOrder: string[] = [];
    vi.mocked(manualLog.cancelPendingMove).mockImplementation((id: string) => {
      callOrder.push(`cancel:${id}`);
    });
    vi.mocked(manualLog.enqueueManualOps).mockImplementation(() => {
      callOrder.push('enqueue');
    });

    useFlowStore.getState().autoLayout();

    expect(manualLog.cancelPendingMove).toHaveBeenCalledTimes(2);
    expect(manualLog.cancelPendingMove).toHaveBeenCalledWith('n1');
    expect(manualLog.cancelPendingMove).toHaveBeenCalledWith('n2');
    // Both cancels must happen before this batch's own entry is enqueued —
    // otherwise a stale timer racing the synchronous click handler could
    // still enqueue its own (stale) position ahead of this fix taking effect.
    expect(callOrder).toEqual(['cancel:n1', 'cancel:n2', 'enqueue']);
  });

  it('nothing moved: does NOT call cancelPendingMove at all (no batch to protect)', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const alreadyLaidOut = layoutWorkflow(scattered, {});
    resetStore(alreadyLaidOut);

    useFlowStore.getState().autoLayout();

    expect(manualLog.cancelPendingMove).not.toHaveBeenCalled();
  });
});
