/**
 * BrutalEdge.tsx (SPEC-step26.md §3/§4.3): the `.ff-edge-draw` one-shot class
 * applied to the colored top path when this exact edge id carries an
 * `edge-added` highlight in store/chat.ts's `opHighlights` — and only that
 * id, not any other edge's highlight. `BaseEdge` is a plain, context-free
 * component (no ReactFlowProvider needed), so this renders `<BrutalEdge />`
 * directly rather than through a full `<ReactFlow>` tree (mirrors how
 * node-card.test.tsx renders NodeCard, just without the RF node/edge
 * scaffolding this component itself doesn't depend on).
 */
import { Position, type EdgeProps } from '@xyflow/react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrutalEdge, type BrutalEdgeType } from '../src/canvas/BrutalEdge.tsx';
import { useChatStore } from '../src/store/chat.ts';

afterEach(() => {
  cleanup();
  useChatStore.setState({ opHighlights: {} });
});

function makeProps(overrides: Partial<EdgeProps<BrutalEdgeType>> = {}): EdgeProps<BrutalEdgeType> {
  return {
    id: 'e1',
    source: 'n1',
    target: 'n2',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: false,
    data: { color: '#3B5FFF', targetRunning: false },
    ...overrides,
  };
}

function renderEdge(overrides: Partial<EdgeProps<BrutalEdgeType>> = {}) {
  return render(
    <svg>
      <BrutalEdge {...makeProps(overrides)} />
    </svg>,
  );
}

/** The colored top layer is the 2nd `.react-flow__edge-path` (the black outline is the 1st) — see BrutalEdge.tsx's own comment. */
function coloredPath(): Element | null {
  return document.querySelectorAll('path.react-flow__edge-path')[1] ?? null;
}

describe('BrutalEdge highlight (SPEC-step26.md §3)', () => {
  it('applies the ff-edge-draw class on the colored path when highlighted as edge-added', () => {
    useChatStore.setState({ opHighlights: { e1: { kind: 'edge-added', nonce: 1 } } });
    renderEdge();
    expect(coloredPath()?.getAttribute('class')).toContain('ff-edge-draw');
  });

  it('has no ff-edge-draw class when there is no highlight at all', () => {
    useChatStore.setState({ opHighlights: {} });
    renderEdge();
    expect(coloredPath()?.getAttribute('class') ?? '').not.toContain('ff-edge-draw');
  });

  it("does not apply the draw class for a different edge's highlight", () => {
    useChatStore.setState({ opHighlights: { 'other-edge': { kind: 'edge-added', nonce: 1 } } });
    renderEdge({ id: 'e1' });
    expect(coloredPath()?.getAttribute('class') ?? '').not.toContain('ff-edge-draw');
  });

  it("does not apply the draw class for this same id's 'added'/'updated' highlight kinds (edge ids only ever get 'edge-added')", () => {
    useChatStore.setState({ opHighlights: { e1: { kind: 'updated', nonce: 1 } } });
    renderEdge();
    expect(coloredPath()?.getAttribute('class') ?? '').not.toContain('ff-edge-draw');
  });
});
