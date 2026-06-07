import { describe, it, expect } from 'vitest';
import {
  logicalToScreen,
  screenToLogical,
  zoomAtPoint,
  panBy,
  clampZoom,
  centerOnNode,
  hitNode,
  edgePath,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../hub/canvas/canvas-math';
import type { Viewport, CanvasNode } from '../hub/project-store';

const vp: Viewport = { x: 100, y: 50, zoom: 2 };
const node = (id: string, x: number, y: number): CanvasNode => ({ id, providerId: 'qwen', x, y, w: 100, h: 80 });

describe('canvas-math', () => {
  it('logical↔screen round-trips', () => {
    const p = { x: 30, y: 40 };
    const s = logicalToScreen(p, vp);
    expect(s).toEqual({ x: 30 * 2 + 100, y: 40 * 2 + 50 });
    expect(screenToLogical(s, vp)).toEqual(p);
  });

  it('clampZoom respects bounds', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it('zoomAtPoint keeps the logical point under the cursor fixed', () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToLogical(anchor, vp);
    const next = zoomAtPoint(vp, 1.5, anchor);
    const after = screenToLogical(anchor, next);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zoomAtPoint is a no-op at the zoom bound', () => {
    const maxed: Viewport = { x: 0, y: 0, zoom: MAX_ZOOM };
    expect(zoomAtPoint(maxed, 2, { x: 10, y: 10 })).toBe(maxed);
  });

  it('panBy shifts the offset', () => {
    expect(panBy(vp, 5, -5)).toMatchObject({ x: 105, y: 45, zoom: 2 });
  });

  it('centerOnNode places the node center at the viewport center', () => {
    const n = node('a', 200, 100);
    const out = centerOnNode(n, 800, 600, 1);
    // node center = (250,140); at zoom 1 it should map to (400,300)
    expect(logicalToScreen({ x: 250, y: 140 }, out)).toEqual({ x: 400, y: 300 });
  });

  it('hitNode returns the topmost node containing the point', () => {
    const nodes = [node('a', 0, 0), node('b', 50, 50)]; // overlap at (50..100,50..80)
    expect(hitNode(nodes, { x: 60, y: 60 })!.id).toBe('b'); // last drawn wins
    expect(hitNode(nodes, { x: 10, y: 10 })!.id).toBe('a');
    expect(hitNode(nodes, { x: 999, y: 999 })).toBeNull();
  });

  it('edgePath draws from parent bottom-center to child top-center', () => {
    const d = edgePath(node('p', 0, 0), node('c', 0, 200));
    expect(d.startsWith('M 50 80')).toBe(true); // parent bottom-center (x=50,y=80)
    expect(d).toContain('50 200');              // child top-center (x=50,y=200)
  });
});
