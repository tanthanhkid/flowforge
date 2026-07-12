/**
 * SPEC-step5.md §7 — agent-ui.test.tsx.
 * NodeCard's "✨" node edit popover (edit-node), against a mocked `fetch`.
 *
 * SPEC-step24.md §5 removed Toolbar's "✨ Describe" panel (generate-workflow
 * moved to the chat pane — see test/chat-pane.test.tsx's landing-hero
 * coverage) — this file used to also cover that panel; only the NodeCard
 * edit-node popover (explicitly kept unchanged by that spec) remains here.
 */
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSpec, Workflow, WorkflowNode } from '../src/api/types.ts';
import { NodeCard } from '../src/canvas/NodeCard.tsx';
import { useFlowStore } from '../src/store/flow.ts';
import type { FlowNode, FlowNodeData } from '../src/canvas/types.ts';

afterEach(() => {
  cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function resetStore(workflow: Workflow, registry: NodeSpec[] = []): void {
  useFlowStore.setState({
    workflow,
    selectedNodeId: null,
    registry,
    runId: undefined,
    runStatus: undefined,
    nodeRuns: {},
    dirty: false,
    validationIssues: [],
    forceNodeIds: [],
  });
}

describe('NodeCard ✨ edit-node popover', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const spec: NodeSpec = {
    type: 'llm.generate',
    category: 'llm',
    title: 'LLM generate',
    inputs: { prompt: { type: 'text', required: true } },
    outputs: { text: { type: 'text' } },
    paramsJsonSchema: { type: 'object', properties: {} },
  };
  const workflowNode: WorkflowNode = { id: 'n1', type: 'llm.generate', params: {}, position: { x: 0, y: 0 } };
  const workflow: Workflow = { version: 1, id: 'wf1', name: 'Test', nodes: [workflowNode], edges: [] };

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetStore(workflow, [spec]);
  });

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

  it('sends the current workflow + nodeId + instruction to /api/agent/edit-node and applies the patched workflow', async () => {
    const patched: Workflow = {
      ...workflow,
      nodes: [{ ...workflowNode, params: { temperature: 0.9 } }],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ workflow: patched, ops: [], attempts: 1 }));

    renderNode({ node: workflowNode, spec, runState: undefined });

    fireEvent.click(screen.getByTitle('Edit this node with AI'));
    fireEvent.change(screen.getByPlaceholderText('Mô tả thay đổi bạn muốn…'), {
      target: { value: 'increase temperature' },
    });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(useFlowStore.getState().workflow.nodes[0]?.params).toEqual({ temperature: 0.9 }));

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('/api/agent/edit-node');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ nodeId: 'n1', instruction: 'increase temperature' });
    expect(body.workflow).toEqual(workflow);
  });

  it('shows the error message in the popover on failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 502));

    renderNode({ node: workflowNode, spec, runState: undefined });

    fireEvent.click(screen.getByTitle('Edit this node with AI'));
    fireEvent.change(screen.getByPlaceholderText('Mô tả thay đổi bạn muốn…'), {
      target: { value: 'do something' },
    });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
