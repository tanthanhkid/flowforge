/**
 * panels/HistoryPanel.tsx (SPEC-step27.md §5): renders rows newest-first with
 * the right source icon/summary/relative time (+ a scope badge for
 * cosmetic), the cosmetic toggle re-fetches with `includeCosmetic`, the
 * revert flow (confirm -> API -> adoptWorkflow + toast), disabling revert
 * while an AI turn is streaming, and the empty state.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowChangeSummary } from '../src/api/types.ts';

vi.mock('../src/api/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.ts')>();
  return { ...actual, listChanges: vi.fn(), revertChange: vi.fn() };
});

vi.mock('../src/ui/Toast.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/Toast.tsx')>();
  return { ...actual, toast: vi.fn() };
});

// Imported after vi.mock (hoisted above these imports by Vitest).
import * as api from '../src/api/client.ts';
import { HistoryPanel } from '../src/panels/HistoryPanel.tsx';
import { useChatStore } from '../src/store/chat.ts';
import { useFlowStore } from '../src/store/flow.ts';
import { toast } from '../src/ui/Toast.tsx';

afterEach(() => {
  cleanup();
});

const workflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [], edges: [] };

function change(overrides: Partial<WorkflowChangeSummary>): WorkflowChangeSummary {
  return {
    id: 1,
    workflowId: 'wf1',
    conversationId: 'c1',
    source: 'user',
    scope: 'structural',
    ops: [],
    summary: 'thêm node input.text (n1)',
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
  });
  useChatStore.setState({ activeConversationId: 'c1', workflowVersion: 1, turnState: 'idle' });
});

describe('HistoryPanel', () => {
  it('shows the empty state when there is nothing logged', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([]);
    render(<HistoryPanel />);
    await waitFor(() => expect(screen.getByText('Chưa có thay đổi nào được ghi.')).toBeInTheDocument());
  });

  it('renders rows newest-first with the right icon/summary; a structural row has ✋, an AI row has 🤖', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([
      change({ id: 1, source: 'user', summary: 'thêm node input.text (n1)' }),
      change({ id: 2, source: 'ai', summary: 'AI: +1 node' }),
    ]);
    render(<HistoryPanel />);

    const items = await screen.findAllByTestId('history-item');
    expect(items).toHaveLength(2);
    // Server returns oldest-first (id ASC) — the panel must reverse it.
    expect(items[0]).toHaveTextContent('AI: +1 node');
    expect(items[0]).toHaveTextContent('🤖');
    expect(items[1]).toHaveTextContent('thêm node input.text (n1)');
    expect(items[1]).toHaveTextContent('✋');
  });

  it('a cosmetic row shows a scope badge and has NO revert button; a structural row does', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([
      change({ id: 1, scope: 'structural', summary: 'thêm node input.text (n1)' }),
      change({ id: 2, scope: 'cosmetic', summary: 'di chuyển node n1' }),
    ]);
    render(<HistoryPanel />);

    const items = await screen.findAllByTestId('history-item');
    // items[0] is id 2 (cosmetic, newest); items[1] is id 1 (structural).
    expect(items[0]).toHaveTextContent('vị trí');
    expect(items[0]!.querySelector('[data-testid="history-revert"]')).toBeNull();
    expect(items[1]!.querySelector('[data-testid="history-revert"]')).not.toBeNull();
  });

  it('the cosmetic toggle re-fetches with includeCosmetic=true', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([]);
    render(<HistoryPanel />);
    await waitFor(() => expect(api.listChanges).toHaveBeenCalledWith('wf1', { includeCosmetic: false }));

    act(() => screen.getByTestId('history-cosmetic-toggle').click());

    await waitFor(() => expect(api.listChanges).toHaveBeenCalledWith('wf1', { includeCosmetic: true }));
  });

  it('revert: confirm -> API -> adoptWorkflow + version + toast', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([change({ id: 5 })]);
    const restored: Workflow = { version: 1, id: 'wf1', name: 'Restored', nodes: [], edges: [] };
    vi.mocked(api.revertChange).mockResolvedValue({
      change: change({ id: 6, summary: 'Khôi phục về trước thay đổi #5' }),
      workflow: restored,
      version: 7,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<HistoryPanel />);
    const revertBtn = await screen.findByTestId('history-revert');
    await act(async () => {
      revertBtn.click();
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith('Khôi phục về trạng thái TRƯỚC thay đổi này?');
    expect(api.revertChange).toHaveBeenCalledWith('wf1', 5);
    await waitFor(() => expect(useFlowStore.getState().workflow).toEqual(restored));
    expect(useChatStore.getState().workflowVersion).toBe(7);
    expect(toast).toHaveBeenCalledWith('Đã khôi phục');
  });

  it('revert is a no-op when the confirm dialog is declined', async () => {
    vi.mocked(api.listChanges).mockResolvedValue([change({ id: 5 })]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<HistoryPanel />);
    const revertBtn = await screen.findByTestId('history-revert');
    act(() => revertBtn.click());

    expect(api.revertChange).not.toHaveBeenCalled();
  });

  it('disables the revert button (title "AI đang xử lý") while a turn is streaming', async () => {
    useChatStore.setState({ turnState: 'streaming' });
    vi.mocked(api.listChanges).mockResolvedValue([change({ id: 5 })]);

    render(<HistoryPanel />);
    const revertBtn = await screen.findByTestId('history-revert');

    expect(revertBtn).toBeDisabled();
    expect(revertBtn).toHaveAttribute('title', 'AI đang xử lý');
  });
});
