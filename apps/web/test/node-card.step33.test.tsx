/**
 * canvas/NodeCard.tsx (SPEC-step33.md §33e-1): the footer status chip shows
 * "chờ duyệt" for the new `'awaiting'` NodeState (a node paused mid-run on
 * a human CutPlan-review gate). Kept in its own file (mirrors
 * flow-store.step33.test.ts) rather than extending test/node-card.test.tsx.
 */
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeSpec, WorkflowNode } from '../src/api/types.ts';
import { NodeCard } from '../src/canvas/NodeCard.tsx';
import type { FlowNode, FlowNodeData } from '../src/canvas/types.ts';

afterEach(() => {
  cleanup();
});

const spec: NodeSpec = {
  type: 'video.selectMoments',
  category: 'llm',
  title: 'Chọn đoạn cắt',
  inputs: { transcript: { type: 'json', required: true } },
  outputs: { plan: { type: 'json' } },
  paramsJsonSchema: { type: 'object', properties: {} },
};

const workflowNode: WorkflowNode = { id: 'n1', type: 'video.selectMoments', params: {}, position: { x: 0, y: 0 } };

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

describe('NodeCard — awaiting state', () => {
  it('shows the "chờ duyệt" footer badge', () => {
    renderNode({ node: workflowNode, spec, runState: { state: 'awaiting', logs: [] } });
    expect(screen.getByText('chờ duyệt')).toBeInTheDocument();
  });
});
