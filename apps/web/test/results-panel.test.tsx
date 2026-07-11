/**
 * SPEC-step9.md §4 — results-panel.test.tsx: renders the "Kết quả cuối"
 * block from an `output.collect` node's outputs (image + text), the
 * download link's href ends in `?download=1`, the Copy button calls the
 * (mocked) clipboard, an errored run surfaces the error, and a workflow
 * with no `output.collect` node falls back to its leaf nodes.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSpec, Workflow } from '../src/api/types.ts';
import { ResultsPanel } from '../src/panels/ResultsPanel.tsx';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
});

const registry: NodeSpec[] = [
  {
    type: 'input.text',
    category: 'utility',
    title: 'Text input',
    inputs: {},
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: { type: 'object', properties: {} },
  },
  {
    type: 'output.collect',
    category: 'utility',
    title: 'Gom kết quả',
    inputs: {
      in1: { type: 'any' },
      in2: { type: 'any' },
    },
    outputs: { results: { type: 'json' } },
    paramsJsonSchema: { type: 'object', properties: {} },
  },
];

function collectWorkflow(): Workflow {
  return {
    version: 1,
    id: 'wf1',
    name: 'Test',
    nodes: [
      { id: 'input_1', type: 'input.text', params: { value: 'xin chào' }, position: { x: 0, y: 0 } },
      { id: 'collect_1', type: 'output.collect', params: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', from: { node: 'input_1', port: 'text' }, to: { node: 'collect_1', port: 'in1' } }],
  };
}

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    registry,
    selectedNodeId: null,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
    scrollToNodeId: null,
    rightTab: 'results',
  });
}

beforeEach(() => {
  resetStore(collectWorkflow());
});

describe('ResultsPanel', () => {
  it('shows a placeholder when no run has happened yet', () => {
    render(<ResultsPanel />);
    expect(screen.getByTestId('results-panel')).toHaveTextContent('Chưa có run nào');
  });

  it('renders the final result from an output.collect node: text with a Copy button, image with a ?download=1 link', () => {
    useFlowStore.setState({
      runId: 'run1',
      runStatus: 'success',
      nodeRuns: {
        input_1: { state: 'success', logs: [], outputs: { text: 'xin chào' } },
        collect_1: {
          state: 'success',
          logs: [],
          outputs: { results: { in1: 'xin chào', in2: { kind: 'image', path: 'foo.png' } } },
        },
      },
    });

    render(<ResultsPanel />);

    expect(screen.getByTestId('results-panel')).toHaveTextContent('xin chào');
    expect(screen.getByTestId('result-copy-btn')).toBeInTheDocument();

    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/artifacts/foo.png');

    const downloadLink = screen.getByTestId('result-download-link');
    expect(downloadLink.getAttribute('href')).toBe('/artifacts/foo.png?download=1');
  });

  it('the Copy button writes the text value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    useFlowStore.setState({
      runId: 'run1',
      runStatus: 'success',
      nodeRuns: {
        input_1: { state: 'success', logs: [], outputs: { text: 'xin chào' } },
        collect_1: { state: 'success', logs: [], outputs: { results: { in1: 'xin chào' } } },
      },
    });

    render(<ResultsPanel />);
    fireEvent.click(screen.getByTestId('result-copy-btn'));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('xin chào');
    });
  });

  it('shows the error banner + message when a node failed', () => {
    useFlowStore.setState({
      runId: 'run1',
      runStatus: 'error',
      nodeRuns: {
        input_1: { state: 'success', logs: [], outputs: { text: 'xin chào' } },
        collect_1: { state: 'error', logs: [], error: 'boom failure' },
      },
    });

    render(<ResultsPanel />);

    expect(screen.getByTestId('results-error-banner')).toHaveTextContent('boom failure');
  });

  it('falls back to leaf-node outputs when the workflow has no output.collect node', () => {
    const workflow: Workflow = {
      version: 1,
      id: 'wf2',
      name: 'No collect',
      nodes: [{ id: 'input_1', type: 'input.text', params: { value: 'hello' }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    resetStore(workflow);
    useFlowStore.setState({
      runId: 'run1',
      runStatus: 'success',
      nodeRuns: { input_1: { state: 'success', logs: [], outputs: { text: 'hello' } } },
    });

    render(<ResultsPanel />);

    expect(screen.getByTestId('results-panel')).toHaveTextContent('hello');
  });

  // SPEC-step18.md §4/7.5 — root-cause fix for "tab Kết quả báo 'Chưa có run
  // nào' dù DB có run": mounting without a live run must ask the store to
  // backfill the workflow's latest one, reusing openRun's own logic.
  it('calls store.ensureLatestRunLoaded on mount when there is no live run', () => {
    const ensureLatestRunLoaded = vi.fn().mockResolvedValue(undefined);
    useFlowStore.setState({ ensureLatestRunLoaded });

    render(<ResultsPanel />);

    expect(ensureLatestRunLoaded).toHaveBeenCalledTimes(1);
  });

  it('does not call store.ensureLatestRunLoaded when a live run is already loaded', () => {
    const ensureLatestRunLoaded = vi.fn().mockResolvedValue(undefined);
    useFlowStore.setState({
      ensureLatestRunLoaded,
      runId: 'run1',
      runStatus: 'success',
      nodeRuns: { input_1: { state: 'success', logs: [], outputs: { text: 'xin chào' } } },
    });

    render(<ResultsPanel />);

    expect(ensureLatestRunLoaded).not.toHaveBeenCalled();
  });

  it('lists every success node (compact) in the collapsed "Tất cả node" section', () => {
    useFlowStore.setState({
      runId: 'run1',
      runStatus: 'success',
      nodeRuns: {
        input_1: { state: 'success', logs: [], outputs: { text: 'xin chào' } },
        collect_1: { state: 'success', logs: [], outputs: { results: { in1: 'xin chào' } } },
      },
    });

    render(<ResultsPanel />);

    const blocks = screen.getAllByTestId('results-node-block');
    expect(blocks).toHaveLength(2);
  });
});
