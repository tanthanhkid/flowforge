/**
 * ui/Toast.tsx (SPEC-step27.md §6): `toast()` queues a toast the mounted
 * `<ToastHost/>` renders; each auto-dismisses after 4s; `info`/`error`
 * variants render distinct chrome.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToastStore, ToastHost } from '../src/ui/Toast.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

describe('ToastHost', () => {
  it('renders nothing when there are no toasts', () => {
    render(<ToastHost />);
    expect(screen.queryByTestId('toast-host')).not.toBeInTheDocument();
  });

  it('toast() queues a message the host renders, with the right variant', () => {
    render(<ToastHost />);
    act(() => toast('Đã lưu', 'info'));

    const shown = screen.getByTestId('toast');
    expect(shown).toHaveTextContent('Đã lưu');
    expect(shown).toHaveAttribute('data-variant', 'info');
  });

  it('defaults to the "info" variant when none is passed', () => {
    render(<ToastHost />);
    act(() => toast('Không có variant'));
    expect(screen.getByTestId('toast')).toHaveAttribute('data-variant', 'info');
  });

  it('an "error" toast gets the error variant', () => {
    render(<ToastHost />);
    act(() => toast('Lỗi rồi', 'error'));
    expect(screen.getByTestId('toast')).toHaveAttribute('data-variant', 'error');
  });

  it('stacks multiple toasts in order', () => {
    render(<ToastHost />);
    act(() => {
      toast('Thứ nhất');
      toast('Thứ hai');
    });
    const shown = screen.getAllByTestId('toast');
    expect(shown).toHaveLength(2);
    expect(shown[0]).toHaveTextContent('Thứ nhất');
    expect(shown[1]).toHaveTextContent('Thứ hai');
  });

  it('auto-dismisses after 4s', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => toast('Sẽ biến mất'));
    expect(screen.getByTestId('toast')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('a manual close (✕) dismisses the toast immediately', () => {
    render(<ToastHost />);
    act(() => toast('Đóng tay'));
    act(() => screen.getByRole('button', { name: 'Đóng thông báo' }).click());
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});
