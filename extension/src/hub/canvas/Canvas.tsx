import { useRef, useState, useCallback, useEffect } from 'react';
import { Project, CanvasNode, Viewport } from '../project-store';
import { zoomAtPoint, panBy, screenToLogical, centerOnNode } from './canvas-math';
import CanvasNodeCard from './CanvasNodeCard';
import Edges from './Edges';

// Canvas: the pan/zoom/drag engine. Owns gesture state; lifts node moves and
// viewport changes up via callbacks so the project-store stays the source of
// truth. The canvas root is one transformed layer holding the edges SVG + node
// cards, so iframes never reload on pan/zoom/drag (only a CSS transform changes).

const CANVAS_EXTENT = 20000; // logical area for the edges SVG / background

interface CanvasProps {
  project: Project;
  statusByAgentId: Record<string, string>;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onSetViewport: (vp: Viewport) => void;
  onCloseNode: (nodeId: string) => void;
}

interface DragState {
  nodeId: string;
  // pointer offset within the node, in logical units
  offsetX: number;
  offsetY: number;
}

export default function Canvas({ project, statusByAgentId, onMoveNode, onSetViewport, onCloseNode }: CanvasProps) {
  const vp = project.viewport;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const panLastRef = useRef<{ x: number; y: number } | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  // Wheel zoom anchored at the cursor. Bound as a non-passive native listener so
  // preventDefault stops the page from scrolling.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = localPoint(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      onSetViewport(zoomAtPoint(vp, factor, anchor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vp, localPoint, onSetViewport]);

  // Background drag = pan. Starts only on empty canvas (not on a node header,
  // which calls startNodeDrag and stops propagation).
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPanning(true);
    panLastRef.current = { x: e.clientX, y: e.clientY };
    setFocusedNodeId(null); // clicking empty space exits focus mode
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startNodeDrag = (nodeId: string, e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const lp = screenToLogical(localPoint(e.clientX, e.clientY), vp);
    dragRef.current = { nodeId, offsetX: lp.x - node.x, offsetY: lp.y - node.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      const d = dragRef.current;
      const lp = screenToLogical(localPoint(e.clientX, e.clientY), vp);
      onMoveNode(d.nodeId, Math.round(lp.x - d.offsetX), Math.round(lp.y - d.offsetY));
      return;
    }
    if (panning && panLastRef.current) {
      const dx = e.clientX - panLastRef.current.x;
      const dy = e.clientY - panLastRef.current.y;
      panLastRef.current = { x: e.clientX, y: e.clientY };
      onSetViewport(panBy(vp, dx, dy));
    }
  };

  const endGesture = () => {
    dragRef.current = null;
    panLastRef.current = null;
    setPanning(false);
  };

  const focusNode = useCallback((nodeId: string) => {
    const node = project.nodes.find(n => n.id === nodeId);
    setFocusedNodeId(prev => {
      if (prev === nodeId) return null;
      if (node && rootRef.current) {
        const r = rootRef.current.getBoundingClientRect();
        onSetViewport(centerOnNode(node, r.width, r.height, 1));
      }
      return nodeId;
    });
  }, [project.nodes, onSetViewport]);

  // Focus-by-agent from the drawer: find the node carrying that agent id.
  useEffect(() => {
    const onFocusAgent = (e: Event) => {
      const agentId = (e as CustomEvent).detail as string;
      const node = project.nodes.find(n => n.agentId === agentId);
      if (node) focusNode(node.id);
    };
    window.addEventListener('piercode-hub-focus-agent', onFocusAgent);
    return () => window.removeEventListener('piercode-hub-focus-agent', onFocusAgent);
  }, [project.nodes, focusNode]);

  return (
    <div
      ref={rootRef}
      className="canvas-viewport"
      data-panning={panning}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerLeave={endGesture}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}
      >
        <Edges nodes={project.nodes} width={CANVAS_EXTENT} height={CANVAS_EXTENT} />
        {project.nodes.map((node: CanvasNode) => (
          <CanvasNodeCard
            key={node.id}
            node={node}
            status={node.agentId ? statusByAgentId[node.agentId] : undefined}
            focused={focusedNodeId === node.id}
            onStartDrag={startNodeDrag}
            onFocus={focusNode}
            onClose={onCloseNode}
          />
        ))}
      </div>
      {project.nodes.length === 0 && (
        <div className="canvas-empty">用上方「+ AI」添加一个主 agent</div>
      )}
    </div>
  );
}
