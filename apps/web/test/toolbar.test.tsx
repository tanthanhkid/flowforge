/**
 * Toolbar.tsx — 💰 cost estimate (SPEC-step15.md §3): the toolbar shows a
 * `~$X.XX` badge fed by a debounced POST /api/estimate call, an `+?` suffix
 * when the estimate has unknown-cost nodes, and a click-to-open breakdown
 * popover listing each node's usd/basis plus the disclaimer.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostEstimate, Workflow } from '../src/api/types.ts';
import { Toolbar } from '../src/panels/Toolbar.tsx';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const baseWorkflow: Workflow = {
  version: 1,
  id: 'wf1',
  name: 'Test',
  nodes: [{ id: 'a', type: 'input.text', params: { value: 'hi' } }],
  edges: [],
};

function resetStore(workflow: Workflow): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    registry: [],
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
    costEstimate: null,
  });
}

const noop = () => undefined;

describe('Toolbar — 💰 cost estimate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, issues: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetStore(baseWorkflow);
  });

  it('shows a ~$0.00 badge before any estimate has loaded', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    expect(screen.getByTestId('cost-estimate')).toHaveTextContent('~$0.00');
  });

  it('after the 800ms debounce, calls POST /api/estimate and updates the badge with the total', async () => {
    const estimate: CostEstimate = {
      totalUsd: 1.2345,
      unknownCount: 0,
      nodes: [{ nodeId: 'a', type: 'input.text', usd: 1.2345, basis: 'per image' }],
      disclaimer: 'Ước tính tham khảo theo catalog, chưa tính cache hit/retry.',
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/estimate') return Promise.resolve(jsonResponse(estimate));
      return Promise.resolve(jsonResponse({ ok: true, issues: [] }));
    });

    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/estimate', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByTestId('cost-estimate')).toHaveTextContent('~$1.23');
  });

  it('unknownCount > 0 appends "+?" to the badge', async () => {
    const estimate: CostEstimate = {
      totalUsd: 0.5,
      unknownCount: 1,
      nodes: [{ nodeId: 'a', type: 'fal.image', usd: null, basis: 'không rõ', note: 'model ngoài catalog' }],
      disclaimer: 'Ước tính tham khảo theo catalog, chưa tính cache hit/retry.',
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/estimate') return Promise.resolve(jsonResponse(estimate));
      return Promise.resolve(jsonResponse({ ok: true, issues: [] }));
    });

    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(screen.getByTestId('cost-estimate')).toHaveTextContent('+?');
  });

  it('clicking the badge opens a popover with the per-node breakdown and the disclaimer', async () => {
    const estimate: CostEstimate = {
      totalUsd: 0.02,
      unknownCount: 0,
      nodes: [{ nodeId: 'voice', type: 'vbee.tts', usd: 0.02, basis: 'per ~500 ký tự, ước lượng' }],
      disclaimer: 'Ước tính tham khảo theo catalog, chưa tính cache hit/retry.',
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/estimate') return Promise.resolve(jsonResponse(estimate));
      return Promise.resolve(jsonResponse({ ok: true, issues: [] }));
    });

    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    fireEvent.click(screen.getByTestId('cost-estimate'));

    expect(screen.getByText(/voice/)).toBeInTheDocument();
    expect(screen.getByText(/per ~500 ký tự/)).toBeInTheDocument();
    expect(screen.getByText(/Ước tính tham khảo theo catalog/)).toBeInTheDocument();
  });
});

// SPEC-step16.md §3: "🪄 Sắp xếp" button calls the store's autoLayout(),
// which recomputes every node's position via layoutWorkflow.
describe('Toolbar — 🪄 Sắp xếp (SPEC-step16.md §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, issues: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetStore({
      version: 1,
      id: 'wf-layout',
      name: 'Layout test',
      nodes: [
        { id: 'a', type: 'input.text', params: { value: 'hi' }, position: { x: 500, y: 500 } },
        { id: 'b', type: 'input.text', params: { value: 'hi2' }, position: { x: 500, y: 500 } },
      ],
      edges: [],
    });
  });

  it('clicking "🪄 Sắp xếp" recomputes node positions via autoLayout()', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);

    fireEvent.click(screen.getByTestId('auto-layout-btn'));

    const nodes = useFlowStore.getState().workflow.nodes;
    // Both nodes previously sat on the exact same point (500,500) — a
    // real auto-layout must separate them (same column, different rows).
    expect(nodes.find((n) => n.id === 'a')?.position).not.toEqual(nodes.find((n) => n.id === 'b')?.position);
    expect(useFlowStore.getState().dirty).toBe(true);
  });
});
