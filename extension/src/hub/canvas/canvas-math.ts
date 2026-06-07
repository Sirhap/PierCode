// canvas-math: pure geometry for the Hub canvas. Screen↔logical coordinate
// conversion under pan/zoom, cursor-anchored zoom, and the bezier path between a
// parent and child node. No DOM; unit-testable.

import type { Viewport, CanvasNode } from '../project-store';

export interface Point { x: number; y: number; }

// The canvas root is transformed `translate(vp.x, vp.y) scale(vp.zoom)`. A
// logical point (lx,ly) therefore lands on screen at:
//   screen = logical * zoom + offset
export function logicalToScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y };
}

export function screenToLogical(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom };
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// zoomAtPoint applies a zoom delta keeping the logical point under the cursor
// fixed on screen (so the canvas zooms toward the pointer, not the origin).
// `anchor` is the cursor position in screen coordinates.
export function zoomAtPoint(vp: Viewport, factor: number, anchor: Point): Viewport {
  const nextZoom = clampZoom(vp.zoom * factor);
  if (nextZoom === vp.zoom) return vp;
  // Keep the logical point under the anchor invariant:
  //   (anchor - offset) / zoom === (anchor - offset') / zoom'
  const lx = (anchor.x - vp.x) / vp.zoom;
  const ly = (anchor.y - vp.y) / vp.zoom;
  return {
    zoom: nextZoom,
    x: anchor.x - lx * nextZoom,
    y: anchor.y - ly * nextZoom,
  };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

// centerOnNode returns the viewport that centers a node in a viewport of the
// given pixel size at a target zoom — used by "focus this node".
export function centerOnNode(node: CanvasNode, viewW: number, viewH: number, zoom: number): Viewport {
  const z = clampZoom(num(zoom, 1));
  const vw = num(viewW, 1200), vh = num(viewH, 800);
  const cx = num(node.x, 0) + num(node.w, 560) / 2;
  const cy = num(node.y, 0) + num(node.h, 520) / 2;
  return { zoom: z, x: vw / 2 - cx * z, y: vh / 2 - cy * z };
}

// fitView returns the viewport that fits ALL nodes' bounding box into a viewport
// of the given pixel size, centered, with `padding` screen px of margin. Zoom is
// clamped to [MIN_ZOOM, MAX_ZOOM]. With no nodes it returns the identity viewport.
// Used by the "适应" (fit-all) button.
// num coalesces a possibly-undefined/NaN value to a fallback. Legacy persisted
// nodes (from before w/h were always set) can carry undefined w/h; without this,
// `n.x + n.w` is NaN → the whole viewport becomes NaN → every card vanishes off
// an unrenderable canvas (the "点适应卡片消失" bug).
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function fitView(nodes: CanvasNode[], viewW: number, viewH: number, padding = 60): Viewport {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };
  const vw = num(viewW, 1200), vh = num(viewH, 800);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const x = num(n.x, 0), y = num(n.y, 0);
    const w = num(n.w, 560), h = num(n.h, 520);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const availW = Math.max(1, vw - padding * 2);
  const availH = Math.max(1, vh - padding * 2);
  const z = clampZoom(Math.min(availW / boxW, availH / boxH));
  // Center the box: viewport center maps to the box center in logical space.
  const cx = minX + boxW / 2;
  const cy = minY + boxH / 2;
  const out = { zoom: z, x: vw / 2 - cx * z, y: vh / 2 - cy * z };
  // Final NaN guard: never hand back an unrenderable viewport.
  if (!Number.isFinite(out.x) || !Number.isFinite(out.y) || !Number.isFinite(out.zoom)) {
    return { x: 0, y: 0, zoom: 1 };
  }
  return out;
}

// edgePath returns an SVG cubic-bezier `d` from the bottom-center of the parent
// node to the top-center of the child, in LOGICAL coordinates (the SVG overlay
// shares the canvas transform). The control points bow vertically so the wires
// read as a tree.
export function edgePath(parent: CanvasNode, child: CanvasNode): string {
  const pw = num(parent.w, 0);
  const ph = num(parent.h, 0);
  const cw = num(child.w, 0);
  const x1 = num(parent.x, 0) + pw / 2;
  const y1 = num(parent.y, 0) + ph;
  const x2 = num(child.x, 0) + cw / 2;
  const y2 = num(child.y, 0);
  const dy = Math.max(40, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

// hitNode returns the topmost node whose logical box contains the logical point,
// or null. Iterates back-to-front so the last-drawn (visually top) node wins.
export function hitNode(nodes: CanvasNode[], lp: Point): CanvasNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (lp.x >= n.x && lp.x <= n.x + n.w && lp.y >= n.y && lp.y <= n.y + n.h) return n;
  }
  return null;
}
