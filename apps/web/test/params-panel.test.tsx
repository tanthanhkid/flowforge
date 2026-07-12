import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogFalEntry, CatalogLlmEntry, NodeSpec, UnifiedCatalog, Workflow } from '../src/api/types.ts';
import { ParamsPanel } from '../src/panels/ParamsPanel.tsx';
import { useFlowStore } from '../src/store/flow.ts';

// See node-card.test.tsx for why an explicit cleanup() is required here
// (vitest.config.ts doesn't set test.globals: true).
afterEach(() => {
  cleanup();
});

const spec: NodeSpec = {
  type: 'sample.node',
  category: 'utility',
  title: 'Sample node',
  description: 'A sample node for testing.',
  inputs: {},
  outputs: {},
  paramsJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', default: 'hi' },
      volume: { type: 'number', minimum: 0, maximum: 10, default: 5 },
      mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
      enabled: { type: 'boolean', default: false },
      extra: { type: 'object' },
    },
  },
};

/** SPEC-step19.md §1.6 — empty `UnifiedCatalog`, the store's own default shape. */
function emptyCatalog(): UnifiedCatalog {
  return {
    falVideo: [],
    falImage: [],
    openrouter: [],
    meta: { source: 'static', fetchedAt: null, counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
  };
}

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: workflow.nodes[0]?.id ?? null,
    registry: [spec],
    modelCatalog: emptyCatalog(),
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
  });
}

beforeEach(() => {
  resetStore({
    version: 1,
    id: 'wf1',
    name: 'Test',
    nodes: [
      {
        id: 'n1',
        type: 'sample.node',
        params: { name: 'hi', volume: 5, mode: 'a', enabled: false, extra: { a: 1 } },
      },
    ],
    edges: [],
  });
});

function currentParams(): Record<string, unknown> {
  return useFlowStore.getState().workflow.nodes[0]?.params ?? {};
}

describe('ParamsPanel', () => {
  it('shows a placeholder when no node is selected', () => {
    useFlowStore.setState({ selectedNodeId: null });
    render(<ParamsPanel />);
    expect(screen.getByText(/Chọn một node/)).toBeInTheDocument();
  });

  it('renders a field per type: string, number, enum, boolean', () => {
    render(<ParamsPanel />);
    expect(screen.getByDisplayValue('hi')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('a');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('applies a string field change immediately', () => {
    render(<ParamsPanel />);
    fireEvent.change(screen.getByDisplayValue('hi'), { target: { value: 'bye' } });
    expect(currentParams().name).toBe('bye');
  });

  it('applies an enum field change immediately', () => {
    render(<ParamsPanel />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(currentParams().mode).toBe('b');
  });

  it('applies a boolean field change immediately', () => {
    render(<ParamsPanel />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(currentParams().enabled).toBe(true);
  });

  it('does not apply a number outside min/max', () => {
    render(<ParamsPanel />);
    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '99' } });
    expect(currentParams().volume).toBe(5);
    expect(screen.getByText(/Out of range/)).toBeInTheDocument();
  });

  it('applies a valid in-range number', () => {
    render(<ParamsPanel />);
    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '7' } });
    expect(currentParams().volume).toBe(7);
  });

  it('does not apply an unparsable number', () => {
    render(<ParamsPanel />);
    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: 'abc' } });
    expect(currentParams().volume).toBe(5);
  });

  it('does not call updateNodeParams when the JSON textarea fails to parse', () => {
    render(<ParamsPanel />);
    const textarea = screen.getByDisplayValue(/"a": 1/);
    fireEvent.change(textarea, { target: { value: '{ invalid' } });
    expect(currentParams().extra).toEqual({ a: 1 });
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
  });

  it('applies a valid JSON textarea edit', () => {
    render(<ParamsPanel />);
    const textarea = screen.getByDisplayValue(/"a": 1/);
    fireEvent.change(textarea, { target: { value: '{"b": 2}' } });
    expect(currentParams().extra).toEqual({ b: 2 });
  });

  it('toggles the force-re-run flag for the selected node', () => {
    render(<ParamsPanel />);
    expect(useFlowStore.getState().forceNodeIds).toEqual([]);
    fireEvent.click(screen.getByText('Force re-run node này'));
    expect(useFlowStore.getState().forceNodeIds).toEqual(['n1']);
  });

  it('deletes the node', () => {
    render(<ParamsPanel />);
    fireEvent.click(screen.getByText('Delete node'));
    expect(useFlowStore.getState().workflow.nodes).toHaveLength(0);
  });
});

