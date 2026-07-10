/**
 * React Flow canvas (SPEC-step4.md §2/§3/§4): nodes/edges are *derived* from
 * the store's workflow JSON (single source of truth) on every render, not
 * owned as separate React Flow state. Position drags, connects, deletes and
 * sidebar DnD all write back into the store, which re-derives nodes/edges.
 */
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState, type DragEvent } from 'react';
import type { NodeSpec, PortType } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { NodeCard } from './NodeCard.tsx';
import { compatible, PORT_COLORS } from './portColors.ts';
import { NODE_DRAG_TYPE, type FlowNode } from './types.ts';

const nodeTypes = { flowforge: NodeCard };

function FlowCanvasInner() {
  const workflow = useFlowStore((s) => s.workflow);
  const registry = useFlowStore((s) => s.registry);
  const nodeRuns = useFlowStore((s) => s.nodeRuns);
  const selectedNodeId = useFlowStore((s) => s.selectedNodeId);
  const selectNode = useFlowStore((s) => s.selectNode);
  const updateNodePosition = useFlowStore((s) => s.updateNodePosition);
  const removeNode = useFlowStore((s) => s.removeNode);
  const removeEdge = useFlowStore((s) => s.removeEdge);
  const addEdge = useFlowStore((s) => s.addEdge);
  const addNode = useFlowStore((s) => s.addNode);

  const { screenToFlowPosition } = useReactFlow();

  // React Flow is fully controlled here (edges prop, no defaultEdges), so
  // selection state must be round-tripped by hand: onEdgesChange only
  // *emits* `select` changes, it never applies them — without this, clicking
  // an edge never marks it `selected`, so the deleteKeyCode handler (which
  // only deletes selected elements) can never emit a `remove` change for it
  // and edges become permanently undeletable from the canvas.
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(() => new Set());

  const specByType = useMemo(() => {
    const map = new Map<string, NodeSpec>();
    for (const spec of registry) map.set(spec.type, spec);
    return map;
  }, [registry]);

  const nodes: FlowNode[] = useMemo(
    () =>
      workflow.nodes.map((n) => ({
        id: n.id,
        type: 'flowforge',
        position: n.position ?? { x: 0, y: 0 },
        selected: n.id === selectedNodeId,
        data: { node: n, spec: specByType.get(n.type), runState: nodeRuns[n.id] },
      })),
    [workflow.nodes, specByType, nodeRuns, selectedNodeId],
  );

  const edges: Edge[] = useMemo(
    () =>
      workflow.edges.map((e) => {
        const fromNode = workflow.nodes.find((n) => n.id === e.from.node);
        const fromSpec = fromNode ? specByType.get(fromNode.type) : undefined;
        const portType: PortType = fromSpec?.outputs[e.from.port]?.type ?? 'any';
        return {
          id: e.id,
          source: e.from.node,
          sourceHandle: e.from.port,
          target: e.to.node,
          targetHandle: e.to.port,
          selected: selectedEdgeIds.has(e.id),
          style: { stroke: PORT_COLORS[portType], strokeWidth: 2 },
        };
      }),
    [workflow.edges, workflow.nodes, specByType, selectedEdgeIds],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateNodePosition(change.id, change.position);
        } else if (change.type === 'remove') {
          removeNode(change.id);
        } else if (change.type === 'select') {
          if (change.selected) {
            selectNode(change.id);
          } else if (selectedNodeId === change.id) {
            // Symmetric deselection: React Flow emits `selected: false` for
            // the previously-selected node when selection moves elsewhere
            // (or is cleared) — without applying it back, selectedNodeId
            // could stay pointed at a node React Flow no longer considers
            // selected.
            selectNode(null);
          }
        }
      }
    },
    [updateNodePosition, removeNode, selectNode, selectedNodeId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') {
          removeEdge(change.id);
        } else if (change.type === 'select') {
          setSelectedEdgeIds((prev) => {
            const next = new Set(prev);
            if (change.selected) next.add(change.id);
            else next.delete(change.id);
            return next;
          });
        }
      }
    },
    [removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return;
      addEdge(
        { node: connection.source, port: connection.sourceHandle },
        { node: connection.target, port: connection.targetHandle },
      );
    },
    [addEdge],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (conn) => {
      const { source, target, sourceHandle, targetHandle } = conn;
      if (!source || !target || !sourceHandle || !targetHandle) return false;
      const fromNode = workflow.nodes.find((n) => n.id === source);
      const toNode = workflow.nodes.find((n) => n.id === target);
      if (!fromNode || !toNode) return false;
      const outPort = specByType.get(fromNode.type)?.outputs[sourceHandle];
      const inPort = specByType.get(toNode.type)?.inputs[targetHandle];
      if (!outPort || !inPort) return false;
      if (!compatible(outPort.type, inPort.type)) return false;
      return !workflow.edges.some((e) => e.to.node === target && e.to.port === targetHandle);
    },
    [workflow, specByType],
  );

  const onNodeClick = useCallback<NodeMouseHandler<FlowNode>>(
    (_event, node) => {
      selectNode(node.id);
    },
    [selectNode],
  );

  const onPaneClick = useCallback(() => {
    selectNode(null);
    setSelectedEdgeIds(new Set());
  }, [selectNode]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(NODE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const type = event.dataTransfer.getData(NODE_DRAG_TYPE);
      if (!type) return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(type, position);
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <div className="h-full w-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}
