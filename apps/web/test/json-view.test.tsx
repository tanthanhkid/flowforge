/**
 * SPEC-step6.md §2 — JsonView.tsx: apply valid JSON updates the store,
 * broken JSON shows an inline error without touching the store, and Reset
 * reverts the draft back to the store's current workflow.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '../src/api/types.ts';
import { JsonView } from '../src/panels/JsonView.tsx';
import { useFlowStore } from '../src/store/flow.ts';

afterEach(() => {
  cleanup();
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
  });
}

describe('JsonView', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, issues: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetStore(baseWorkflow);
  });

  it('renders the current workflow as pretty-printed JSON', () => {
    render(<JsonView onClose={() => {}} />);
    const textarea = screen.getByLabelText('workflow json') as HTMLTextAreaElement;
    expect(textarea.value).toBe(JSON.stringify(baseWorkflow, null, 2));
  });

  it('Apply with valid JSON updates the store and does not show a parse error', async () => {
    render(<JsonView onClose={() => {}} />);
    const textarea = screen.getByLabelText('workflow json') as HTMLTextAreaElement;
    const updated: Workflow = { ...baseWorkflow, name: 'Renamed' };
    fireEvent.change(textarea, { target: { value: JSON.stringify(updated, null, 2) } });

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(useFlowStore.getState().workflow.name).toBe('Renamed');
    });
    expect(useFlowStore.getState().dirty).toBe(true);
    expect(textarea.className).not.toMatch(/border-red-500/);
  });

  it('Apply with broken JSON shows an inline error and leaves the store untouched', async () => {
    render(<JsonView onClose={() => {}} />);
    const textarea = screen.getByLabelText('workflow json') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{ this is not json' } });

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(textarea.className).toMatch(/border-red-500/);
      expect(document.querySelector('p.text-red-600')).not.toBeNull();
    });
    expect(useFlowStore.getState().workflow).toEqual(baseWorkflow);
    expect(useFlowStore.getState().dirty).toBe(false);
  });

  it('Reset reverts the draft back to the store workflow', () => {
    render(<JsonView onClose={() => {}} />);
    const textarea = screen.getByLabelText('workflow json') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'garbage' } });
    expect(textarea.value).toBe('garbage');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(textarea.value).toBe(JSON.stringify(baseWorkflow, null, 2));
  });
});