// SPEC-step10.md §2 — "📤 Chọn file..." upload button on the 3 new node
// types (+ the pre-existing input.file). fetch is mocked directly (not the
// api/client module) so the FormData construction itself is asserted, the
// same style as api-client.test.ts.
describe('ParamsPanel — file upload (SPEC-step10.md §2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const imageSpec: NodeSpec = {
    type: 'input.image',
    category: 'utility',
    title: 'Ảnh có sẵn',
    inputs: {},
    outputs: { image: { type: 'image' } },
    paramsJsonSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } } },
  };

  const markdownSpec: NodeSpec = {
    type: 'input.markdown',
    category: 'utility',
    title: 'Markdown có sẵn',
    inputs: {},
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'chỉ dùng 1 trong "path" hoặc "content"' },
        content: { type: 'string', minLength: 1, description: 'chỉ dùng 1 trong "path" hoặc "content"' },
      },
    },
  };

  function jsonResponse(body: unknown, status = 201): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function renderWithNode(spec: NodeSpec, params: Record<string, unknown> = {}): void {
    resetStore({
      version: 1,
      id: 'wf1',
      name: 'Test',
      nodes: [{ id: 'n1', type: spec.type, params }],
      edges: [],
    });
    useFlowStore.setState({ registry: [spec] });
    render(<ParamsPanel />);
  }

  it('shows the upload button and file input with the image accept filter for input.image', () => {
    renderWithNode(imageSpec);
    expect(screen.getByTestId('upload-file-btn')).toBeInTheDocument();
    expect(screen.getByTestId('upload-file-input')).toHaveAttribute('accept', 'image/*');
  });

  it('uploads via FormData and sets params.path + shows the original filename on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ path: 'uploads/abc123.png', filename: 'my-pic.png', mime: 'image/png', size: 3, kind: 'image' }),
    );
    renderWithNode(imageSpec);

    const file = new File(['abc'], 'my-pic.png', { type: 'image/png' });
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Đã chọn: my-pic\.png/)).toBeInTheDocument());

    expect(useFlowStore.getState().workflow.nodes[0]?.params.path).toBe('uploads/abc123.png');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);

    // The uploaded image becomes a thumbnail under /artifacts/<path>.
    const thumb = screen.getByTestId('upload-image-thumb') as HTMLImageElement;
    expect(thumb.src).toContain('/artifacts/uploads/abc123.png');
  });

  it('shows a red error message when the upload fails, and does not touch params.path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'File vượt quá giới hạn 50MB.' }, 413));
    renderWithNode(imageSpec, { path: '' });

    const file = new File(['x'.repeat(10)], 'big.png', { type: 'image/png' });
    const input = screen.getByTestId('upload-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('upload-error')).toBeInTheDocument());
    expect(screen.getByTestId('upload-error')).toHaveTextContent('File vượt quá giới hạn 50MB.');
    expect(useFlowStore.getState().workflow.nodes[0]?.params.path).toBe('');
  });

  it('input.markdown renders both a path field and a big content textarea, with a "only one of the two" hint', () => {
    renderWithNode(markdownSpec, { content: '' });
    // Both fields' descriptions carry the "chỉ dùng 1 trong" hint (SPEC-step10.md §2).
    expect(screen.getAllByText(/chỉ dùng 1 trong/).length).toBeGreaterThan(0);
    // `content` is in TEXTAREA_FIELD_NAMES -> rendered as a <textarea>, not a single-line <input>.
    expect(document.querySelector('textarea')).toBeInTheDocument();
    expect(screen.getByTestId('upload-file-btn')).toBeInTheDocument();
    expect(screen.getByTestId('upload-file-input')).toHaveAttribute('accept', '.md,.markdown,.txt');
  });
});

