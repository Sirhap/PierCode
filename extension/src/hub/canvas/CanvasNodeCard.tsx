import { CanvasNode, DEFAULT_NODE_W, DEFAULT_NODE_H, DEFAULT_CONTENT_ZOOM, NODE_SIZE_PRESETS } from '../project-store';
import { PROVIDERS_BY_ID, paneSrc } from '../pane-manager';

// CanvasNodeCard: one AI node on the canvas — a resident iframe (loaded once,
// never reloaded by layout changes) inside a glassmorphic card with a status
// glow ring. In edit mode a transparent overlay swallows pointer events so canvas
// pan/drag works over the iframe; in focus mode the overlay is removed and the
// iframe is interactive 1:1.

interface CanvasNodeCardProps {
  node: CanvasNode;
  status?: string;       // agent lifecycle status for sub-agent nodes
  focused: boolean;      // this node is centered/highlighted
  gesturing: boolean;    // a canvas pan/drag is in progress → raise the shield
  onStartDrag: (nodeId: string, e: React.PointerEvent) => void;
  onStartResize: (nodeId: string, e: React.PointerEvent) => void;
  onResizeTo: (nodeId: string, w: number, h: number) => void;   // header size preset
  onMaximize: (nodeId: string) => void;                          // fit to viewport + center
  onContentZoom: (nodeId: string, zoom: number) => void;         // enlarge/shrink AI page in pane
  onFocus: (nodeId: string) => void;
  onClose: (nodeId: string) => void;
}

function pane(node: CanvasNode) {
  return { key: node.id, providerId: node.providerId, agentId: node.agentId };
}

export default function CanvasNodeCard({ node, status, focused, gesturing, onStartDrag, onStartResize, onResizeTo, onMaximize, onContentZoom, onFocus, onClose }: CanvasNodeCardProps) {
  const provider = PROVIDERS_BY_ID[node.providerId];
  const w = node.w || DEFAULT_NODE_W;
  const h = node.h || DEFAULT_NODE_H;
  const shortId = node.agentId ? node.agentId.slice(0, 8) : '';
  const cz = node.contentZoom || DEFAULT_CONTENT_ZOOM;

  // Control buttons must not start a drag: the header's onPointerDown would
  // capture the pointer to the viewport and swallow the button's click. Stop the
  // pointerdown at the button so the click lands.
  const stopDrag = (e: React.PointerEvent) => e.stopPropagation();

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
      >
        <span className="canvas-node-name" title={node.agentId ? `${provider?.label ?? node.providerId} · agent ${node.agentId}` : provider?.label}>
          <span className="canvas-node-grip" aria-hidden>⠿</span>
          {provider?.label ?? node.providerId}
          {shortId ? <span className="canvas-node-worker"> · {shortId}</span> : null}
        </span>
        <span className="canvas-node-ctrl">
          {/* Size presets + maximize. */}
          {NODE_SIZE_PRESETS.map(p => (
            <button
              key={p.id}
              className="canvas-node-size"
              title={`尺寸：${p.label}`}
              onPointerDown={stopDrag}
              onClick={() => onResizeTo(node.id, p.w, p.h)}
            >{p.label}</button>
          ))}
          <button className="canvas-node-size" title="界面缩小" onPointerDown={stopDrag} onClick={() => onContentZoom(node.id, cz - 0.1)}>A−</button>
          <button className="canvas-node-size" title="界面放大" onPointerDown={stopDrag} onClick={() => onContentZoom(node.id, cz + 0.1)}>A+</button>
          <button title="最大化" onPointerDown={stopDrag} onClick={() => onMaximize(node.id)}>⛶</button>
          <button title={focused ? '已聚焦 · 居中' : '聚焦居中'} onPointerDown={stopDrag} onClick={() => onFocus(node.id)}>◎</button>
          <button title="关闭" onPointerDown={stopDrag} onClick={() => onClose(node.id)}>✕</button>
        </span>
      </div>

      <div className="canvas-node-body">
        {/* Content zoom: render the iframe larger then scale it to fill the body,
            so the embedded AI page's own text/buttons are bigger (like Ctrl++)
            without changing the pane box. transform-origin top-left + sized to
            100/zoom% keeps it filling the body at any zoom. */}
        <iframe
          className="canvas-node-frame"
          src={paneSrc(pane(node))}
          title={node.id}
          style={{ width: `${100 / cz}%`, height: `${100 / cz}%`, transform: `scale(${cz})`, transformOrigin: '0 0' }}
        />
        {/* Pointer shield: only up DURING a canvas gesture (pan / node drag /
            resize) so the gesture isn't swallowed by the iframe. When idle the
            iframe is directly interactive at any zoom — no focus step needed. */}
        {gesturing && <div className="canvas-node-shield" />}
      </div>

      {/* Resize handle (bottom-right). Stops propagation so it doesn't pan; the
          canvas owns pointer-capture + logical-unit math while dragging. */}
      <div
        className="canvas-node-resize"
        title="拖动调整大小"
        onPointerDown={e => onStartResize(node.id, e)}
      />
    </div>
  );
}
