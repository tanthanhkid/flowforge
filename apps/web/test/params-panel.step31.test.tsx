/**
 * ParamsPanel field labels — SPEC-step31.md F6: known param keys get a
 * friendly Vietnamese label (still the mono/uppercase field-label chrome),
 * an unknown key falls back to a prettified camelCase label WITHOUT the
 * uppercase transform. Mirrors test/params-panel.test.tsx's render setup.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogFalEntry, CatalogLlmEntry, NodeSpec, UnifiedCatalog, Workflow } from '../src/api/types.ts';
import { ParamsPanel } from '../src/panels/ParamsPanel.tsx';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
});

/** SPEC-step19.md §1.6 — empty `UnifiedCatalog`, the store's own default shape. */
function emptyCatalog(): UnifiedCatalog {
  return {
    falVideo: [],
    falImage: [],
    openrouter: [],
    meta: { source: 'static', fetchedAt: null, counts: { falVideo: 0, falImage: 0, openrouter: 0 } },
  };
}

function renderWithSpec(spec: NodeSpec, params: Record<string, unknown>, catalogOverrides?: Partial<UnifiedCatalog>): void {
  const workflow: Workflow = {
    version: 1,
    id: 'wf1',
    name: 'Test',
    nodes: [{ id: 'n1', type: spec.type, params }],
    edges: [],
  };
  useFlowStore.setState({
    workflow,
    selectedNodeId: 'n1',
    registry: [spec],
    modelCatalog: { ...emptyCatalog(), ...catalogOverrides },
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
  });
  render(<ParamsPanel />);
}

describe('ParamsPanel field labels (SPEC-step31.md F6)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('maps known param keys (fal.video) to friendly Vietnamese labels, not the raw camelCase key', () => {
    const spec: NodeSpec = {
      type: 'fal.video',
      category: 'video',
      title: 'fal.ai: Sinh video',
      inputs: { prompt: { type: 'text', required: true } },
      outputs: { video: { type: 'video' } },
      paramsJsonSchema: {
        type: 'object',
        properties: {
          duration: { type: 'string' },
          aspectRatio: { type: 'string' },
          extra: { type: 'object' },
        },
      },
    };
    renderWithSpec(spec, { duration: '5', aspectRatio: '16:9', extra: {} });

    expect(screen.getByText('Thời lượng (giây)')).toBeInTheDocument();
    expect(screen.getByText('Tỉ lệ khung')).toBeInTheDocument();
    expect(screen.getByText('Tham số thêm (JSON)')).toBeInTheDocument();
    // The raw jammed-together camelCase key must not be shown anymore.
    expect(screen.queryByText('aspectRatio')).not.toBeInTheDocument();
    expect(screen.queryByText('ASPECTRATIO')).not.toBeInTheDocument();
  });

  it('maps vbee.tts / llm.generate / video.compose keys too', () => {
    const spec: NodeSpec = {
      type: 'vbee.tts',
      category: 'audio',
      title: 'Vbee: TTS',
      inputs: { text: { type: 'text', required: true } },
      outputs: { audio: { type: 'audio' } },
      paramsJsonSchema: {
        type: 'object',
        properties: {
          voiceCode: { type: 'string' },
          speed: { type: 'number' },
          format: { type: 'string', enum: ['mp3', 'wav'] },
          bitrate: { type: 'number' },
        },
      },
    };
    renderWithSpec(spec, { voiceCode: 'hn_female', speed: 1, format: 'mp3', bitrate: 128 });

    expect(screen.getByText('Giọng đọc')).toBeInTheDocument();
    expect(screen.getByText('Tốc độ')).toBeInTheDocument();
    expect(screen.getByText('Định dạng')).toBeInTheDocument();
    expect(screen.getByText('Bitrate')).toBeInTheDocument();
  });

  it('an unrecognized param key falls back to prettified Title Case (not ALL CAPS)', () => {
    const spec: NodeSpec = {
      type: 'some.future.node',
      category: 'utility',
      title: 'Future node',
      inputs: {},
      outputs: {},
      paramsJsonSchema: {
        type: 'object',
        properties: {
          someNewFancyParam: { type: 'string' },
        },
      },
    };
    renderWithSpec(spec, { someNewFancyParam: 'x' });

    expect(screen.getByText('Some New Fancy Param')).toBeInTheDocument();
    expect(screen.queryByText('SOMENEWFANCYPARAM')).not.toBeInTheDocument();
    expect(screen.queryByText('someNewFancyParam')).not.toBeInTheDocument();
    // Fallback label must not carry the uppercase CSS transform class.
    expect(screen.getByText('Some New Fancy Param').className).not.toContain('uppercase');
  });

  it('known labels keep the uppercase mono chrome class', () => {
    const spec: NodeSpec = {
      type: 'input.text',
      category: 'utility',
      title: 'Văn bản nhập tay',
      inputs: {},
      outputs: { text: { type: 'text' } },
      paramsJsonSchema: { type: 'object', properties: { value: { type: 'string' } } },
    };
    renderWithSpec(spec, { value: 'hi' });

    expect(screen.getByText('Nội dung').className).toContain('uppercase');
  });

  it('the ModelPicker label for fal.image\'s modelId shows the friendly name instead of the raw key', () => {
    const spec: NodeSpec = {
      type: 'fal.image',
      category: 'image',
      title: 'fal.ai: Sinh ảnh',
      inputs: { prompt: { type: 'text', required: true } },
      outputs: { image: { type: 'image' } },
      paramsJsonSchema: { type: 'object', properties: { modelId: { type: 'string' } } },
    };
    const imageModels: CatalogFalEntry[] = [
      {
        id: 'fal-ai/flux/dev',
        label: 'FLUX.1 dev',
        tier: 'kha',
        kind: 'image',
        estUsd: 0.025,
        estBasis: 'per image',
        createdAt: null,
        featured: true,
      },
    ];
    renderWithSpec(spec, { modelId: 'fal-ai/flux/dev' }, { falImage: imageModels });

    // ModelPicker's own label span renders whatever `name` prop it's given.
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.queryByText('modelId')).not.toBeInTheDocument();
  });

  it('the ModelPicker label for llm.generate\'s model shows the friendly name instead of the raw key', () => {
    const spec: NodeSpec = {
      type: 'llm.generate',
      category: 'llm',
      title: 'LLM: Sinh văn bản',
      inputs: { prompt: { type: 'text', required: true } },
      outputs: { text: { type: 'text' } },
      paramsJsonSchema: { type: 'object', properties: { model: { type: 'string', default: '' } } },
    };
    const llmModels: CatalogLlmEntry[] = [
      {
        id: 'anthropic/claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5',
        tier: 'xin',
        estUsd: 0.0099,
        estBasis: 'per call',
        createdAt: null,
        featured: true,
      },
    ];
    renderWithSpec(spec, { model: '' }, { openrouter: llmModels });

    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.queryByText('model')).not.toBeInTheDocument();
  });
});
