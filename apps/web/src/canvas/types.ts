/**
 * Shared React Flow node-data shape (SPEC-step4.md §2/§3 "Mapping React
 * Flow"). Lives in its own module so FlowCanvas.tsx and NodeCard.tsx can
 * both import it without a circular dependency between them.
 */
import type { Node } from '@xyflow/react';
import type { NodeSpec, WorkflowNode } from '../api/types.ts';
import type { NodeRunUiState } from '../store/flow.ts';

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  spec: NodeSpec | undefined;
  runState: NodeRunUiState | undefined;
}

export type FlowNode = Node<FlowNodeData, 'flowforge'>;

/** DataTransfer type key used by Sidebar (drag source) and FlowCanvas (drop target). */
export const NODE_DRAG_TYPE = 'application/flowforge-node-type';
