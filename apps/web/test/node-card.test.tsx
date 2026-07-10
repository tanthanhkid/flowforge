import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeSpec, WorkflowNode } from '../src/api/types.ts';
import { NodeCard } from '../src/canvas/NodeCard.tsx';
import { PORT_COLORS } from '../src/canvas/portColors.ts';
import type { FlowNode, FlowNodeData } from '../src/canvas/types.ts';

// vitest.config.ts doesn't set `test.globals: true`, so @testing-library/
// react's automatic afterEach(cleanup) (which detects a *global* afterEach)
// never registers — without this, each test's rendered <ReactFlow> tree
// stays mounted into document.body and pollutes the next test's queries.
afterEach(() => {
  cleanup();
});

const spec: NodeSpec = {
  type: 'llm.generate',
  category: 'llm',
  title: 'LLM generate',
  inputs: {
    prompt: { type: 'text', required: true },
    context: { type: 'text', required: false },
  },
  outputs: { text: { type: 'text' } },
  paramsJsonSchema: { type: 'object', properties: {} },
};

const workflowNode: WorkflowNode = { id: 'n1', type: 'llm.generate', params: {}, position: { x: 0, y: 0 } };

// jsdom's CSSStyleDeclaration normalizes hex colors set via inline style
// (NodeCard's portDotStyle) to `rgb(r, g, b)` when read back — compare
// against this rather than the raw hex string from PORT_COLORS.
function hexToRgb(hex: string): string {
  const int = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255})`;
}

function renderNode(data: FlowNodeData) {
  const nodes: FlowNode[] = [{ id: 'n1', type: 'flowforge', position: { x: 0, y: 0 }, data }];
  return render(
    <ReactFlowProvider>
      <div style={{ width: 400, height: 400 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ flowforge: NodeCard }} />
      </div>
    </ReactFlowProvider>,
  );
}

describe('NodeCard', () => {
  it('renders one Handle per input + output port', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    // 2 inputs (prompt, context) + 1 output (text) = 3 handles
    expect(document.querySelectorAll('.react-flow__handle')).toHaveLength(3);
  });

  it("colors each port's Handle by its port type (spec §4 'port màu theo type')", () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    // Both `prompt` and `context` (and `text`) are port type `text` in `spec`.
    const promptHandle = document.querySelector('[data-handleid="prompt"]');
    const contextHandle = document.querySelector('[data-handleid="context"]');
    const textHandle = document.querySelector('[data-handleid="text"]');
    for (const handle of [promptHandle, contextHandle, textHandle]) {
      expect(handle).not.toBeNull();
      const style = (handle as HTMLElement).style;
      expect(style.background).toBe(hexToRgb(PORT_COLORS.text));
      expect(style.borderColor).toBe(hexToRgb(PORT_COLORS.text));
      expect(style.borderStyle).toBe('solid');
    }
  });

  it("renders an `any`-typed port with a dashed, transparent-fill Handle (spec §4 'any viền đứt')", () => {
    const anySpec: NodeSpec = {
      ...spec,
      inputs: { data: { type: 'any', required: true } },
      outputs: {},
    };
    renderNode({ node: workflowNode, spec: anySpec, runState: undefined });
    const handle = document.querySelector('[data-handleid="data"]') as HTMLElement | null;
    expect(handle).not.toBeNull();
    expect(handle?.style.borderStyle).toBe('dashed');
    expect(handle?.style.background).toBe('transparent');
    expect(handle?.style.borderColor).toBe(hexToRgb(PORT_COLORS.any));
  });

  it('renders the node title and category badge', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    expect(screen.getByText('LLM generate')).toBeInTheDocument();
    expect(screen.getByText('llm')).toBeInTheDocument();
  });

  it('shows a pending badge by default and a running badge once state updates', () => {
    const { rerender } = renderNode({ node: workflowNode, spec, runState: { state: 'pending', logs: [] } });
    expect(screen.getByText('pending')).toBeInTheDocument();

    rerender(
      <ReactFlowProvider>
        <div style={{ width: 400, height: 400 }}>
          <ReactFlow
            nodes={[
              {
                id: 'n1',
                type: 'flowforge',
                position: { x: 0, y: 0 },
                data: { node: workflowNode, spec, runState: { state: 'running', logs: [] } },
              },
            ]}
            edges={[]}
            nodeTypes={{ flowforge: NodeCard }}
          />
        </div>
      </ReactFlowProvider>,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('shows an error badge with the error message as a tooltip', () => {
    renderNode({ node: workflowNode, spec, runState: { state: 'error', logs: [], error: 'boom' } });
    const badge = screen.getByText('error');
    expect(badge.closest('[title]')).toHaveAttribute('title', 'boom');
  });

  it('shows the ⚡cache label when the run was a cache hit', () => {
    renderNode({
      node: workflowNode,
      spec,
      runState: { state: 'success', logs: [], cached: true, outputs: { text: 'hi' } },
    });
    expect(screen.getByText(/cache/)).toBeInTheDocument();
  });

  it('renders an inline image preview for a successful image output', () => {
    const imageSpec: NodeSpec = { ...spec, outputs: { image: { type: 'image' } } };
    renderNode({
      node: { ...workflowNode, type: 'fal.image' },
      spec: imageSpec,
      runState: { state: 'success', logs: [], outputs: { image: { kind: 'image', path: 'foo.png' } } },
    });
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/artifacts/foo.png');
  });

  it('does not render a preview when the node has not run successfully', () => {
    renderNode({ node: workflowNode, spec, runState: { state: 'pending', logs: [] } });
    expect(document.querySelector('img')).toBeNull();
  });
});
