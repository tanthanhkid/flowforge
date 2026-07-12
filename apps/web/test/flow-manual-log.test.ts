/**
 * store/flow.ts's wiring into store/manualLog.ts (SPEC-step27.md §3):
 * addNode/removeNode/addEdge/removeEdge/updateNodeParams/updateNodePosition
 * each call the right manualLog function with the right op/summary — but
 * ONLY when the workflow has an active conversation (`hasActiveConversation`
 * mocked here); `adoptWorkflow`/`applyOptimisticOp` (the AI-turn paths) never
 * call anything here regardless. Also covers `run()`/`saveWorkflow()`
 * awaiting `flushManualLog()` first (SPEC-step27.md §2's flush point).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSpec, Workflow } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    getRegistry: vi.fn(),
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    openRunEvents: vi.fn(),
  };
});

vi.mock('../src/store/manualLog.ts', () => ({
  hasActiveConversation: vi.fn(),
  enqueueManualOps: vi.fn(),
  scheduleNodeParamsChange: vi.fn(),
  scheduleNodeLabelChange: vi.fn(),
  scheduleMove: vi.fn(),
  // Post-review fix (major finding #2) — `removeNode` now cancels any
  // still-pending debounce for the node it's deleting.
  cancelPendingNodeUpdate: vi.fn(),
  cancelPendingMove: vi.fn(),
  flushManualLog: vi.fn().mockResolvedValue(undefined),
}));

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import * as manualLog from '../src/store/manualLog.ts';
import { useFlowStore } from '../src/store/flow.ts';

const registry: NodeSpec[] = [
  {
    type: 'input.text',
    category: 'utility',
    title: 'Text input',
    inputs: {},
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: { type: 'object', properties: { value: { type: 'string', default: '' } } },
  },
  {
    type: 'llm.generate',
    category: 'llm',
    title: 'LLM generate',
    inputs: { prompt: { type: 'text', required: true } },
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: { type: 'object', properties: {} },
  },
];

function resetStore(): void {
  useFlowStore.setState({
    workflow: { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] },
    selectedNodeId: null,
    registry,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(manualLog.flushManualLog).mockResolvedValue(undefined);
  resetStore();
});

describe('addNode', () => {
  it('with an active conversation: does not set dirty, logs an add-node op', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });

    expect(useFlowStore.getState().dirty).toBe(false);
    expect(manualLog.enqueueManualOps).toHaveBeenCalledWith(
      'wf1',
      [{ op: 'add-node', node: expect.objectContaining({ id, type: 'input.text' }) }],
      `thêm node input.text (${id})`,
    );
  });

  it('without an active conversation: falls back to dirty=true and does not log', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
    useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });

    expect(useFlowStore.getState().dirty).toBe(true);
    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
  });
});

describe('removeNode', () => {
  it('logs a remove-node op (conversation active) — cascaded edges are not logged separately', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    const b = useFlowStore.getState().addNode('llm.generate', { x: 100, y: 0 });
    useFlowStore.getState().addEdge({ node: a, port: 'text' }, { node: b, port: 'prompt' });
    vi.mocked(manualLog.enqueueManualOps).mockClear();

    useFlowStore.getState().removeNode(a);

    expect(manualLog.enqueueManualOps).toHaveBeenCalledTimes(1);
    expect(manualLog.enqueueManualOps).toHaveBeenCalledWith('wf1', [{ op: 'remove-node', nodeId: a }], `xoá node ${a}`);
    // Post-review fix (major finding #2): any still-pending param/move
    // debounce for the node being deleted must be cancelled first.
    expect(manualLog.cancelPendingNodeUpdate).toHaveBeenCalledWith(a);
    expect(manualLog.cancelPendingMove).toHaveBeenCalledWith(a);
  });

  it('no active conversation: dirty=true, no log', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    vi.mocked(manualLog.enqueueManualOps).mockClear();

    useFlowStore.getState().removeNode(a);

    expect(useFlowStore.getState().dirty).toBe(true);
    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
    expect(manualLog.cancelPendingNodeUpdate).not.toHaveBeenCalled();
    expect(manualLog.cancelPendingMove).not.toHaveBeenCalled();
  });
});

describe('addEdge / removeEdge', () => {
  beforeEach(() => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
  });

  it('addEdge logs an add-edge op with the generated edge id', () => {
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    const b = useFlowStore.getState().addNode('llm.generate', { x: 100, y: 0 });
    vi.mocked(manualLog.enqueueManualOps).mockClear();

    const ok = useFlowStore.getState().addEdge({ node: a, port: 'text' }, { node: b, port: 'prompt' });

    expect(ok).toBe(true);
    expect(manualLog.enqueueManualOps).toHaveBeenCalledWith(
      'wf1',
      [{ op: 'add-edge', edge: { id: 'e_1', from: { node: a, port: 'text' }, to: { node: b, port: 'prompt' } } }],
      `nối ${a}.text → ${b}.prompt`,
    );
  });

  it('a rejected addEdge (type mismatch / occupied port) never logs anything', () => {
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    vi.mocked(manualLog.enqueueManualOps).mockClear();

    const ok = useFlowStore.getState().addEdge({ node: a, port: 'text' }, { node: 'does-not-exist', port: 'prompt' });

    expect(ok).toBe(false);
    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
  });

  it('removeEdge logs a remove-edge op', () => {
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    const b = useFlowStore.getState().addNode('llm.generate', { x: 100, y: 0 });
    useFlowStore.getState().addEdge({ node: a, port: 'text' }, { node: b, port: 'prompt' });
    vi.mocked(manualLog.enqueueManualOps).mockClear();

    useFlowStore.getState().removeEdge('e_1');

    expect(manualLog.enqueueManualOps).toHaveBeenCalledWith('wf1', [{ op: 'remove-edge', edgeId: 'e_1' }], 'xoá edge e_1');
  });
});

describe('updateNodeParams', () => {
  it('schedules a params change with the pre-update params as baseline (conversation active), no dirty', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    vi.mocked(manualLog.scheduleNodeParamsChange).mockClear();

    useFlowStore.getState().updateNodeParams(id, { value: 'hello' });

    expect(useFlowStore.getState().dirty).toBe(false);
    expect(manualLog.scheduleNodeParamsChange).toHaveBeenCalledWith(id, { value: '' }, { value: 'hello' });
    expect(useFlowStore.getState().workflow.nodes.find((n) => n.id === id)?.params).toEqual({ value: 'hello' });
  });

  it('no active conversation: dirty=true, nothing scheduled', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    useFlowStore.setState({ dirty: false });

    useFlowStore.getState().updateNodeParams(id, { value: 'hello' });

    expect(useFlowStore.getState().dirty).toBe(true);
    expect(manualLog.scheduleNodeParamsChange).not.toHaveBeenCalled();
  });
});

describe('updateNodePosition (move-node)', () => {
  it('schedules a move (conversation active), no dirty', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });

    useFlowStore.getState().updateNodePosition(id, { x: 42, y: 7 });

    expect(useFlowStore.getState().dirty).toBe(false);
    expect(manualLog.scheduleMove).toHaveBeenCalledWith(id, { x: 42, y: 7 });
  });

  it('no active conversation: dirty=true, nothing scheduled', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(false);
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    useFlowStore.setState({ dirty: false });

    useFlowStore.getState().updateNodePosition(id, { x: 42, y: 7 });

    expect(useFlowStore.getState().dirty).toBe(true);
    expect(manualLog.scheduleMove).not.toHaveBeenCalled();
  });
});

describe('adoptWorkflow / applyOptimisticOp never log manual changes', () => {
  it('adoptWorkflow does not call any manualLog function even with an active conversation', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    const incoming: Workflow = { version: 1, id: 'wf2', name: 'Adopted', nodes: [], edges: [] };

    useFlowStore.getState().adoptWorkflow(incoming);

    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
    expect(manualLog.scheduleNodeParamsChange).not.toHaveBeenCalled();
    expect(manualLog.scheduleMove).not.toHaveBeenCalled();
  });

  it('applyOptimisticOp does not call any manualLog function even with an active conversation', () => {
    vi.mocked(manualLog.hasActiveConversation).mockReturnValue(true);
    useFlowStore.getState().applyOptimisticOp({
      op: 'add-node',
      node: { id: 'n1', type: 'input.text', params: {}, position: { x: 0, y: 0 } },
    });

    expect(manualLog.enqueueManualOps).not.toHaveBeenCalled();
  });
});

describe('run() / saveWorkflow() flush before proceeding', () => {
  it('run() awaits flushManualLog() before starting the run', async () => {
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    vi.mocked(api.openRunEvents).mockImplementation(() => vi.fn());

    let resolveFlush!: () => void;
    vi.mocked(manualLog.flushManualLog).mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );

    const runPromise = useFlowStore.getState().run();
    // createRun must not have been called yet — still awaiting the flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(api.createRun).not.toHaveBeenCalled();

    resolveFlush();
    await runPromise;
    expect(api.createRun).toHaveBeenCalled();
  });

  it('saveWorkflow() awaits flushManualLog() before PUT/POST-ing the workflow', async () => {
    vi.mocked(api.createWorkflow).mockResolvedValue({ id: 'wf1' });

    let resolveFlush!: () => void;
    vi.mocked(manualLog.flushManualLog).mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );

    const savePromise = useFlowStore.getState().saveWorkflow();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.createWorkflow).not.toHaveBeenCalled();

    resolveFlush();
    await savePromise;
    expect(api.createWorkflow).toHaveBeenCalled();
  });
});
