/**
 * SPEC-step31.md — Toolbar.tsx fixes:
 *
 * §F2 (toolbar overflow at 1366×768): the secondary buttons (Validate,
 * 🪄 Sắp xếp, 👁 Preview, {} JSON, Run ⚡ bỏ cache) now render an always-
 * visible icon plus a label wrapped in `hidden 2xl:inline` (collapses to
 * icon-only below the `2xl` breakpoint) and keep both `title` and
 * `aria-label` so their meaning survives losing the visible label — jsdom
 * has no real layout engine, so the *pixel* "no overflow at 1366px" claim
 * itself is covered by e2e, not here; this only asserts the structural
 * pieces that claim depends on.
 *
 * §F5 (cost popover list clipped, no scroll): the per-node list now uses
 * `max-h-[50vh] overflow-y-auto` (was a fixed `max-h-60`/240px, which on a
 * 10-node workflow clipped the last row right where the "Tổng" footer line
 * began) with the "Tổng"/disclaimer footer staying outside that scroll box.
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

describe('Toolbar — SPEC-step31.md §F2 (icon-only below 2xl, title/aria-label kept)', () => {
  beforeEach(() => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, issues: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetStore(baseWorkflow);
  });

  it.each([
    ['validate-btn', 'Validate'],
    ['auto-layout-btn', 'Tự động sắp xếp lại vị trí node (không chồng nhau)'],
    ['preview-toggle-btn', 'Bật/tắt preview trên tất cả node'],
    ['json-view-btn', 'JSON'],
    ['run-force-btn', 'Chạy lại toàn bộ node, bỏ qua cache'],
  ])('%s keeps a title and matching aria-label', (testId, expected) => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    const btn = screen.getByTestId(testId);
    expect(btn).toHaveAttribute('title', expected);
    expect(btn).toHaveAttribute('aria-label', expected);
  });

  it('settings-btn (always icon-only) also keeps a title and aria-label', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    const btn = screen.getByTestId('settings-btn');
    expect(btn).toHaveAttribute('title', 'Settings');
    expect(btn).toHaveAttribute('aria-label', 'Settings');
  });

  it('the 5 secondary buttons wrap their text label in a "hidden 2xl:inline" span', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    for (const testId of ['validate-btn', 'auto-layout-btn', 'preview-toggle-btn', 'json-view-btn', 'run-force-btn']) {
      const btn = screen.getByTestId(testId);
      // Avoid a CSS-selector query (the class name's `2xl:inline` needs
      // escaping there) — walk the button's own <span> children instead.
      const hiddenLabel = Array.from(btn.querySelectorAll('span')).find(
        (el) => el.classList.contains('hidden') && el.classList.contains('2xl:inline'),
      );
      expect(hiddenLabel, `${testId} should have a hidden-below-2xl label span`).not.toBeUndefined();
      expect(hiddenLabel?.textContent).not.toBe('');
    }
  });

  it('the workflow-name input shrinks below 2xl and grows from 2xl up', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    const input = screen.getByLabelText('Tên workflow');
    expect(input.className).toContain('w-40');
    expect(input.className).toContain('2xl:w-64');
  });

  it('▶ Run (the primary button) keeps its full label at every width — only the secondary buttons collapse', () => {
    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    expect(screen.getByTestId('run-btn')).toHaveTextContent('▶ Run');
  });
});

describe('Toolbar — SPEC-step31.md §F5 (cost popover list scrolls, footer stays outside it)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore(baseWorkflow);
  });

  it('a 30-node estimate renders the list with max-h-[50vh]/overflow-y-auto and the "Tổng" footer still renders', async () => {
    const estimate: CostEstimate = {
      totalUsd: 4.65,
      unknownCount: 0,
      nodes: Array.from({ length: 30 }, (_, i) => ({
        nodeId: `img${i + 1}`,
        type: 'fal.image',
        usd: 0.1,
        basis: 'per image, ước lượng theo catalog model đã chọn cho node này',
      })),
      disclaimer: 'Ước tính tham khảo theo catalog, chưa tính cache hit/retry.',
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/estimate') return Promise.resolve(jsonResponse(estimate));
      return Promise.resolve(jsonResponse({ ok: true, issues: [] }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<Toolbar onOpenJsonView={noop} onOpenSettings={noop} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    fireEvent.click(screen.getByTestId('cost-estimate'));

    const list = screen.getByRole('list');
    expect(list.className).toContain('max-h-[50vh]');
    expect(list.className).toContain('overflow-y-auto');
    expect(screen.getByText(/Tổng: ~\$4\.65/)).toBeInTheDocument();
    // the footer paragraphs are DOM siblings of the scrollable <ul>, not
    // nested inside it — i.e. they are never part of the clipped area.
    expect(list.contains(screen.getByText(/Tổng: ~\$4\.65/))).toBe(false);
  });
});
