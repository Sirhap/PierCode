import { CanvasNode } from '../project-store';
import { edgePath } from './canvas-math';

// Edges: the glowing SVG wires between parent and child nodes. Rendered inside
// the canvas transform so the paths live in logical coordinates and pan/zoom with
// the nodes. Pointer-events off so the wires never block node interaction.

interface EdgesProps {
  nodes: CanvasNode[];
  width: number;  // logical canvas extent (large fixed area)
  height: number;
}

export default function Edges({ nodes, width, height }: EdgesProps) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = nodes
    .filter(n => n.parentNodeId && byId.has(n.parentNodeId))
    .map(n => ({ id: n.id, d: edgePath(byId.get(n.parentNodeId!)!, n) }));

  return (
    <svg
      className="canvas-edges"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="edgeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#89b4fa" />
          <stop offset="100%" stopColor="#cba6f7" />
        </linearGradient>
        <filter id="edgeGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {edges.map(e => (
        <path
          key={e.id}
          d={e.d}
          fill="none"
          stroke="url(#edgeGrad)"
          strokeWidth={2}
          strokeDasharray="6 6"
          filter="url(#edgeGlow)"
          className="canvas-edge-path"
        />
      ))}
    </svg>
  );
}