// SPEC-step13.md §3 — fal.image/fal.video's `modelId` param: tiered select
// over the model catalog + "✏️ Tự nhập model id..." free-text escape hatch.
describe('ParamsPanel — model catalog select (SPEC-step19.md §2)', () => {
  const falImageSpec: NodeSpec = {
    type: 'fal.image',
    category: 'image',
    title: 'fal.ai: Sinh ảnh',
    inputs: { prompt: { type: 'text', required: true } },
    outputs: { image: { type: 'image' } },
    paramsJsonSchema: {
      type: 'object',
      properties: { modelId: { type: 'string', default: 'fal-ai/flux/dev' } },
    },
  };

  const falVideoSpec: NodeSpec = {
    type: 'fal.video',
    category: 'video',
    title: 'fal.ai: Sinh video',
    inputs: { prompt: { type: 'text', required: true }, image: { type: 'image', required: false } },
    outputs: { video: { type: 'video' } },
    paramsJsonSchema: {
      type: 'object',
      properties: { modelId: { type: 'string' } },
    },
  };

  const imageModels: CatalogFalEntry[] = [
    { id: 'fal-ai/flux-pro/v1.1-ultra', label: 'FLUX 1.1 pro ultra', tier: 'xin', kind: 'image', estUsd: 0.05, estBasis: 'per image', createdAt: null, featured: true },
    { id: 'fal-ai/flux/dev', label: 'FLUX.1 dev', tier: 'kha', kind: 'image', estUsd: 0.025, estBasis: 'per image', createdAt: null, featured: true },
    { id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', tier: 're', note: 'test/nháp', kind: 'image', estUsd: 0.003, estBasis: 'per image', createdAt: null, featured: false },
  ];

  const videoModels: CatalogFalEntry[] = [
    { id: 'fal-ai/kling-video/t2v', label: 'Kling t2v', tier: 'xin', kind: 'video-t2v', estUsd: 0.35, estBasis: 'per 5s clip', createdAt: null, featured: true },
    { id: 'fal-ai/kling-video/i2v', label: 'Kling i2v', tier: 'xin', kind: 'video-i2v', estUsd: 0.35, estBasis: 'per 5s clip', createdAt: null, featured: true },
  ];

  function renderModelIdNode(spec: NodeSpec, params: Record<string, unknown>, edges: Workflow['edges'] = []): void {
    resetStore({
      version: 1,
      id: 'wf1',
      name: 'Test',
      nodes: [{ id: 'n1', type: spec.type, params }],
      edges,
    });
    useFlowStore.setState({
      registry: [spec],
      modelCatalog: { ...emptyCatalog(), falVideo: videoModels, falImage: imageModels },
    });
    render(<ParamsPanel />);
  }

  /** Opens the (sole, on these node specs) ModelPicker's dropdown. */
  function openPicker(): void {
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
  }

  it('shows the matched preset label + price on the closed trigger', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/flux/dev' });
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('FLUX.1 dev');
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('$0.025/ảnh');
  });

  it('opening the picker shows all 3 tier groups + the "Tự nhập" row for fal.image', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/flux/dev' });
    openPicker();
    expect(screen.getByTestId('model-picker-tier-xin')).toHaveTextContent('💎 Xịn');
    expect(screen.getByTestId('model-picker-tier-kha')).toHaveTextContent('✅ Khá');
    expect(screen.getByTestId('model-picker-tier-re')).toHaveTextContent('💸 Rẻ');
    expect(screen.queryByTestId('model-picker-tier-unknown')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-picker-custom')).toHaveTextContent('Tự nhập model id');
  });

  it('the search box filters rows by id or label', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/flux/dev' });
    openPicker();
    fireEvent.change(screen.getByTestId('model-picker-search'), { target: { value: 'schnell' } });
    expect(screen.getByTestId('model-picker-option-fal-ai/flux/schnell')).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-option-fal-ai/flux/dev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-option-fal-ai/flux-pro/v1.1-ultra')).not.toBeInTheDocument();
    // The custom escape hatch stays reachable even when the search matches nothing in the catalog (spec §2).
    expect(screen.getByTestId('model-picker-custom')).toBeInTheDocument();
  });

  it('selecting a preset updates params.modelId and closes the picker', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/flux/dev' });
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-option-fal-ai/flux-pro/v1.1-ultra'));
    expect(useFlowStore.getState().workflow.nodes[0]?.params.modelId).toBe('fal-ai/flux-pro/v1.1-ultra');
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });

  it('an unknown modelId value shows a free-text input with that value on the closed picker (no need to open it)', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/some-other-model' });
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('fal-ai/some-other-model');
    expect(screen.getByDisplayValue('fal-ai/some-other-model')).toBeInTheDocument();
  });

  it('switching to "✏️ Tự nhập model id..." keeps the current value and shows a free-text input', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/flux/dev' });
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-custom'));
    expect(useFlowStore.getState().workflow.nodes[0]?.params.modelId).toBe('fal-ai/flux/dev');
    expect(screen.getByDisplayValue('fal-ai/flux/dev')).toBeInTheDocument();
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });

  it('typing into the custom text input updates params.modelId', () => {
    renderModelIdNode(falImageSpec, { modelId: 'fal-ai/some-other-model' });
    const input = screen.getByDisplayValue('fal-ai/some-other-model');
    fireEvent.change(input, { target: { value: 'fal-ai/brand-new-model' } });
    expect(useFlowStore.getState().workflow.nodes[0]?.params.modelId).toBe('fal-ai/brand-new-model');
  });

  it('fal.video with an edge into its "image" input prioritizes i2v options within the tier', () => {
    renderModelIdNode(falVideoSpec, { modelId: 'fal-ai/kling-video/t2v' }, [
      { id: 'e1', from: { node: 'src', port: 'image' }, to: { node: 'n1', port: 'image' } },
    ]);
    openPicker();
    const i2vOption = screen.getByTestId('model-picker-option-fal-ai/kling-video/i2v');
    const t2vOption = screen.getByTestId('model-picker-option-fal-ai/kling-video/t2v');
    // i2v renders before t2v in the DOM within their shared "xin" tier group.
    expect(i2vOption.compareDocumentPosition(t2vOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // SPEC-step17.md — real-money bug: a t2v model silently ignores a
  // connected image and still bills. Warn inline in that exact case.
  const imageEdge: Workflow['edges'] = [{ id: 'e1', from: { node: 'src', port: 'image' }, to: { node: 'n1', port: 'image' } }];

  it('shows the t2v + image warning when a t2v preset is selected and an image is wired in', () => {
    renderModelIdNode(falVideoSpec, { modelId: 'fal-ai/kling-video/t2v' }, imageEdge);
    expect(screen.getByTestId('t2v-image-warning')).toHaveTextContent(
      /Ảnh nối vào sẽ bị bỏ qua.*chọn model image-to-video/,
    );
    expect(screen.getByTestId('t2v-image-warning')).toHaveTextContent('fal-ai/kling-video/i2v');
  });

  it('does not show the warning for an i2v preset even with an image wired in', () => {
    renderModelIdNode(falVideoSpec, { modelId: 'fal-ai/kling-video/i2v' }, imageEdge);
    expect(screen.queryByTestId('t2v-image-warning')).not.toBeInTheDocument();
  });

  it('does not show the warning for a t2v preset when no image is wired in', () => {
    renderModelIdNode(falVideoSpec, { modelId: 'fal-ai/kling-video/t2v' }, []);
    expect(screen.queryByTestId('t2v-image-warning')).not.toBeInTheDocument();
  });

  it('does not show the warning for a custom (non-catalog) modelId even with an image wired in', () => {
    renderModelIdNode(falVideoSpec, { modelId: 'fal-ai/some-custom-model' }, imageEdge);
    expect(screen.queryByTestId('t2v-image-warning')).not.toBeInTheDocument();
  });
});

// SPEC-step19.md §2 — llm.generate/llm.transform's `model` param: same
// ModelPicker, plus a leading "🔧 Mặc định hệ thống" option -> ''.
describe('ParamsPanel — llm model catalog select (SPEC-step19.md §2)', () => {
  const llmGenerateSpec: NodeSpec = {
    type: 'llm.generate',
    category: 'llm',
    title: 'LLM: Sinh văn bản',
    inputs: { prompt: { type: 'text', required: true } },
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: {
      type: 'object',
      properties: { model: { type: 'string', default: '' }, system: { type: 'string' } },
    },
  };

  const llmModels: CatalogLlmEntry[] = [
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'xin', estUsd: 0.0099, estBasis: 'per call', createdAt: null, featured: true, per1MIn: 3, per1MOut: 15 },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'kha', estUsd: 0.00149, estBasis: 'per call', createdAt: null, featured: true, per1MIn: 0.3, per1MOut: 2.5 },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', tier: 're', estUsd: 0.00024, estBasis: 'per call', createdAt: null, featured: false, per1MIn: 0.1, per1MOut: 0.32 },
  ];

  function renderLlmNode(params: Record<string, unknown>): void {
    resetStore({
      version: 1,
      id: 'wf1',
      name: 'Test',
      nodes: [{ id: 'n1', type: 'llm.generate', params }],
      edges: [],
    });
    useFlowStore.setState({
      registry: [llmGenerateSpec],
      modelCatalog: { ...emptyCatalog(), openrouter: llmModels },
    });
    render(<ParamsPanel />);
  }

  function openPicker(): void {
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
  }

  it('shows "🔧 Mặc định hệ thống" on the closed trigger when model is empty', () => {
    renderLlmNode({ model: '' });
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('Mặc định hệ thống');
  });

  it('opening the picker shows the default option pinned above the tier groups', () => {
    renderLlmNode({ model: '' });
    openPicker();
    expect(screen.getByTestId('model-picker-default')).toHaveTextContent('Mặc định hệ thống');
    expect(screen.getByTestId('model-picker-option-anthropic/claude-sonnet-4.5')).toHaveTextContent('$3 + $15 /1M');
  });

  it('choosing a preset sets params.model to that id', () => {
    renderLlmNode({ model: '' });
    openPicker();
    fireEvent.click(screen.getByTestId('model-picker-option-anthropic/claude-sonnet-4.5'));
    expect(useFlowStore.getState().workflow.nodes[0]?.params.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('custom free-text model id still works via "✏️ Tự nhập model id..."', () => {
    renderLlmNode({ model: 'some/custom-model' });
    expect(screen.getByTestId('model-picker-trigger')).toHaveTextContent('some/custom-model');
    expect(screen.getByDisplayValue('some/custom-model')).toBeInTheDocument();
    const input = screen.getByDisplayValue('some/custom-model');
    fireEvent.change(input, { target: { value: 'some/other-model' } });
    expect(useFlowStore.getState().workflow.nodes[0]?.params.model).toBe('some/other-model');
  });
});
