/**
 * SPEC-step32.md B3-FE — "summary change giàu thông tin", generated at flush
 * time (not schedule time). Two owned files, tested together as one
 * integration surface (neither `manualLog.ts` nor `flow.ts` is mocked here,
 * unlike `flow-manual-log.test.ts`'s pure-wiring tests — the whole point of
 * this suite is the actual TEXT that ends up on the wire):
 *
 * - `store/flow.ts`'s `addNode`/`removeNode` append the node's label to the
 *   summary when it has one (a node the AI created, e.g. via an `add-node`
 *   op carrying `label` — packages/shared's patch.ts — that the user then
 *   deletes by hand).
 * - `store/manualLog.ts`'s `flushNodeUpdate` builds a
 *   `sửa <key> của "<label>" (<type> <id>): <old> → <new>` clause per
 *   changed key/label, reading the node fresh from the live workflow at
 *   flush time (so a rename mid-debounce-window still shows up, and a node
 *   that's vanished entirely by flush time falls back to the bare id).
 *
 * `manual-log.test.ts` (SPEC-step27.md) keeps covering the debounce/queue/
 * 409-rebase MECHANICS (its two summary-content assertions were updated in
 * place to the new format — this file doesn't re-test that plumbing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSpec, Workflow } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return { ...actual, postManualChange: vi.fn() };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';
import { scheduleNodeLabelChange } from '../src/store/manualLog.ts';

const registry: NodeSpec[] = [
  {
    type: 'fal.image',
    category: 'fal',
    title: 'fal image',
    inputs: {},
    outputs: { image: { type: 'image' } },
    paramsJsonSchema: { type: 'object', properties: { modelId: { type: 'string', default: 'flux/dev' } } },
  },
];

const emptyWorkflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] };

function resetStores(nodes: Workflow['nodes'] = []): void {
  useFlowStore.setState({
    workflow: { version: 1, id: 'wf1', name: 'Test', nodes, edges: [] },
    selectedNodeId: null,
    registry,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
  });
  useChatStore.setState({ activeConversationId: 'c1', workflowVersion: 0, turnState: 'idle' });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  resetStores();
});

describe('update-node summary (flushNodeUpdate)', () => {
  it('names the node by its current type + label, quotes+arrows the old/new value', async () => {
    resetStores([{ id: 'img-1', type: 'fal.image', label: 'Ảnh minh hoạ', params: { modelId: 'flux/dev' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('img-1', { modelId: 'flux-pro/kontext' });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith('wf1', {
      ops: [{ op: 'update-node', nodeId: 'img-1', params: { modelId: 'flux-pro/kontext' } }],
      summary: 'sửa modelId của "Ảnh minh hoạ" (fal.image img-1): "flux/dev" → "flux-pro/kontext"',
      expectedVersion: 0,
    });
  });

  it('a node with no label falls back to the raw id standing in for it (not dropped)', async () => {
    resetStores([{ id: 'n1', type: 'input.text', params: { value: 'a' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { value: 'b' });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ summary: 'sửa value của "n1" (input.text n1): "a" → "b"' }),
    );
  });

  it('multiple changed keys become distinct clauses joined by "; "', async () => {
    resetStores([{ id: 'n1', type: 'input.text', params: { a: 'x', b: 1 } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { a: 'y', b: 2 });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    expect(body.summary).toBe(
      'sửa a của "n1" (input.text n1): "x" → "y"; sửa b của "n1" (input.text n1): 1 → 2',
    );
  });

  it('old/new values are JSON-stringified and cut to 30 chars each, independent of the overall 200-char cap', async () => {
    const long = 'a-very-very-very-long-replacement-value-well-past-thirty-characters';
    resetStores([{ id: 'n1', type: 'input.text', params: { value: 'short' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { value: long });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    // Same "JSON.stringify then slice" rule the implementation uses — derived
    // here from the raw value rather than duplicating the function itself.
    const expectedNew = `${JSON.stringify(long).slice(0, 30)}…`;
    expect(body.summary).toBe(`sửa value của "n1" (input.text n1): "short" → ${expectedNew}`);
    expect(expectedNew.length).toBe(31); // 30 chars + the ellipsis marker
  });

  it('reflects the node as it stands at FLUSH time, not at schedule time — a rename mid-debounce-window is picked up', async () => {
    resetStores([{ id: 'n1', type: 'llm.generate', label: 'Old name', params: { prompt: 'a' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { prompt: 'b' });
      // Something else renames the node before the 800ms window elapses
      // (this codebase has no label-editing UI yet — see manualLog.ts's
      // `scheduleNodeLabelChange` — so this simulates whatever future path
      // would do it, e.g. an AI turn's own update-node reconciling in).
      useFlowStore.setState((s) => ({
        workflow: {
          ...s.workflow,
          nodes: s.workflow.nodes.map((n) => (n.id === 'n1' ? { ...n, label: 'New name' } : n)),
        },
      }));
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    expect(body.summary).toContain('"New name" (llm.generate n1)');
    expect(body.summary).not.toContain('Old name');
  });

  it('falls back to the bare id (no type) when the node has vanished entirely by flush time', async () => {
    resetStores([{ id: 'n1', type: 'input.text', params: { value: 'a' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { value: 'b' });
      // The node disappears some other way before flush, WITHOUT going
      // through `removeNode` (which would have cancelled this debounce
      // outright — see `cancelPendingNodeUpdate`) — e.g. a background
      // server-reconcile from another tab.
      useFlowStore.setState((s) => ({ workflow: { ...s.workflow, nodes: [] } }));
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ summary: 'sửa value của "n1": "a" → "b"' }),
    );
  });

  it('a label change alone (no params) still gets its own clause, referencing the node by its NEW label', async () => {
    resetStores([{ id: 'n1', type: 'input.text', label: 'Before', params: {} }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    // No label-editing UI wires `scheduleNodeLabelChange` today — exercised
    // directly here, same as `manual-log.test.ts` does.
    vi.useFakeTimers();
    try {
      scheduleNodeLabelChange('n1', 'Before', 'After');
      // `describeNode` reads live state, so reflect the rename there too —
      // mirroring what a real label-edit UI would do (update the store
      // immediately, log later).
      useFlowStore.setState((s) => ({
        workflow: { ...s.workflow, nodes: s.workflow.nodes.map((n) => (n.id === 'n1' ? { ...n, label: 'After' } : n)) },
      }));
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    expect(body.summary).toBe('sửa label của "After" (input.text n1): "Before" → "After"');
  });

  it('the overall 200-char cap (SPEC-step27.md §2) still applies on top of the richer format', async () => {
    resetStores([{ id: 'n1', type: 'input.text', params: { a: '1', b: '2', c: '3' } }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    const long = 'x'.repeat(60);
    vi.useFakeTimers();
    try {
      useFlowStore.getState().updateNodeParams('n1', { a: long, b: long, c: long });
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.postManualChange).mock.calls[0]!;
    expect(body.summary!.length).toBeLessThanOrEqual(200);
  });
});

describe('add-node / remove-node summary label suffix (store/flow.ts)', () => {
  it('removeNode appends the node\'s label to the summary when it has one', async () => {
    resetStores([{ id: 'img-1', type: 'fal.image', label: 'Ảnh minh hoạ', params: {} }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    useFlowStore.getState().removeNode('img-1');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith('wf1', {
      ops: [{ op: 'remove-node', nodeId: 'img-1' }],
      summary: 'xoá node img-1 "Ảnh minh hoạ"',
      expectedVersion: 0,
    });
  });

  it('removeNode omits the label suffix (unchanged format) when the node has none', async () => {
    resetStores([{ id: 'n1', type: 'input.text', params: {} }]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    useFlowStore.getState().removeNode('n1');

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ summary: 'xoá node n1' }),
    );
  });

  it('addNode never has a label to append yet (no UI sets one at creation) — format is unchanged', async () => {
    resetStores([]);
    vi.mocked(api.postManualChange).mockResolvedValue({ change: {} as never, workflow: emptyWorkflow, version: 1 });

    const id = useFlowStore.getState().addNode('fal.image', { x: 0, y: 0 });

    await vi.waitFor(() => expect(api.postManualChange).toHaveBeenCalledTimes(1));
    expect(api.postManualChange).toHaveBeenCalledWith(
      'wf1',
      expect.objectContaining({ summary: `thêm node fal.image (${id})` }),
    );
  });
});
