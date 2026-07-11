import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeSpec, WorkflowNode } from '../src/api/types.ts';
import { NodeCard } from '../src/canvas/NodeCard.tsx';
import { PORT_COLORS } from '../src/canvas/portColors.ts';
import { useFlowStore } from '../src/store/flow.ts';
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

  it("colors each port's Handle *fill* by its port type (spec §4 'port màu theo type')", () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    // Both `prompt` and `context` (and `text`) are port type `text` in `spec`.
    const promptHandle = document.querySelector('[data-handleid="prompt"]');
    const contextHandle = document.querySelector('[data-handleid="context"]');
    const textHandle = document.querySelector('[data-handleid="text"]');
    for (const handle of [promptHandle, contextHandle, textHandle]) {
      expect(handle).not.toBeNull();
      const style = (handle as HTMLElement).style;
      expect(style.background).toBe(hexToRgb(PORT_COLORS.text));
      // SPEC-step18.md §6.2 (post-review fix): the border is always solid
      // black, not the port's own color — a colored 2px border on a
      // saturated port color reads at ~1.1:1 contrast against the
      // cream/white card, the same low-contrast problem §6.2 requires a
      // black outline to fix for edges (this dot is that edge's endpoint).
      // The fill still carries the port-type color.
      expect(style.borderColor).toBe(hexToRgb('#0D0D0D'));
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

  // SPEC-step18.md §5.3 (post-review fix): ports must protrude past the
  // card's own outline ("nhô ra ngoài mép card") rather than sit fully
  // inside it — the inline `left`/`right` override (React Flow's own
  // `.react-flow__handle-left`/`-right` classes default to `left:0`/
  // `right:0`, which lands the dot inside the row's own padding/border
  // inset, not past the card's outer edge) is what makes that happen.
  it('positions an input (left) Handle with a negative `left` so it protrudes past the card edge', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    const handle = document.querySelector('[data-handleid="prompt"]') as HTMLElement | null;
    expect(handle).not.toBeNull();
    expect(Number.parseFloat(handle!.style.left)).toBeLessThan(0);
  });

  it('positions an output (right) Handle with a negative `right` so it protrudes past the card edge', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    const handle = document.querySelector('[data-handleid="text"]') as HTMLElement | null;
    expect(handle).not.toBeNull();
    expect(Number.parseFloat(handle!.style.right)).toBeLessThan(0);
  });

  it('renders the node title and category badge', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    expect(screen.getByText('LLM generate')).toBeInTheDocument();
    expect(screen.getByText('llm')).toBeInTheDocument();
  });

  // SPEC-step16.md §1: a fixed 300px node box, not a `min-w` that stretches
  // to fit long content (that's the bug this step fixes — a long LLM text
  // preview used to stretch the node to 1000+px and overlap its neighbors).
  it('has a fixed 300px width (not a min-width that grows with content)', () => {
    renderNode({ node: workflowNode, spec, runState: undefined });
    const card = screen.getByTestId('node-card');
    expect(card.className).toContain('w-[300px]');
    expect(card.className).not.toMatch(/min-w-/);
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

  it('shows a 🔁 force chip when the node is queued in forceNodeIds (SPEC-step6.md §3)', () => {
    useFlowStore.setState({ forceNodeIds: ['n1'] });
    renderNode({ node: workflowNode, spec, runState: undefined });
    expect(screen.getByText(/force/)).toBeInTheDocument();
    useFlowStore.setState({ forceNodeIds: [] });
  });

  it('does not show the force chip when the node is not queued', () => {
    useFlowStore.setState({ forceNodeIds: [] });
    renderNode({ node: workflowNode, spec, runState: undefined });
    expect(screen.queryByText(/force/)).toBeNull();
  });

  // SPEC-step9.md §1 — compact preview + toggle.
  describe('compact preview (SPEC-step9.md §1)', () => {
    afterEach(() => {
      useFlowStore.setState({ showNodePreviews: true });
    });

    it('caps an image preview to a small thumbnail (max-h-20) instead of the old max-h-32', () => {
      const imageSpec: NodeSpec = { ...spec, outputs: { image: { type: 'image' } } };
      renderNode({
        node: { ...workflowNode, type: 'fal.image' },
        spec: imageSpec,
        runState: { state: 'success', logs: [], outputs: { image: { kind: 'image', path: 'foo.png' } } },
      });
      const img = document.querySelector('img');
      expect(img?.className).toContain('max-h-20');
    });

    it('clamps a text preview to a single line (line-clamp-1)', () => {
      const textSpec: NodeSpec = { ...spec, outputs: { text: { type: 'text' } } };
      renderNode({
        node: workflowNode,
        spec: textSpec,
        runState: { state: 'success', logs: [], outputs: { text: 'line one\nline two\nline three' } },
      });
      const p = screen.getByText(/line one/);
      expect(p.className).toContain('line-clamp-1');
    });

    it('shows a per-node ▾/▸ toggle that hides node-preview when clicked, keeping the badge/testid absent while collapsed', () => {
      const textSpec: NodeSpec = { ...spec, outputs: { text: { type: 'text' } } };
      renderNode({
        node: workflowNode,
        spec: textSpec,
        runState: { state: 'success', logs: [], outputs: { text: 'hello' } },
      });
      expect(screen.getByTestId('node-preview')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('node-preview-toggle'));
      expect(screen.queryByTestId('node-preview')).toBeNull();

      fireEvent.click(screen.getByTestId('node-preview-toggle'));
      expect(screen.getByTestId('node-preview')).toBeInTheDocument();
    });

    it('hides all node previews (and the per-node toggle) when the global showNodePreviews store flag is off', () => {
      useFlowStore.setState({ showNodePreviews: false });
      const textSpec: NodeSpec = { ...spec, outputs: { text: { type: 'text' } } };
      renderNode({
        node: workflowNode,
        spec: textSpec,
        runState: { state: 'success', logs: [], outputs: { text: 'hello' } },
      });
      expect(screen.queryByTestId('node-preview')).toBeNull();
      expect(screen.queryByTestId('node-preview-toggle')).toBeNull();
    });

    it('clicking the preview strip requests a scroll-to for this node (store scrollToNodeId + rightTab)', () => {
      const textSpec: NodeSpec = { ...spec, outputs: { text: { type: 'text' } } };
      renderNode({
        node: workflowNode,
        spec: textSpec,
        runState: { state: 'success', logs: [], outputs: { text: 'hello' } },
      });
      fireEvent.click(screen.getByTestId('node-preview'));
      expect(useFlowStore.getState().scrollToNodeId).toBe('n1');
      expect(useFlowStore.getState().rightTab).toBe('results');
      useFlowStore.setState({ scrollToNodeId: null, rightTab: 'params' });
    });
  });
});
