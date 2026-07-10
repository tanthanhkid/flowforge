import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeSpec, Workflow } from '../src/api/types.ts';
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

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: workflow.nodes[0]?.id ?? null,
    registry: [spec],
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
