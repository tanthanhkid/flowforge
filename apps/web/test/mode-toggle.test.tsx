/**
 * ModeToggle.tsx (SPEC-step24.md §3/§6.2): 3 buttons set the canonical
 * splitRatio (1.0/0.5/0.0), the active one is highlighted according to the
 * CURRENT splitRatio (not just whichever was last clicked), and a red badge
 * appears on "Chat" specifically when a turn is streaming while the layout
 * is canvas-only.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModeToggle } from '../src/panels/ModeToggle.tsx';
import { useChatStore } from '../src/store/chat.ts';

afterEach(() => {
  cleanup();
});

function resetStore(overrides: Partial<ReturnType<typeof useChatStore.getState>> = {}): void {
  useChatStore.setState({
    splitRatio: 1,
    splitAnimating: false,
    turnState: 'idle',
    ...overrides,
  });
}

beforeEach(() => {
  resetStore();
});

describe('ModeToggle', () => {
  it('clicking "Chat" sets splitRatio to 1.0 with animate:true', () => {
    resetStore({ splitRatio: 0 });
    render(<ModeToggle />);
    fireEvent.click(screen.getByTestId('mode-chat'));
    expect(useChatStore.getState().splitRatio).toBe(1);
    expect(useChatStore.getState().splitAnimating).toBe(true);
  });

  it('clicking "Chia đôi" sets splitRatio to 0.5', () => {
    render(<ModeToggle />);
    fireEvent.click(screen.getByTestId('mode-split'));
    expect(useChatStore.getState().splitRatio).toBe(0.5);
  });

  it('clicking "Canvas" sets splitRatio to 0.0', () => {
    render(<ModeToggle />);
    fireEvent.click(screen.getByTestId('mode-canvas'));
    expect(useChatStore.getState().splitRatio).toBe(0);
  });

  it('the active button (aria-pressed) tracks the current splitRatio, not just the last click', () => {
    resetStore({ splitRatio: 0.5 });
    render(<ModeToggle />);
    expect(screen.getByTestId('mode-split')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mode-chat')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('mode-canvas')).toHaveAttribute('aria-pressed', 'false');

    // Someone else changes splitRatio directly (e.g. a divider drag) —
    // ModeToggle must reflect it without needing its own click.
    act(() => {
      useChatStore.getState().setSplitRatio(0);
    });
    expect(screen.getByTestId('mode-canvas')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mode-split')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a red badge on "Chat" when streaming AND the layout is canvas-only', () => {
    resetStore({ splitRatio: 0, turnState: 'streaming' });
    render(<ModeToggle />);
    expect(screen.getByTestId('mode-chat-badge')).toBeInTheDocument();
  });

  it('does not show the badge when streaming but NOT canvas-only', () => {
    resetStore({ splitRatio: 0.5, turnState: 'streaming' });
    render(<ModeToggle />);
    expect(screen.queryByTestId('mode-chat-badge')).not.toBeInTheDocument();
  });

  it('does not show the badge when canvas-only but idle', () => {
    resetStore({ splitRatio: 0, turnState: 'idle' });
    render(<ModeToggle />);
    expect(screen.queryByTestId('mode-chat-badge')).not.toBeInTheDocument();
  });
});
