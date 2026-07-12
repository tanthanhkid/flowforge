/**
 * store/manualLog.ts (SPEC-step27.md §2): debounce coalescing (params/label,
 * move), the serialized promise-chain queue (ordering + version chain), the
 * one-shot 409 rebase (success and give-up-after-2nd-conflict), the
 * network/5xx fallback (`dirty` + toast), and the mandatory flush point.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowChangeSummary } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return { ...actual, postManualChange: vi.fn() };
});

vi.mock('../src/ui/Toast.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/Toast.tsx')>();
  return { ...actual, toast: vi.fn() };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import { ApiError } from '../src/api/client.ts';
import {
  cancelPendingMove,
  cancelPendingNodeUpdate,
  enqueueManualOps,
  flushManualLog,
  hasActiveConversation,
  scheduleMove,
  scheduleNodeLabelChange,
  scheduleNodeParamsChange,
} from '../src/store/manualLog.ts';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';
import { toast } from '../src/ui/Toast.tsx';

const baseWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] };

function resetStores(): void {
  useFlowStore.setState({
    workflow: baseWorkflow,
    selectedNodeId: null,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
  });
  useChatStore.setState({
    activeConversationId: 'c1',
    workflowVersion: 0,
    turnState: 'idle',
  });
}

beforeEach(() => {
  // `resetAllMocks` (not just `clearAllMocks`) — a previous test's
  // `mockResolvedValue`/`mockRejectedValue` (persistent, not `-Once`) default
  // implementation must not leak into the next test.
  vi.resetAllMocks();
  vi.useRealTimers();
  resetStores();
});

describe('hasActiveConversation', () => {
  it('reflects useChatStore.activeConversationId', () => {
    useChatStore.setState({ activeConversationId: null });
    expect(hasActiveConversation()).toBe(false);
    useChatStore.setState({ activeConversationId: 'c1' });
    expect(hasActiveConversation()).toBe(true);
  });
});

describe('scheduleNodeParamsChange — 800ms debounce', () => {
  it('two keystrokes within the window coalesce into one POST holding only the final value', async () => {
    vi.mocked(api.postManualChange).mockResolvedValue({
      change: {} as never,
      workflow: baseWorkflow,
      version: 1,
    });
    vi.useFakeTimers();
    try {
      // Mirrors store/flow.ts's own call pattern: the 2nd call's "prev" is
      // already contaminated by the 1st call's local update (the store
      // already reflects it) — the ORIGINAL baseline from the 1st call must
      // still win, not this 2nd call's `prevParams` argument.
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      scheduleNodeParamsChange('n1', { a: 'y' }, { a: 'z' });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith('wf1', {
      ops: [{ op: 'update-node', nodeId: 'n1', params: { a: 'z' } }],
      summary: 'node n1: a = "z"',
      expectedVersion: 0,
    });
  });

  it('only the keys that actually changed vs the baseline are sent (not every key in the latest params object)', async () => {
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: baseWorkflow, version: 1 });
    vi.useFakeTimers();
    try {
      scheduleNodeParamsChange('n1', { a: 'x', b: 1 }, { a: 'x', b: 2 });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ ops: [{ op: 'update-node', nodeId: 'n1', params: { b: 2 } }] }),
    );
  });

  it('a net no-op (typed then undone back to the original value) logs nothing', async () => {
    vi.useFakeTimers();
    try {
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      scheduleNodeParamsChange('n1', { a: 'y' }, { a: 'x' });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }
    expect(api.postManualChange).not.toHaveBeenCalled();
  });

  it('scheduleNodeLabelChange shares the same debounce bucket/op as params', async () => {
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: baseWorkflow, version: 1 });
    vi.useFakeTimers();
    try {
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      scheduleNodeLabelChange('n1', undefined, 'Nice name');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    expect(body.ops).toEqual([{ op: 'update-node', nodeId: 'n1', params: { a: 'y' }, label: 'Nice name' }]);
    expect(body.summary).toContain('a = "y"');
    expect(body.summary).toContain('label = "Nice name"');
  });
});

describe('scheduleMove — 500ms debounce', () => {
  it('several drag pointermoves coalesce into one move-node op holding only the final position', async () => {
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: baseWorkflow, version: 1 });
    vi.useFakeTimers();
    try {
      scheduleMove('n1', { x: 1, y: 1 });
      scheduleMove('n1', { x: 5, y: 5 });
      scheduleMove('n1', { x: 42, y: 7 });
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith('wf1', {
      ops: [{ op: 'move-node', nodeId: 'n1', position: { x: 42, y: 7 } }],
      summary: 'di chuyển node n1',
      expectedVersion: 0,
    });
  });
});

describe('queue ordering + version chain', () => {
  it('serializes entries — the 2nd POST only fires after the 1st resolves', async () => {
    let resolveFirst!: (value: { change: WorkflowChangeSummary; workflow: Workflow; version: number }) => void;
    vi.mocked(api.postManualChange).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.mocked(api.postManualChange).mockResolvedValueOnce({ change: {} as never, workflow: baseWorkflow, version: 2 });

    enqueueManualOps('wf1', [{ op: 'add-node', node: { id: 'n1', type: 'input.text', params: {} } }], 'thêm node input.text (n1)');
    enqueueManualOps('wf1', [{ op: 'add-node', node: { id: 'n2', type: 'input.text', params: {} } }], 'thêm node input.text (n2)');

    await Promise.resolve();
    await Promise.resolve();
    expect(api.postManualChange).toHaveBeenCalledTimes(1);

    resolveFirst({ change: {} as never, workflow: baseWorkflow, version: 1 });
    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(2));
  });

  it('entry 2 sends the expectedVersion that entry 1 actually returned, not whatever was current when entry 2 was enqueued', async () => {
    vi.mocked(api.postManualChange).mockResolvedValueOnce({ change: {} as never, workflow: baseWorkflow, version: 5 });
    vi.mocked(api.postManualChange).mockResolvedValueOnce({ change: {} as never, workflow: baseWorkflow, version: 6 });

    enqueueManualOps('wf1', [{ op: 'remove-node', nodeId: 'n1' }], 'xoá node n1');
    enqueueManualOps('wf1', [{ op: 'remove-node', nodeId: 'n2' }], 'xoá node n2');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(2));

    expect(api.postManualChange).toHaveBeenNthCalledWith(1, 'wf1', expect.objectContaining({ expectedVersion: 0 }));
    expect(api.postManualChange).toHaveBeenNthCalledWith(2, 'wf1', expect.objectContaining({ expectedVersion: 5 }));
    expect(useChatStore.getState().workflowVersion).toBe(6);
  });
});

describe('409 version-conflict', () => {
  const conflictWorkflow: Workflow = {
    version: 1,
    id: 'wf1',
    name: 'Server latest',
    nodes: [{ id: 'n1', type: 'input.text', params: { value: 'server' } }],
    edges: [],
  };

  it('rebases once: adopts the server workflow, replays the op locally, re-POSTs, and toasts a light sync notice', async () => {
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );
    vi.mocked(api.postManualChange).mockResolvedValueOnce({ change: {} as never, workflow: conflictWorkflow, version: 10 });

    enqueueManualOps('wf1', [{ op: 'update-node', nodeId: 'n1', params: { value: 'edited' } }], 'node n1: value = "edited"');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(2));

    expect(api.postManualChange).toHaveBeenNthCalledWith(2, 'wf1', expect.objectContaining({ expectedVersion: 9 }));
    expect(useChatStore.getState().workflowVersion).toBe(10);
    // The rebased op landed on the server's latest workflow (adopted first).
    expect(useFlowStore.getState().workflow.nodes[0]).toMatchObject({ id: 'n1', params: { value: 'edited' } });
    expect(toast).toHaveBeenCalledWith('Đã đồng bộ với thay đổi mới nhất', 'info');
  });

  it('a 2nd conflict on the retry gives up (no infinite rebase) and toasts an error', async () => {
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 11 }),
    );

    enqueueManualOps('wf1', [{ op: 'update-node', nodeId: 'n1', params: { value: 'edited' } }], 'node n1: value = "edited"');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(2));

    expect(toast).toHaveBeenCalledWith(
      'Không áp được thay đổi sau khi đồng bộ — canvas đã cập nhật theo bản mới nhất.',
      'error',
    );
    // Version reflects the 1st (successfully-adopted) conflict only.
    expect(useChatStore.getState().workflowVersion).toBe(9);
  });

  it('a PatchError replaying the op onto the new base also gives up with the same toast', async () => {
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );

    // Targets a node that doesn't exist on the server's latest workflow.
    enqueueManualOps('wf1', [{ op: 'update-node', nodeId: 'does-not-exist', params: { value: 'x' } }], 'node does-not-exist: value = "x"');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Không áp được thay đổi sau khi đồng bộ — canvas đã cập nhật theo bản mới nhất.',
        'error',
      ),
    );
    expect(useFlowStore.getState().workflow).toEqual(conflictWorkflow);
  });
});

describe('network/5xx failure', () => {
  it('sets dirty and toasts a Save-button fallback notice, without retrying', async () => {
    vi.mocked(api.postManualChange).mockRejectedValueOnce(new Error('network down'));

    enqueueManualOps('wf1', [{ op: 'remove-edge', edgeId: 'e1' }], 'xoá edge e1');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(useFlowStore.getState().dirty).toBe(true);
    expect(toast).toHaveBeenCalledWith('Không lưu được thay đổi — bấm Save để lưu thủ công.', 'error');
  });
});

// ---- post-review regression tests (docs/SPEC-step27.md fixes) -------------

describe('422 stale-target response (post-review fix — major finding #2)', () => {
  it('drops the op quietly — no dirty, no "lưu thủ công" toast — since the removal already persisted', async () => {
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(422, 'update-node: node "n1" không tồn tại', undefined, {
        error: 'update-node: node "n1" không tồn tại',
        issues: [{ code: 'patch', message: 'update-node: node "n1" không tồn tại' }],
      }),
    );

    enqueueManualOps('wf1', [{ op: 'update-node', nodeId: 'n1', params: { value: 'x' } }], 'node n1: value = "x"');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    // Give any (wrongly-taken) network-fail branch a chance to run too.
    await Promise.resolve();
    await Promise.resolve();

    expect(useFlowStore.getState().dirty).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('cross-workflow guard (post-review fix — critical finding #1/#4)', () => {
  const otherWorkflow: Workflow = { version: 1, id: 'wf2', name: 'Other', nodes: [], edges: [] };

  it('a debounced update-node scheduled for the OLD workflow is discarded once the canvas has switched to a different one', async () => {
    vi.useFakeTimers();
    try {
      // User edits a param on wf1 (debounce window opens, captures wf1).
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      // The canvas switches to a different workflow WITHOUT going through
      // `flushManualLog()` first (simulating whatever slips past
      // `store/chat.ts`'s flush-before-switch calls) before the 800ms
      // debounce fires.
      useFlowStore.setState({ workflow: otherWorkflow });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    expect(api.postManualChange).not.toHaveBeenCalled();
  });

  it('an immediate (non-debounced) op enqueued for the OLD workflow is discarded if the canvas switches before it actually sends', async () => {
    enqueueManualOps('wf1', [{ op: 'remove-edge', edgeId: 'e1' }], 'xoá edge e1');
    // The queue entry hasn't run yet (it's chained via a microtask) — switch
    // workflows synchronously right after enqueueing.
    useFlowStore.setState({ workflow: otherWorkflow });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.postManualChange).not.toHaveBeenCalled();
    // Discarding must not misreport this as a save failure on the NEW workflow.
    expect(useFlowStore.getState().dirty).toBe(false);
  });

  it('a 409 conflict response for an entry whose workflow has since switched away is also discarded, not merged onto the new canvas', async () => {
    const conflictWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Server latest', nodes: [], edges: [] };
    let rejectFirst!: (err: unknown) => void;
    vi.mocked(api.postManualChange).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    enqueueManualOps('wf1', [{ op: 'remove-edge', edgeId: 'e1' }], 'xoá edge e1');
    await Promise.resolve();
    useFlowStore.setState({ workflow: otherWorkflow });

    rejectFirst(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Must still be `otherWorkflow` — the stale conflict must not clobber it.
    expect(useFlowStore.getState().workflow).toEqual(otherWorkflow);
  });
});

describe('cancelPendingNodeUpdate / cancelPendingMove (post-review fix — major finding #2)', () => {
  it('cancelPendingNodeUpdate prevents a still-pending param debounce from ever sending', async () => {
    vi.useFakeTimers();
    try {
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      cancelPendingNodeUpdate('n1');
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }
    expect(api.postManualChange).not.toHaveBeenCalled();
  });

  it('cancelPendingMove prevents a still-pending drag debounce from ever sending', async () => {
    vi.useFakeTimers();
    try {
      scheduleMove('n1', { x: 1, y: 1 });
      cancelPendingMove('n1');
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
    expect(api.postManualChange).not.toHaveBeenCalled();
  });

  it('is a silent no-op when nothing is pending for that node', () => {
    expect(() => cancelPendingNodeUpdate('does-not-exist')).not.toThrow();
    expect(() => cancelPendingMove('does-not-exist')).not.toThrow();
  });
});

describe('409 rebase preserves OTHER pending local-only nodes (post-review fix — major finding #3)', () => {
  it('a successful rebase folds in a node added locally by a DIFFERENT still-queued entry, and never resets unrelated store fields', async () => {
    const conflictWorkflow: Workflow = {
      version: 1,
      id: 'wf1',
      name: 'Server latest',
      nodes: [{ id: 'sOnly', type: 'input.text', params: {} }],
      edges: [],
    };
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );
    vi.mocked(api.postManualChange).mockResolvedValueOnce({ change: {} as never, workflow: conflictWorkflow, version: 10 });

    // Local canvas already has nodeA (this entry's own add) AND nodeB (added
    // by some OTHER entry still queued behind this one) — plus unrelated UI
    // state a background sync must never touch.
    useFlowStore.setState({
      workflow: {
        version: 1,
        id: 'wf1',
        name: 'Test',
        nodes: [
          { id: 'nodeA', type: 'input.text', params: {} },
          { id: 'nodeB', type: 'input.text', params: {} },
        ],
        edges: [],
      },
      selectedNodeId: 'nodeB',
      runStatus: 'success',
    });

    enqueueManualOps(
      'wf1',
      [{ op: 'add-node', node: { id: 'nodeA', type: 'input.text', params: {} } }],
      'thêm node input.text (nodeA)',
    );

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(2));

    const finalWorkflow = useFlowStore.getState().workflow;
    expect(finalWorkflow.nodes.map((n) => n.id).sort()).toEqual(['nodeA', 'nodeB', 'sOnly']);
    // Unrelated store fields must be untouched by this background rebase —
    // the old `adoptWorkflow(...)` call used to reset both of these.
    expect(useFlowStore.getState().selectedNodeId).toBe('nodeB');
    expect(useFlowStore.getState().runStatus).toBe('success');
  });

  it('a failed rebase (PatchError) still preserves other pending local-only nodes, dropping only this entry\'s own', async () => {
    const conflictWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Server latest', nodes: [], edges: [] };
    vi.mocked(api.postManualChange).mockRejectedValueOnce(
      new ApiError(409, 'version-conflict', undefined, { error: 'version-conflict', workflow: conflictWorkflow, version: 9 }),
    );

    useFlowStore.setState({
      workflow: {
        version: 1,
        id: 'wf1',
        name: 'Test',
        nodes: [{ id: 'nodeB', type: 'input.text', params: {} }],
        edges: [],
      },
    });

    // Targets a node ('does-not-exist') that isn't on the server's latest
    // workflow — the rebase itself can never succeed for this entry.
    enqueueManualOps(
      'wf1',
      [{ op: 'update-node', nodeId: 'does-not-exist', params: { value: 'x' } }],
      'node does-not-exist: value = "x"',
    );

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Không áp được thay đổi sau khi đồng bộ — canvas đã cập nhật theo bản mới nhất.',
        'error',
      ),
    );

    expect(useFlowStore.getState().workflow.nodes.map((n) => n.id)).toEqual(['nodeB']);
  });
});

describe('flushManualLog', () => {
  it('fires pending debounces immediately and resolves only once the queue drains', async () => {
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: baseWorkflow, version: 1 });
    vi.useFakeTimers();
    try {
      scheduleNodeParamsChange('n1', { a: 'x' }, { a: 'y' });
      scheduleMove('n2', { x: 1, y: 2 });
      // Neither debounce's timer has fired yet.
      expect(api.postManualChange).not.toHaveBeenCalled();

      await flushManualLog();
    } finally {
      vi.useRealTimers();
    }

    expect(api.postManualChange).toHaveBeenCalledTimes(2);
  });

  it('is a no-op (resolves immediately) when nothing is pending', async () => {
    await expect(flushManualLog()).resolves.toBeUndefined();
    expect(api.postManualChange).not.toHaveBeenCalled();
  });
});
