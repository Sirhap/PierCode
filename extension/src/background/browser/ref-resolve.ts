// Ref/selector/point resolution. Ports controller.go resolvePoint/boxModelBounds/
// assertPointActionable + controller_ext.go resolveRefObject/resolveSelectorObject.
// Issues DOM.getBoxModel / DOM.resolveNode / Runtime.evaluate via injected Cdp.
import type { Cdp } from './cdp'
import type { Point, Bounds } from './types'
import type { TabRegistry } from './registry'

type Debuggee = chrome.debugger.Debuggee

export interface BoxModel { content: number[] /* 8 numbers: x1,y1..x4,y4 */ }

/** Center of the CDP content quad (mirror controller.go boxModelBounds averaging). */
export function boxModelCenter(box: BoxModel): Point {
  const q = box.content
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
}

/** Explicit-coordinate fast path (mirror the xy branch of controller.go resolvePoint). */
export async function resolvePointFromXY(xy: { x: number; y: number }): Promise<Point> {
  return { x: xy.x, y: xy.y }
}

/** DOM.getBoxModel for a backendNodeId on a target → bounding box.
 *  Port of controller.go:1330 boxModelBounds + :1366 boxModelBoundsOnSession. */
export async function boxModelBounds(cdp: Cdp, target: Debuggee, backendNodeId: number): Promise<Bounds> {
  const out = await cdp.sendCommand(target, 'DOM', 'getBoxModel', { backendNodeId })
  const q = out?.model?.content as number[]
  if (!q || q.length < 8) throw new Error('getBoxModel returned no content quad')
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

function selectorRectExpr(sel: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`
}

export interface ResolveRequest { tabId: number; ref?: string; selector?: string; mark?: number; x?: number; y?: number }

/** ref | selector | mark | {x,y} → viewport point + sessionId. Port controller.go:1270. */
export async function resolvePoint(
  cdp: Cdp, reg: TabRegistry, target: Debuggee, req: ResolveRequest,
): Promise<{ point: Point; sessionId: string }> {
  if (req.x != null && req.y != null) return { point: { x: req.x, y: req.y }, sessionId: '' }
  if (req.ref) {
    const t = reg.resolveRef(req.tabId, req.ref)
    if (!t) throw new Error(`ref ${req.ref} is stale or unknown; take a fresh browser_snapshot`)
    const sess = t.sessionId
    // sessionId targets a child OOPIF session (flat sessions); @types/chrome's
    // Debuggee lacks the field, so cast (mirrors background/index.ts handling).
    const tgt: Debuggee = sess ? ({ tabId: req.tabId, sessionId: sess } as Debuggee) : target
    const b = await boxModelBounds(cdp, tgt, t.backendId)
    const off = t.frameOffset
    const cx = b.x + b.width / 2 + (off?.x ?? 0)
    const cy = b.y + b.height / 2 + (off?.y ?? 0)
    return { point: { x: cx, y: cy }, sessionId: sess }
  }
  if (req.mark != null) {
    const marks = reg.marks(req.tabId)
    const m = marks?.find(x => x.index === req.mark)
    if (!m) throw new Error(`mark ${req.mark} unknown; run browser_mark first`)
    return { point: { x: m.cx, y: m.cy }, sessionId: '' }
  }
  if (req.selector) {
    const rect = await cdp.runtimeEvaluate(target, selectorRectExpr(req.selector))
    if (!rect) throw new Error(`selector ${req.selector} not found`)
    return { point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, sessionId: '' }
  }
  throw new Error('resolvePoint: need ref, selector, mark, or x/y')
}

/** elementFromPoint hit-test (port controller.go:1478 assertPointActionable). */
export async function assertPointActionable(cdp: Cdp, target: Debuggee, p: Point): Promise<void> {
  const ok = await cdp.runtimeEvaluate(target, `(() => !!document.elementFromPoint(${p.x}, ${p.y}))()`)
  if (!ok) throw new Error(`point (${p.x},${p.y}) is not actionable (nothing at that location)`)
}

/** Resolve a CSS selector to a Runtime objectId (port controller_ext.go:761). */
export async function resolveSelectorObject(cdp: Cdp, target: Debuggee, selector: string): Promise<string> {
  const out = await cdp.sendCommand(target, 'Runtime', 'evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
  })
  const objectId = out?.result?.objectId
  if (!objectId) throw new Error(`selector ${selector} not found`)
  return objectId
}

/** Resolve a backendNodeId to a Runtime objectId (port controller_ext.go:783 resolveRefObject). */
export async function resolveRefObject(cdp: Cdp, target: Debuggee, backendNodeId: number): Promise<string> {
  const out = await cdp.sendCommand(target, 'DOM', 'resolveNode', { backendNodeId })
  const objectId = out?.object?.objectId
  if (!objectId) throw new Error('DOM.resolveNode returned no objectId')
  return objectId
}
