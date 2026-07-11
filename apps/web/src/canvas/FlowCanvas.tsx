/**
 * React Flow canvas (SPEC-step4.md §2/§3/§4): nodes/edges are *derived* from
 * the store's workflow JSON (single source of truth) on every render, not
 * owned as separate React Flow state. Position drags, connects, deletes and
 * sidebar DnD all write back into the store, which re-derives nodes/edges.
 *
 * SPEC-step18.md §5.4 (neo-brutalist pass): dotted cream/black `Background`,
 * the custom `BrutalEdge` (black outline + colored top layer, dashed while
 * flowing into a `running` node — see BrutalEdge.tsx), a `MiniMap` colored
 * by node category (previously uncustomized — spec's fix #2, "minimap vô
 * hình"), an onboarding overlay on an empty canvas (fix #1) that opens the
 * Toolbar's ✨ Describe panel, and a `fitViewNonce` listener (fix #3, store
 * §4) so the 🪄 Sắp xếp button can re-center the view after laying out.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { NodeSpec, PortType } from '../api/types.ts';
import { useFlowStore } from '../store/flow.ts';
import { Button } from '../ui/Button.tsx';
import { BrutalEdge, type BrutalEdgeType } from './BrutalEdge.tsx';
import { categoryHex } from './categoryColors.ts';
import { FALLBACK_NODE_HEIGHT, FALLBACK_NODE_WIDTH } from './layout.ts';
import { NodeCard } from './NodeCard.tsx';
import { compatible, PORT_COLORS } from './portColors.ts';
import { NODE_DRAG_TYPE, type FlowNode } from './types.ts';

const nodeTypes = { flowforge: NodeCard };
const edgeTypes = { brutal: BrutalEdge };

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
  const fitViewNonce = useFlowStore((s) => s.fitViewNonce);
  // SPEC-step18.md §7.1 (post-review fix): calls the store's idempotent
  // "make sure it's open" action, not Toolbar's own toggle — previously this
  // DOM-clicked Toolbar's toggle button directly, so clicking this CTA while
  // the user had already opened Describe from the Toolbar silently closed it.
  const openDescribe = useFlowStore((s) => s.openDescribe);
  const nodeSizes = useFlowStore((s) => s.nodeSizes);

  const { screenToFlowPosition, fitView } = useReactFlow();

  // React Flow is fully controlled here (edges prop, no defaultEdges), so
  // selection state must be round-tripped by hand: onEdgesChange only
  // *emits* `select` changes, it never applies them — without this, clicking
  // an edge never marks it `selected`, so the deleteKeyCode handler (which
  // only deletes selected elements) can never emit a `remove` change for it
  // and edges become permanently undeletable from the canvas.
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(() => new Set());

  // SPEC-step18.md §4/§7 fix #3: 🪄 Sắp xếp (store.autoLayout) bumps this
  // nonce; re-center the viewport once it changes.
  useEffect(() => {
    if (fitViewNonce === 0) return;
    fitView({ padding: 0.15, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitViewNonce]);

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
        // SPEC-step18.md §5.4 fix #2 (post-review): React Flow's <MiniMap>
        // only draws a node once `nodeHasDimensions()` is true for the *raw
        // user node* object we hand it here — it reads `measured ?? width ??
        // initialWidth` off this exact object, not off React Flow's own
        // internally-measured copy (that copy is kept in a separate internal
        // lookup the minimap doesn't consult). Without these two fields the
        // minimap silently renders 0 nodes forever, regardless of how many
        // nodes are actually on the canvas. `initialWidth`/`initialHeight`
        // (rather than `width`/`height`) is deliberate: React Flow only
        // consults them as a *pre-measurement* placeholder for the real
        // node's inline size (see `getNodeInlineStyleDimensions`) — once the
        // node's own ResizeObserver reports real `handleBounds`, these are
        // ignored in favor of the actual rendered size, so they can never
        // freeze a node at a stale size the way `width`/`height` would.
        // `nodeSizes` (already populated by `onNodesChange`'s dimension
        // tracking, SPEC-step16.md §2) gives the *real* measured size once
        // available; otherwise this falls back to NodeCard's nominal box.
        initialWidth: nodeSizes[n.id]?.width ?? FALLBACK_NODE_WIDTH,
        initialHeight: nodeSizes[n.id]?.height ?? FALLBACK_NODE_HEIGHT,
      })),
    [workflow.nodes, specByType, nodeRuns, selectedNodeId, nodeSizes],
  );

  const edges: BrutalEdgeType[] = useMemo(
    () =>
      workflow.edges.map((e) => {
        const fromNode = workflow.nodes.find((n) => n.id === e.from.node);
        const fromSpec = fromNode ? specByType.get(fromNode.type) : undefined;
        const portType: PortType = fromSpec?.outputs[e.from.port]?.type ?? 'any';
        return {
          id: e.id,
          type: 'brutal',
          source: e.from.node,
          sourceHandle: e.from.port,
          target: e.to.node,
          targetHandle: e.to.port,
          selected: selectedEdgeIds.has(e.id),
          markerEnd: { type: MarkerType.ArrowClosed, color: '#0D0D0D', width: 18, height: 18 },
          data: { color: PORT_COLORS[portType], targetRunning: nodeRuns[e.to.node]?.state === 'running' },
        };
      }),
    [workflow.edges, workflow.nodes, specByType, selectedEdgeIds, nodeRuns],
  );

  const setNodeSizes = useFlowStore((s) => s.setNodeSizes);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // SPEC-step16.md §2/§3: React Flow reports each node's real rendered
      // box size via `dimensions` changes as it measures/re-measures nodes
      // (on mount, and whenever content like a preview toggles change a
      // node's height) — mirror the latest size for every changed node into
      // the store so `autoLayout()` can lay out using real sizes instead of
      // always falling back to NodeCard's nominal 300x200.
      const dimensionChanges = changes.filter(
        (c): c is Extract<NodeChange<FlowNode>, { type: 'dimensions' }> =>
          c.type === 'dimensions' && c.dimensions !== undefined,
      );
      if (dimensionChanges.length > 0) {
        const current = useFlowStore.getState().nodeSizes;
        let changed = false;
        const next = { ...current };
        for (const change of dimensionChanges) {
          const { width, height } = change.dimensions!;
          const existing = next[change.id];
          if (existing?.width !== width || existing?.height !== height) {
            next[change.id] = { width, height };
            changed = true;
          }
        }
        // SPEC-step18.md §5.4 fix #2 (post-review): `nodes` (below) now also
        // *reads* `nodeSizes` (for the MiniMap's `initialWidth`/
        // `initialHeight`), so writing a new object here on every dimension
        // event — even a no-op one reporting the exact same size RF already
        // has — would otherwise recreate every node object every time,
        // resetting React Flow's own internal `measured`/`handleBounds`
        // bookkeeping for no reason. Only write when a size actually changed.
        if (changed) setNodeSizes(next);
      }

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
    [updateNodePosition, removeNode, selectNode, selectedNodeId, setNodeSizes],
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
    <div className="relative h-full w-full bg-bg" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        // SPEC-step18.md §8b.2 (user request 11-07-2026): touchpad 2-finger
        // scroll pans the canvas freely in any direction (Figma-style), on
        // top of the default click-drag pan and pinch/Ctrl+scroll zoom —
        // `Free` (vs. the default vertical-only) lets a horizontal scroll
        // gesture pan sideways too.
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#0D0D0D" style={{ opacity: 0.13 }} />
        <Controls />
        <MiniMap<FlowNode>
          pannable
          zoomable
          nodeColor={(node) => categoryHex(node.data.spec?.category ?? '')}
          maskColor="rgba(0,0,0,.5)"
          style={{ border: '3px solid #0D0D0D', background: '#FFFFFF' }}
        />
      </ReactFlow>

      {workflow.nodes.length === 0 && (
        // Spec §5.4: "Overlay pointer-events: none trừ nút" — only the ✨
        // Describe button itself should intercept clicks; everything else
        // (the card, its text) stays click-through to the canvas below.
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 border-2 border-dashed border-ink bg-paper/90 p-6 text-center shadow-hard-5">
            <p className="font-display text-sm uppercase tracking-wide text-ink">
              ✨ Mô tả workflow bằng lời — để AI dựng cho bạn
            </p>
            <span className="pointer-events-auto inline-flex">
              <Button data-testid="empty-canvas-cta" variant="ai" onClick={openDescribe}>
                ✨ Describe
              </Button>
            </span>
            <p className="font-mono-data text-[11px] text-ink-soft">hoặc kéo node từ sidebar trái</p>
          </div>
        </div>
      )}
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
