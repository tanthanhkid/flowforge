import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventHandlers } from '../src/api/client.ts';
import type { NodeSpec, RunSnapshot, Workflow } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return {
    ...actual,
    getRegistry: vi.fn(),
    listWorkflows: vi.fn(),
    createWorkflow: vi.fn(),
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    validateWorkflow: vi.fn(),
    createRun: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    openRunEvents: vi.fn(),
  };
});

// Imported after vi.mock (hoisted above these imports by Vitest) so `api.*`
// below refers to the mocked functions.
import * as api from '../src/api/client.ts';
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
    paramsJsonSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', default: '' },
        temperature: { type: 'number', default: 0.7 },
        maxTokens: { type: 'integer' }, // no `default` — must be omitted from addNode's params
      },
    },
  },
  {
    type: 'fal.image',
    category: 'image',
    title: 'fal image',
    inputs: { prompt: { type: 'text', required: true } },
    outputs: { image: { type: 'image' } },
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
  resetStore();
});

describe('addNode', () => {
  it('generates a unique id (${type}_${k}) and marks the store dirty', () => {
    const id1 = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    expect(id1).toBe('input_text_1');
    const id2 = useFlowStore.getState().addNode('input.text', { x: 10, y: 10 });
    expect(id2).toBe('input_text_2');

    const nodes = useFlowStore.getState().workflow.nodes;
    expect(nodes.map((n) => n.id)).toEqual(['input_text_1', 'input_text_2']);
    expect(nodes[0]).toMatchObject({ id: 'input_text_1', type: 'input.text', params: { value: '' } });
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('takes only the params that have a `default` in the JSON schema', () => {
    const id = useFlowStore.getState().addNode('llm.generate', { x: 0, y: 0 });
    const node = useFlowStore.getState().workflow.nodes.find((n) => n.id === id);
    expect(node?.params).toEqual({ model: '', temperature: 0.7 });
    expect(node?.params).not.toHaveProperty('maxTokens');
  });

  it('an unknown node type still gets an id and empty params', () => {
    const id = useFlowStore.getState().addNode('does.not.exist', { x: 0, y: 0 });
    expect(id).toBe('does_not_exist_1');
    const node = useFlowStore.getState().workflow.nodes.find((n) => n.id === id);
    expect(node?.params).toEqual({});
  });
});

describe('addEdge', () => {
  beforeEach(() => {
    useFlowStore.getState().addNode('input.text', { x: 0, y: 0 }); // input_text_1
    useFlowStore.getState().addNode('llm.generate', { x: 100, y: 0 }); // llm_generate_1
    useFlowStore.getState().addNode('fal.image', { x: 200, y: 0 }); // fal_image_1
    useFlowStore.setState({ dirty: false });
  });

  it('accepts a compatible edge and sets dirty', () => {
    const ok = useFlowStore
      .getState()
      .addEdge({ node: 'input_text_1', port: 'text' }, { node: 'llm_generate_1', port: 'prompt' });
    expect(ok).toBe(true);
    expect(useFlowStore.getState().workflow.edges).toHaveLength(1);
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('rejects a type mismatch (text -> image) without mutating the workflow', () => {
    const ok = useFlowStore
      .getState()
      .addEdge({ node: 'input_text_1', port: 'text' }, { node: 'fal_image_1', port: 'image' });
    expect(ok).toBe(false);
    expect(useFlowStore.getState().workflow.edges).toHaveLength(0);
    expect(useFlowStore.getState().dirty).toBe(false);
  });

  it('rejects a second edge into an already-occupied input port', () => {
    const first = useFlowStore
      .getState()
      .addEdge({ node: 'input_text_1', port: 'text' }, { node: 'llm_generate_1', port: 'prompt' });
    expect(first).toBe(true);

    const second = useFlowStore
      .getState()
      .addEdge({ node: 'input_text_1', port: 'text' }, { node: 'llm_generate_1', port: 'prompt' });
    expect(second).toBe(false);
    expect(useFlowStore.getState().workflow.edges).toHaveLength(1);
  });
});

describe('removeNode', () => {
  it('removes the node and any edges touching it', () => {
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    const b = useFlowStore.getState().addNode('llm.generate', { x: 100, y: 0 });
    const added = useFlowStore.getState().addEdge({ node: a, port: 'text' }, { node: b, port: 'prompt' });
    expect(added).toBe(true);
    expect(useFlowStore.getState().workflow.edges).toHaveLength(1);

    useFlowStore.getState().removeNode(a);

    const state = useFlowStore.getState();
    expect(state.workflow.nodes.find((n) => n.id === a)).toBeUndefined();
    expect(state.workflow.edges).toHaveLength(0);
  });

  it('clears selectedNodeId when the removed node was selected', () => {
    const a = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    useFlowStore.getState().selectNode(a);
    expect(useFlowStore.getState().selectedNodeId).toBe(a);

    useFlowStore.getState().removeNode(a);
    expect(useFlowStore.getState().selectedNodeId).toBeNull();
  });
});

describe('updateNodePosition', () => {
  it('writes the position back into the workflow JSON and sets dirty', () => {
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    useFlowStore.setState({ dirty: false });

    useFlowStore.getState().updateNodePosition(id, { x: 42, y: 7 });

    const node = useFlowStore.getState().workflow.nodes.find((n) => n.id === id);
    expect(node?.position).toEqual({ x: 42, y: 7 });
    expect(useFlowStore.getState().dirty).toBe(true);
  });
});

describe('setWorkflowJson', () => {
  it('replaces the entire workflow', () => {
    useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    const replacement: Workflow = { version: 1, id: 'wf2', name: 'Replaced', nodes: [], edges: [] };

    useFlowStore.getState().setWorkflowJson(replacement);

    expect(useFlowStore.getState().workflow).toEqual(replacement);
    expect(useFlowStore.getState().dirty).toBe(true);
  });

  it('clears selectedNodeId if that node no longer exists in the replacement', () => {
    const id = useFlowStore.getState().addNode('input.text', { x: 0, y: 0 });
    useFlowStore.getState().selectNode(id);

    useFlowStore.getState().setWorkflowJson({ version: 1, id: 'wf2', name: '', nodes: [], edges: [] });

    expect(useFlowStore.getState().selectedNodeId).toBeNull();
  });
});

describe('run', () => {
  it('saves first when dirty, starts a run, applies SSE node:state, then refetches full outputs on done', async () => {
    useFlowStore.setState({ dirty: true });
    vi.mocked(api.createWorkflow).mockResolvedValue({ id: 'wf1' });
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });

    let handlers: RunEventHandlers = {};
    vi.mocked(api.openRunEvents).mockImplementation((_runId, h) => {
      handlers = h;
      return vi.fn();
    });

    const finalSnapshot: RunSnapshot = {
      run: { id: 'run1', workflowId: 'wf1', workflowJson: '{}', status: 'success', createdAt: 0, finishedAt: 1 },
      nodes: [{ runId: 'run1', nodeId: 'n1', state: 'success', outputs: { text: 'hi' }, logs: [], cacheHit: false }],
    };
    vi.mocked(api.getRun).mockResolvedValue(finalSnapshot);

    await useFlowStore.getState().run();

    expect(api.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf1' }));
    expect(useFlowStore.getState().dirty).toBe(false);
    expect(api.createRun).toHaveBeenCalledWith({ workflowId: 'wf1', forceNodes: undefined });
    expect(useFlowStore.getState().runId).toBe('run1');
    expect(useFlowStore.getState().runStatus).toBe('running');

    handlers.onNodeState?.({ runId: 'run1', nodeId: 'n1', state: 'running' });
    expect(useFlowStore.getState().nodeRuns.n1?.state).toBe('running');

    handlers.onNodeLog?.({ runId: 'run1', nodeId: 'n1', message: 'log line' });
    expect(useFlowStore.getState().nodeRuns.n1?.logs).toEqual(['log line']);

    handlers.onDone?.();
    await vi.waitFor(() => {
      expect(api.getRun).toHaveBeenCalledWith('run1');
      expect(useFlowStore.getState().nodeRuns.n1?.outputs).toEqual({ text: 'hi' });
    });
    expect(useFlowStore.getState().runStatus).toBe('success');
  });

  it('does not save when not dirty', async () => {
    useFlowStore.setState({ dirty: false });
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    vi.mocked(api.openRunEvents).mockImplementation(() => vi.fn());

    await useFlowStore.getState().run();

    expect(api.createWorkflow).not.toHaveBeenCalled();
    expect(api.updateWorkflow).not.toHaveBeenCalled();
  });

  it('forwards the force list to createRun', async () => {
    useFlowStore.setState({ dirty: false });
    vi.mocked(api.createRun).mockResolvedValue({ runId: 'run1' });
    vi.mocked(api.openRunEvents).mockImplementation(() => vi.fn());

    await useFlowStore.getState().run(['n1']);

    expect(api.createRun).toHaveBeenCalledWith({ workflowId: 'wf1', forceNodes: ['n1'] });
  });

  it('surfaces validation issues from a 400 without setting runId', async () => {
    useFlowStore.setState({ dirty: false });
    vi.mocked(api.createRun).mockRejectedValue(new api.ApiError(400, 'invalid', [{ code: 'cycle', message: 'bad' }]));

    await useFlowStore.getState().run();

    expect(useFlowStore.getState().runId).toBeUndefined();
    expect(useFlowStore.getState().validationIssues).toEqual([{ code: 'cycle', message: 'bad' }]);
  });
});

describe('openRun', () => {
  it('loads a past run snapshot into nodeRuns', async () => {
    const snapshot: RunSnapshot = {
      run: { id: 'run2', workflowId: 'wf1', workflowJson: '{}', status: 'error', createdAt: 0, finishedAt: 1 },
      nodes: [{ runId: 'run2', nodeId: 'n1', state: 'error', error: 'boom', logs: ['oops'], cacheHit: false }],
    };
    vi.mocked(api.getRun).mockResolvedValue(snapshot);

    await useFlowStore.getState().openRun('run2');

    expect(useFlowStore.getState().runId).toBe('run2');
    expect(useFlowStore.getState().runStatus).toBe('error');
    expect(useFlowStore.getState().nodeRuns.n1).toEqual({
      state: 'error',
      outputs: undefined,
      error: 'boom',
      cached: false,
      logs: ['oops'],
      startedAt: undefined,
      finishedAt: undefined,
    });
  });
});
