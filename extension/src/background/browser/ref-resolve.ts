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
    if (rect) return { point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, sessionId: '' }
    // querySelector found nothing — the element may live inside a CLOSED shadow root
    // (invisible to page-context querySelector). Fall back to a CDP pierced-tree walk
    // (item #6) for a simple tag/attr selector, then box-model the matched backend node.
    const want = parseSimpleSelector(req.selector)
    if (want) {
      try {
        const backendId = await resolveClosedShadow(cdp, target, want)
        if (backendId != null) {
          const b = await boxModelBounds(cdp, target, backendId)
          return { point: { x: b.x + b.width / 2, y: b.y + b.height / 2 }, sessionId: '' }
        }
      } catch { /* pierce unavailable → fall through to the not-found error */ }
    }
    throw new Error(`selector ${req.selector} not found`)
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

// ── closed shadow-root piercing (item #6) ──────────────────────────────────────
// Page-context JS (marks.ts / find.ts) descends `element.shadowRoot`, which is `null`
// for a CLOSED shadow root — so elements inside a closed root are invisible to those
// collectors and can't be selected. CDP `DOM.getDocument({pierce:true})` returns the
// full node tree INCLUDING closed roots (each node carries `shadowRoots[]` and a stable
// `backendNodeId`), which is the only way to reach them. This is a CDP-side element
// RESOLUTION fallback: given a tag + attribute predicate, walk the pierced tree and
// return the first matching node's backendNodeId (→ resolves to a point via
// boxModelBounds, same as a snapshot ref). Limit: we can't run arbitrary CSS combinators
// here (no querySelector across the shadow boundary from the SW), so the predicate is a
// flat tag/attr match — enough for the common "the button is in a closed web component"
// case. A full CSS engine over the pierced tree would be a larger refactor.

// A node as returned by DOM.getDocument (subset of the CDP DOM.Node we use).
export interface CdpDomNode {
  backendNodeId?: number
  nodeName?: string                 // upper-case tag, e.g. "BUTTON"
  nodeType?: number                 // 1 = element
  attributes?: string[]             // flat [name, value, name, value, ...]
  children?: CdpDomNode[]
  shadowRoots?: CdpDomNode[]        // present for OPEN and CLOSED roots when pierce:true
  contentDocument?: CdpDomNode      // iframe document
}

export interface PierceMatch { tag?: string; attrs?: Record<string, string> }

/** Read a flat CDP attributes array into a lookup. */
function attrMap(attrs?: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  if (attrs) for (let i = 0; i + 1 < attrs.length; i += 2) m[attrs[i].toLowerCase()] = attrs[i + 1]
  return m
}

function nodeMatches(node: CdpDomNode, want: PierceMatch): boolean {
  if (node.nodeType != null && node.nodeType !== 1) return false
  if (want.tag && (node.nodeName || '').toLowerCase() !== want.tag.toLowerCase()) return false
  if (want.attrs) {
    const have = attrMap(node.attributes)
    for (const [k, v] of Object.entries(want.attrs)) {
      const got = have[k.toLowerCase()]
      if (got == null) return false
      if (v !== '' && got !== v) return false
    }
  }
  return true
}

/** DFS the pierced DOM tree (children + closed/open shadowRoots + iframe docs). */
function walkPierced(node: CdpDomNode | undefined, want: PierceMatch, out: { id?: number }): void {
  if (!node || out.id != null) return
  if (nodeMatches(node, want) && node.backendNodeId != null) { out.id = node.backendNodeId; return }
  for (const c of node.children ?? []) { walkPierced(c, want, out); if (out.id != null) return }
  for (const s of node.shadowRoots ?? []) { walkPierced(s, want, out); if (out.id != null) return }
  if (node.contentDocument) walkPierced(node.contentDocument, want, out)
}

/** Parse a SIMPLE selector into a flat tag/attr predicate for the pierced walk. Handles
 *  `tag`, `#id`, `tag#id`, `[attr=value]`/`[attr="value"]`, and a leading tag with one or
 *  more `[attr=value]` clauses. Returns null for anything with combinators/pseudo/class
 *  selectors (those need a real CSS engine, which the pierce path can't run). */
export function parseSimpleSelector(sel: string): PierceMatch | null {
  const s = sel.trim()
  if (!s) return null
  // Reject combinators, descendant spaces, classes, pseudo OUTSIDE [..] — those need a
  // real CSS engine the pierce path can't run.
  if (/[ >+~.:]/.test(s.replace(/\[[^\]]*\]/g, ''))) return null
  const want: PierceMatch = {}
  let rest = s
  // optional tag, then optional #id
  const tagM = /^([a-zA-Z][\w-]*)/.exec(rest)
  if (tagM) { want.tag = tagM[1]; rest = rest.slice(tagM[0].length) }
  const idM = /^#([\w-]+)/.exec(rest)
  if (idM) { (want.attrs ??= {}).id = idM[1]; rest = rest.slice(idM[0].length) }
  // zero or more [attr=value] / [attr] clauses, consumed left-to-right
  const attrRe = /^\[\s*([\w-]+)\s*(?:=\s*"?([^"\]]*)"?\s*)?\]/
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(rest))) { (want.attrs ??= {})[m[1].toLowerCase()] = m[2] ?? ''; rest = rest.slice(m[0].length) }
  // Anything left over → unsupported selector syntax.
  if (rest.length !== 0) return null
  if (!want.tag && !want.attrs) return null
  return want
}

/** Resolve an element that may live inside a CLOSED shadow root via a pierced DOM walk.
 *  Returns the first matching node's backendNodeId, or null if none. Best-effort: a
 *  restricted page / disabled DOM domain throws upstream; callers treat null as "no match". */
export async function resolveClosedShadow(cdp: Cdp, target: Debuggee, want: PierceMatch): Promise<number | null> {
  const out = await cdp.sendCommand(target, 'DOM', 'getDocument', { depth: -1, pierce: true })
  const root = out?.root as CdpDomNode | undefined
  if (!root) return null
  const acc: { id?: number } = {}
  walkPierced(root, want, acc)
  return acc.id ?? null
}
