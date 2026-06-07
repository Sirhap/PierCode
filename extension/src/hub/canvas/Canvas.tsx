import { useRef, useState, useCallback, useEffect } from 'react';
import { Project, CanvasNode, Viewport, layoutTree } from '../project-store';
import { zoomAtPoint, panBy, screenToLogical, centerOnNode, fitView } from './canvas-math';
import { PROVIDERS_BY_ID } from '../pane-manager';
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
  freeLayout: boolean;              // false (default) = fixed tree, nodes can't be dragged;
                                    // true = free canvas, drag nodes to place them.
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onResizeNode: (nodeId: string, w: number, h: number) => void;
  onContentZoom: (nodeId: string, zoom: number) => void;
  onSetViewport: (vp: Viewport) => void;
  onCloseNode: (nodeId: string) => void;
}

interface DragState {
  nodeId: string;
  // pointer offset within the node, in logical units
  offsetX: number;
  offsetY: number;
}

interface ResizeState {
  nodeId: string;
  // logical pointer start + node start size, so resize is relative (no jump)
  startX: number;
  startY: number;
  startW: number;
  startH: number;
}

const ZOOM_STEP = 1.2; // per button click / keypress

export default function Canvas({ project, statusByAgentId, freeLayout, onMoveNode, onResizeNode, onContentZoom, onSetViewport, onCloseNode }: CanvasProps) {
  // In tree (non-free) mode, node positions are computed fresh from the tree
  // layout every render, so the structure stays fixed and tidy regardless of
  // stored x/y. In free mode, use the stored positions the user dragged.
  const displayNodes = freeLayout ? project.nodes : layoutTree(project.nodes);
  const vp = project.viewport;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  // draggingNodeId / resizingNodeId mirror the refs as state so node cards
  // re-render and raise their pointer shield only WHILE a gesture is in progress.
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [resizingNodeId, setResizingNodeId] = useState<string | null>(null);
  const panLastRef = useRef<{ x: number; y: number } | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  // Card locator dropdown: when the canvas is panned/zoomed far from the cards,
  // this lists every node so one click jumps (centers) onto it.
  const [cardListOpen, setCardListOpen] = useState(false);

  // The iframe shield is up only DURING an active canvas gesture (pan / node drag
  // / resize) so the gesture isn't swallowed by an iframe. Idle (either mode) =
  // iframes fully interactive — tree mode locks POSITION, not interaction.
  const gesturing = panning || draggingNodeId !== null || resizingNodeId !== null;

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  // Pin the viewport's native scroll to 0,0. The canvas pans via a CSS transform,
  // never native scroll — so any scrollTop/Left is spurious. It happens when an AI
  // page INSIDE a pane iframe calls scrollIntoView on its newest message after a
  // send: the browser scrolls the nearest scrollable ancestor across the iframe
  // boundary (this viewport), dragging the whole canvas. overflow:hidden does NOT
  // stop programmatic/focus scroll, so reset it on every scroll event.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) { el.scrollTop = 0; el.scrollLeft = 0; }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Latest viewport + setter for the wheel/pointer handlers, so they read the
  // current value without re-binding the listener on every change. Re-binding the
  // wheel listener each frame (the old [vp] dep) dropped fast scroll events
  // between unbind and rebind, which made zoom feel jumpy/unresponsive.
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const setVpRef = useRef(onSetViewport);
  setVpRef.current = onSetViewport;

  // Wheel = PAN the canvas (deltaY vertical, deltaX or Shift+deltaY horizontal).
  // Zoom is button-driven and predictable; only Ctrl/⌘+wheel (and the trackpad
  // pinch the browser maps to ctrl+wheel) still zooms, anchored at the cursor.
  // Bound ONCE as a non-passive native listener so preventDefault works.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const anchor = localPoint(e.clientX, e.clientY);
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setVpRef.current(zoomAtPoint(vpRef.current, factor, anchor));
        return;
      }
      // Pan. Shift makes a vertical wheel scroll horizontally (common convention).
      const dx = e.shiftKey ? -e.deltaY - e.deltaX : -e.deltaX;
      const dy = e.shiftKey ? 0 : -e.deltaY;
      setVpRef.current(panBy(vpRef.current, dx, dy));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [localPoint]);

  // Zoom controls (buttons + keys). Anchor at the viewport center so the visible
  // middle stays put. resetZoom returns to 100% keeping the center; fitAll frames
  // every node.
  const viewportCenter = () => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
  };
  const zoomByStep = useCallback((zoomIn: boolean) => {
    setVpRef.current(zoomAtPoint(vpRef.current, zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP, viewportCenter()));
  }, []);
  const resetZoom = useCallback(() => {
    // Keep the logical point currently at the viewport center fixed, set zoom=1.
    const c = viewportCenter();
    const v = vpRef.current;
    const lx = (c.x - v.x) / v.zoom;
    const ly = (c.y - v.y) / v.zoom;
    setVpRef.current({ zoom: 1, x: c.x - lx, y: c.y - ly });
  }, []);
  const fitAll = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    setVpRef.current(fitView(nodesRef.current, r.width, r.height));
  }, []);
  // Latest DISPLAYED nodes (tree-laid-out in tree mode) for fitAll / focus / jump,
  // so they use the on-screen positions, not the stored ones.
  const nodesRef = useRef(displayNodes);
  nodesRef.current = displayNodes;

  // Capture the pointer on the VIEWPORT root (where pointermove/up/leave are
  // bound), not on the event target. Capturing on a node header instead would
  // retarget move events to the header, so the viewport's onPointerMove could
  // miss them mid-drag. capturedPointerRef remembers the id for a clean release.
  const capturedPointerRef = useRef<number | null>(null);
  const captureOnViewport = (pointerId: number) => {
    rootRef.current?.setPointerCapture?.(pointerId);
    capturedPointerRef.current = pointerId;
  };

  // Whether the space bar is held — enables pan-from-anywhere (even over a node),
  // for when nodes are dense and there's no empty canvas to grab.
  const spaceHeldRef = useRef(false);
  // Mirror to state purely so the cursor flips to the grab hand while Space is held.
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Pan is INTENTIONAL only: Space+left (the "小手") or middle button. A bare
  // left-drag on empty canvas no longer pans — it would otherwise fight the user
  // trying to interact with an AI pane. The cursor shows a grab hand only while
  // Space is held (see data-spacepan on the root).
  const wantsPan = (e: React.PointerEvent) => e.button === 1 || (e.button === 0 && spaceHeldRef.current);
  const startPan = (e: React.PointerEvent) => {
    setPanning(true);
    panLastRef.current = { x: e.clientX, y: e.clientY };
    setFocusedNodeId(null); // panning empties focus
    captureOnViewport(e.pointerId);
  };
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (wantsPan(e)) {
      e.preventDefault();
      startPan(e);
    }
    // No bare-left pan: empty-canvas left-click just deselects.
    else if (e.button === 0) setFocusedNodeId(null);
  };

  const startNodeDrag = (nodeId: string, e: React.PointerEvent) => {
    // Space/middle = pan even when starting over a node header.
    if (wantsPan(e)) {
      e.preventDefault();
      startPan(e);
      return;
    }
    // Node dragging only in FREE mode. In tree mode position is fixed, so a
    // header press does nothing canvas-side (the pane handles its own UI).
    if (!freeLayout) return;
    e.stopPropagation();
    if (e.button !== 0) return;
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const lp = screenToLogical(localPoint(e.clientX, e.clientY), vpRef.current);
    dragRef.current = { nodeId, offsetX: lp.x - node.x, offsetY: lp.y - node.y };
    setDraggingNodeId(nodeId);
    captureOnViewport(e.pointerId);
  };

  const startNodeResize = (nodeId: string, e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const lp = screenToLogical(localPoint(e.clientX, e.clientY), vpRef.current);
    resizeRef.current = { nodeId, startX: lp.x, startY: lp.y, startW: node.w, startH: node.h };
    setResizingNodeId(nodeId);
    captureOnViewport(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Use vpRef (latest) not the render-closure vp: a continuous gesture fires
    // many moves before React re-renders, so the closure value would be stale and
    // the node/pan would drift.
    if (dragRef.current) {
      const d = dragRef.current;
      const lp = screenToLogical(localPoint(e.clientX, e.clientY), vpRef.current);
      onMoveNode(d.nodeId, Math.round(lp.x - d.offsetX), Math.round(lp.y - d.offsetY));
      return;
    }
    if (resizeRef.current) {
      // Resize in logical units: pointer delta from gesture start added to the
      // node's start size (resizeNode clamps the minimum).
      const r = resizeRef.current;
      const lp = screenToLogical(localPoint(e.clientX, e.clientY), vpRef.current);
      onResizeNode(r.nodeId, r.startW + (lp.x - r.startX), r.startH + (lp.y - r.startY));
      return;
    }
    if (panning && panLastRef.current) {
      const dx = e.clientX - panLastRef.current.x;
      const dy = e.clientY - panLastRef.current.y;
      panLastRef.current = { x: e.clientX, y: e.clientY };
      setVpRef.current(panBy(vpRef.current, dx, dy));
    }
  };

  const endGesture = () => {
    dragRef.current = null;
    resizeRef.current = null;
    panLastRef.current = null;
    setPanning(false);
    setDraggingNodeId(null);
    setResizingNodeId(null);
    if (capturedPointerRef.current !== null) {
      try { rootRef.current?.releasePointerCapture?.(capturedPointerRef.current); } catch { /* already released */ }
      capturedPointerRef.current = null;
    }
  };

  const focusNode = useCallback((nodeId: string) => {
    // Toggle off if already focused; otherwise focus + center. The viewport side
    // effect lives OUTSIDE the setState updater (updaters must stay pure — React
    // StrictMode double-invokes them, which would double-apply the centering).
    const node = nodesRef.current.find(n => n.id === nodeId); // displayed position
    setFocusedNodeId(prev => {
      const next = prev === nodeId ? null : nodeId;
      return next;
    });
    if (focusedNodeId !== nodeId && node && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      onSetViewport(centerOnNode(node, r.width, r.height, 1));
    }
  }, [onSetViewport, focusedNodeId]);

  // jumpToNode always centers + highlights a node (no toggle-off), for the card
  // locator list. At least 100% zoom so the landed card is actually readable.
  const jumpToNode = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId); // displayed position
    if (!node || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    onSetViewport(centerOnNode(node, r.width, r.height, Math.max(1, vpRef.current.zoom)));
    setFocusedNodeId(nodeId);
    setCardListOpen(false);
  }, [onSetViewport]);

  // Header size-preset / maximize. A preset sets an explicit w/h; maximize fits
  // the node to the visible viewport (in logical units) then centers it.
  const resizeNodeTo = useCallback((nodeId: string, w: number, h: number) => {
    onResizeNode(nodeId, w, h);
  }, [onResizeNode]);
  const maximizeNode = useCallback((nodeId: string) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const z = vpRef.current.zoom;
    const w = (r.width - 80) / z;
    const h = (r.height - 80) / z;
    onResizeNode(nodeId, w, h);
    // Center it after the size change lands; read the fresh size next frame.
    requestAnimationFrame(() => {
      const node = nodesRef.current.find(n => n.id === nodeId);
      if (node && rootRef.current) {
        const rr = rootRef.current.getBoundingClientRect();
        onSetViewport(centerOnNode(node, rr.width, rr.height, vpRef.current.zoom));
      }
    });
  }, [onResizeNode, onSetViewport]);

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

  // Keyboard: +/= zoom in, -/_ zoom out, 0 reset, F fit-all, Esc exit focus,
  // Del/Backspace close focused node, Space (held) = temporary pan mode. Ignored
  // while typing in an input/textarea/contenteditable (e.g. inside an iframe pane
  // the events don't bubble here anyway, but guard the Hub's own fields).
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (isTyping(e.target)) return; // let space type in a field
        e.preventDefault();             // stop page from scrolling
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        return;
      }
      if (isTyping(e.target)) return;
      switch (e.key) {
        case '+': case '=': e.preventDefault(); zoomByStep(true); break;
        case '-': case '_': e.preventDefault(); zoomByStep(false); break;
        case '0': e.preventDefault(); resetZoom(); break;
        case 'f': case 'F': e.preventDefault(); fitAll(); break;
        case 'Escape': setFocusedNodeId(null); break;
        case 'Delete': case 'Backspace':
          if (focusedNodeId) { e.preventDefault(); onCloseNode(focusedNodeId); setFocusedNodeId(null); }
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') { spaceHeldRef.current = false; setSpaceHeld(false); } };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [zoomByStep, resetZoom, fitAll, focusedNodeId, onCloseNode]);

  return (
    <div
      ref={rootRef}
      className="canvas-viewport"
      data-panning={panning}
      data-spacepan={spaceHeld}
      data-freelayout={freeLayout}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerLeave={endGesture}
      onPointerCancel={endGesture}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }}
      >
        {displayNodes.map((node: CanvasNode) => (
          <CanvasNodeCard
            key={node.id}
            onStartResize={startNodeResize}
            onResizeTo={resizeNodeTo}
            onMaximize={maximizeNode}
            onContentZoom={onContentZoom}
            node={node}
            draggable={freeLayout}
            status={node.agentId ? statusByAgentId[node.agentId] : undefined}
            focused={focusedNodeId === node.id}
            gesturing={gesturing}
            onStartDrag={startNodeDrag}
            onFocus={focusNode}
            onClose={onCloseNode}
          />
        ))}
        {/* Edges rendered AFTER the node cards so the parent→child wires paint ON
            TOP of the opaque cards (a card's solid background was hiding the short
            wire between a tightly-packed parent and child). pointer-events:none
            keeps them from blocking pane interaction. Use displayNodes so wires
            track the tree-mode positions. */}
        <Edges nodes={displayNodes} width={CANVAS_EXTENT} height={CANVAS_EXTENT} />
      </div>
      {project.nodes.length === 0 && (
        <div className="canvas-empty">用上方「+ AI」添加一个主 agent</div>
      )}

      {/* Zoom + card-locator controls — fixed overlay, outside the canvas-world
          transform and above iframe compositing layers. */}
      <div className="canvas-zoom" onPointerDown={e => e.stopPropagation()}>
        <button className="cz-btn" title="缩小 (−)" onClick={() => zoomByStep(false)}>−</button>
        <button className="cz-pct" title="重置为 100% (0)" onClick={resetZoom}>{Math.round(vp.zoom * 100)}%</button>
        <button className="cz-btn" title="放大 (+)" onClick={() => zoomByStep(true)}>＋</button>
        <button className="cz-fit" title="适应全部 (F)" onClick={fitAll}>适应</button>
        <button
          className="cz-fit"
          title="定位卡片"
          data-active={cardListOpen}
          onClick={() => setCardListOpen(v => !v)}
        >⌖ 卡片</button>
      </div>

      {cardListOpen && (
        <div className="canvas-locator" onPointerDown={e => e.stopPropagation()}>
          <div className="canvas-locator-head">
            <span>卡片定位</span>
            <button title="全部框回 (F)" onClick={() => { fitAll(); setCardListOpen(false); }}>适应全部</button>
          </div>
          {project.nodes.length === 0 ? (
            <div className="canvas-locator-empty">还没有卡片</div>
          ) : (
            <ul className="canvas-locator-list">
              {project.nodes.map(n => {
                const label = PROVIDERS_BY_ID[n.providerId]?.label ?? n.providerId;
                const sub = n.agentId ? n.agentId.slice(0, 8) : (n.parentNodeId ? '子节点' : '主');
                return (
                  <li key={n.id}>
                    <button onClick={() => jumpToNode(n.id)} data-focused={focusedNodeId === n.id}>
                      <span className="cl-name">{label}</span>
                      <span className="cl-sub">{sub}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
