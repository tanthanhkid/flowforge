/**
 * panels/CutPlanReview.tsx (SPEC-step33.md §33e-1): renders the pending
 * `CutPlan`'s moments editable, deleting a moment drops it from what gets
 * submitted, "Duyệt & cắt" resumes with the (possibly edited) plan, "Huỷ"
 * stops the run, and an inline error surfaces on a rejected resume.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import type { CutPlan, Workflow } from '../src/api/types.ts';

// Imported after vi.mock (hoisted above these imports by Vitest).
import { CutPlanReview } from '../src/panels/CutPlanReview.tsx';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
});

const workflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] };

const plan: CutPlan = {
  moments: [
    { id: 'm1', start: 0, end: 5, title: 'Đoạn mở đầu', brollPrompt: 'a cat' },
    { id: 'm2', start: 10, end: 15, title: 'Đoạn kết' },
  ],
};

function resetStore(): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    awaitingGate: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('CutPlanReview', () => {
  it('renders nothing when there is no pending gate', () => {
    render(<CutPlanReview />);
    expect(screen.queryByTestId('cutplan-review')).toBeNull();
  });

  it('renders every moment with its editable fields', () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan } });
    render(<CutPlanReview />);

    expect(screen.getByTestId('cutplan-review')).toBeTruthy();
    expect(screen.getByTestId('cutplan-moment-m1')).toBeTruthy();
    expect(screen.getByTestId('cutplan-moment-m2')).toBeTruthy();
    expect(screen.getByTestId('cutplan-title-m1')).toHaveValue('Đoạn mở đầu');
    expect(screen.getByTestId('cutplan-start-m1')).toHaveValue(0);
    expect(screen.getByTestId('cutplan-end-m1')).toHaveValue(5);
    expect(screen.getByTestId('cutplan-broll-m1')).toHaveValue('a cat');
  });

  it('edits a field and deletes a moment, then submits only what remains', async () => {
    const resumeAwaiting = vi.fn().mockResolvedValue(undefined);
    useFlowStore.setState({
      awaitingGate: { runId: 'run1', nodeId: 'gate1', plan },
      resumeAwaiting,
    });
    render(<CutPlanReview />);

    fireEvent.change(screen.getByTestId('cutplan-title-m1'), { target: { value: 'Tiêu đề mới' } });
    fireEvent.change(screen.getByTestId('cutplan-end-m1'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('cutplan-delete-m2'));

    expect(screen.queryByTestId('cutplan-moment-m2')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cutplan-approve'));
    });

    expect(resumeAwaiting).toHaveBeenCalledWith({
      moments: [{ id: 'm1', start: 0, end: 8, title: 'Tiêu đề mới', brollPrompt: 'a cat' }],
    });
  });

  it('shows an inline error when resumeAwaiting rejects', async () => {
    const resumeAwaiting = vi.fn().mockRejectedValue(new Error('output không hợp lệ'));
    useFlowStore.setState({
      awaitingGate: { runId: 'run1', nodeId: 'gate1', plan },
      resumeAwaiting,
    });
    render(<CutPlanReview />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('cutplan-approve'));
    });

    expect(screen.getByText('output không hợp lệ')).toBeTruthy();
  });

  it('"Huỷ" calls cancelAwaiting', async () => {
    const cancelAwaiting = vi.fn().mockResolvedValue(undefined);
    useFlowStore.setState({
      awaitingGate: { runId: 'run1', nodeId: 'gate1', plan },
      cancelAwaiting,
    });
    render(<CutPlanReview />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('cutplan-cancel'));
    });

    expect(cancelAwaiting).toHaveBeenCalled();
  });

  // Post-review fix (LOW/MED) — client-side validation: end<=start.
  it('disables "Duyệt & cắt" and blocks submit when end <= start', async () => {
    const resumeAwaiting = vi.fn().mockResolvedValue(undefined);
    useFlowStore.setState({
      awaitingGate: { runId: 'run1', nodeId: 'gate1', plan },
      resumeAwaiting,
    });
    render(<CutPlanReview />);

    fireEvent.change(screen.getByTestId('cutplan-end-m1'), { target: { value: '0' } }); // end (0) == start (0)

    expect(screen.getByTestId('cutplan-approve')).toBeDisabled();

    // Belt-and-suspenders: even a direct click must not call through.
    fireEvent.click(screen.getByTestId('cutplan-approve'));
    expect(resumeAwaiting).not.toHaveBeenCalled();
  });

  it('disables "Duyệt & cắt" once every moment has been deleted', () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan } });
    render(<CutPlanReview />);

    fireEvent.click(screen.getByTestId('cutplan-delete-m1'));
    fireEvent.click(screen.getByTestId('cutplan-delete-m2'));

    expect(screen.getByTestId('cutplan-approve')).toBeDisabled();
  });

  // Post-review fix (LOW/MED) — issue-aware error message.
  it('surfaces per-issue messages from a 400 ApiError instead of only the generic string', async () => {
    const resumeAwaiting = vi
      .fn()
      .mockRejectedValue(
        new ApiError(400, 'output không hợp lệ (không đúng CutPlan)', [
          { code: 'custom', message: "CutMoment: 'end' phải lớn hơn 'start'." },
        ]),
      );
    useFlowStore.setState({
      awaitingGate: { runId: 'run1', nodeId: 'gate1', plan },
      resumeAwaiting,
    });
    render(<CutPlanReview />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('cutplan-approve'));
    });

    expect(screen.getByText("CutMoment: 'end' phải lớn hơn 'start'.")).toBeTruthy();
    expect(screen.queryByText('output không hợp lệ (không đúng CutPlan)')).toBeNull();
  });

  // Post-review fix (LOW) — clearing a numeric field must not snap back to
  // its old value, so the user can actually retype into it.
  it('lets a numeric field be cleared and retyped without snapping back', () => {
    useFlowStore.setState({ awaitingGate: { runId: 'run1', nodeId: 'gate1', plan } });
    render(<CutPlanReview />);

    const startField = screen.getByTestId('cutplan-start-m1');
    fireEvent.change(startField, { target: { value: '' } });
    expect(startField).toHaveValue(null);

    fireEvent.change(startField, { target: { value: '2' } });
    expect(startField).toHaveValue(2);
  });
});
