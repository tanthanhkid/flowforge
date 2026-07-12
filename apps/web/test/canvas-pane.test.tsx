/**
 * CanvasPane.tsx (SPEC-step24.md §4/§6.3): always mounted regardless of
 * `splitRatio` — hidden via `visibility: hidden` (never unmounted, so React
 * Flow's own instance survives a mode switch instead of remounting) — and
 * calls `requestFitView()` exactly on the transition from hidden back to
 * visible, not on every splitRatio change and not on an already-visible
 * mount.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasPane } from '../src/panels/CanvasPane.tsx';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useChatStore.setState({ splitRatio: 1, splitAnimating: false });
  useFlowStore.setState({
    workflow: { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] },
    selectedNodeId: null,
    registry: [],
    rightTab: 'params',
    fitViewNonce: 0,
  });
});

describe('CanvasPane', () => {
  it('is always mounted — even at splitRatio 1.0 (chat-only) — but visibility: hidden', () => {
    render(<CanvasPane />);
    const pane = screen.getByTestId('canvas-pane');
    expect(pane).toBeInTheDocument();
    expect(pane).toHaveStyle({ visibility: 'hidden' });
    // The right-panel (part of this same always-mounted subtree) is present too.
    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
  });

  it('becomes visible and calls requestFitView() once splitRatio moves out of chat-only', () => {
    render(<CanvasPane />);
    expect(screen.getByTestId('canvas-pane')).toHaveStyle({ visibility: 'hidden' });
    expect(useFlowStore.getState().fitViewNonce).toBe(0);

    act(() => {
      useChatStore.getState().setSplitRatio(0.5);
    });

    expect(screen.getByTestId('canvas-pane')).toHaveStyle({ visibility: 'visible' });
    expect(useFlowStore.getState().fitViewNonce).toBe(1);
  });

  it('does NOT call requestFitView again on a splitRatio change that stays visible', () => {
    useChatStore.setState({ splitRatio: 0.5 });
    render(<CanvasPane />);
    expect(useFlowStore.getState().fitViewNonce).toBe(0);

    act(() => {
      useChatStore.getState().setSplitRatio(0.7);
    });

    expect(screen.getByTestId('canvas-pane')).toHaveStyle({ visibility: 'visible' });
    expect(useFlowStore.getState().fitViewNonce).toBe(0);
  });

  it('does NOT call requestFitView on a mount that is already visible', () => {
    useChatStore.setState({ splitRatio: 0.5 });
    render(<CanvasPane />);
    expect(useFlowStore.getState().fitViewNonce).toBe(0);
  });

  it('hides again (visibility: hidden) when splitRatio returns to chat-only', () => {
    useChatStore.setState({ splitRatio: 0.5 });
    render(<CanvasPane />);
    expect(screen.getByTestId('canvas-pane')).toHaveStyle({ visibility: 'visible' });

    act(() => {
      useChatStore.getState().setSplitRatio(1);
    });

    expect(screen.getByTestId('canvas-pane')).toHaveStyle({ visibility: 'hidden' });
  });
});
