import { CanvasNode, DEFAULT_NODE_W, DEFAULT_NODE_H } from '../project-store';
import { PROVIDERS_BY_ID, paneSrc } from '../pane-manager';

// CanvasNodeCard: one AI node on the canvas — a resident iframe (loaded once,
// never reloaded by layout changes) inside a glassmorphic card with a status
// glow ring. In edit mode a transparent overlay swallows pointer events so canvas
// pan/drag works over the iframe; in focus mode the overlay is removed and the
// iframe is interactive 1:1.

interface CanvasNodeCardProps {
  node: CanvasNode;
  status?: string;       // agent lifecycle status for sub-agent nodes
  focused: boolean;      // this node is the focused (interactive) one
  onStartDrag: (nodeId: string, e: React.PointerEvent) => void;
  onFocus: (nodeId: string) => void;
  onClose: (nodeId: string) => void;
}

function pane(node: CanvasNode) {
  return { key: node.id, providerId: node.providerId, agentId: node.agentId };
}

export default function CanvasNodeCard({ node, status, focused, onStartDrag, onFocus, onClose }: CanvasNodeCardProps) {
  const provider = PROVIDERS_BY_ID[node.providerId];
  const w = node.w || DEFAULT_NODE_W;
  const h = node.h || DEFAULT_NODE_H;

  return (
    <div
      className="canvas-node"
      data-status={status || (node.agentId ? 'pending' : 'main')}
      data-focused={focused}
      data-agent-id={node.agentId ?? ''}
      style={{ left: node.x, top: node.y, width: w, height: h }}
    >
      {/* Header doubles as the drag handle. */}
      <div
        className="canvas-node-head"
        onPointerDown={e => onStartDrag(node.id, e)}
        onDoubleClick={() => onFocus(node.id)}
      >
        <span className="canvas-node-name">
          {provider?.label ?? node.providerId}
          {node.agentId ? <span className="canvas-node-worker"> · {node.agentId.slice(0, 10)}</span> : null}
        </span>
        <span className="canvas-node-ctrl">
          <button title={focused ? '退出聚焦' : '聚焦'} onClick={() => onFocus(node.id)}>◎</button>
          <button title="关闭" onClick={() => onClose(node.id)}>✕</button>
        </span>
      </div>

      <div className="canvas-node-body">
        <iframe className="canvas-node-frame" src={paneSrc(pane(node))} title={node.id} />
        {/* Edit-mode shield: blocks iframe interaction so canvas gestures win.
            Removed when this node is focused. */}
        {!focused && <div className="canvas-node-shield" onDoubleClick={() => onFocus(node.id)} />}
      </div>
    </div>
  );
}
