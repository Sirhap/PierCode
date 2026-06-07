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
  const z = clampZoom(zoom);
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  return { zoom: z, x: viewW / 2 - cx * z, y: viewH / 2 - cy * z };
}

// edgePath returns an SVG cubic-bezier `d` from the bottom-center of the parent
// node to the top-center of the child, in LOGICAL coordinates (the SVG overlay
// shares the canvas transform). The control points bow vertically so the wires
// read as a tree.
export function edgePath(parent: CanvasNode, child: CanvasNode): string {
  const x1 = parent.x + parent.w / 2;
  const y1 = parent.y + parent.h;
  const x2 = child.x + child.w / 2;
  const y2 = child.y;
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
