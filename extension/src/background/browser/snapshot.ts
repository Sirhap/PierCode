// Faithful port of internal/browser/snapshot.go — AX tree → indented text + refs.
// Parent-child context preserved (indent under nearest kept ancestor), refs (e0,e1…)
// assigned to actionable nodes in document order, bounded by maxNodes/maxChars/depth.
//
// ── #7 (part 2): serialized-snapshot token footprint vs a compact format ────────
// One emitted node line ≈ `  [e3] button "Submit Order" focused\n`. Cost per line:
//   • indent: 2 spaces × depth (≈0.5 tok at depth 5–8 once GPT-BPE merges runs),
//   • ref tag `[eN] ` ≈ 3 tok, role word ≈ 1 tok, quoted name ≈ name_words+2 tok,
//   • each affordance flag ≈ 1–2 tok.
// A typical 80–150-node page renders ~120–500 lines ⇒ ~600–2500 tokens, hard-capped
// by MAX_OUTPUT_CHARS=12000 (~3000 tok) + the 200-node cap. That is ALREADY the AX-text
// "DOM mode" the openchrome reference touts (5–15× vs raw HTML): one terse line/node,
// no markup, no inline styles. The cheap further wins would be 1-space indent and
// dropping the `value=`/`desc=` key prefixes — but those DIVERGE from the Go port
// (internal/browser/snapshot.go) this file mirrors byte-for-byte and would desync the
// two serializers + their tests, so they are deliberately NOT applied here. The two
// real caps (maxChars + maxNodes, with the `ref_id=<ref>`/`depth` narrowing hint on
// truncation) are the load-bearing token guards and are already in place. #7 part-2 is
// therefore a documented finding, not a code change. (Part 1 — stable backendNodeId
// addressing — is verified in ref-resolve.ts and IS satisfied.)
import type { BrowserTab, RefTarget, Bounds } from './types'

const DEFAULT_MAX_NODES = 200
const DEFAULT_MAX_DEPTH = 15
const MAX_OUTPUT_CHARS = 12000
const MAX_VALUE_CHARS = 120

export interface SnapshotOptions {
  refId?: string
  maxNodes?: number
  maxChars?: number
  depth?: number
}

export interface FrameAXTree { raw: AXTreeResponse; sessionId: string; url: string }

interface AXValueRaw { type?: string; value?: any }
interface AXProperty { name: string; value?: AXValueRaw }
interface AXNode {
  nodeId: string
  backendDOMNodeId?: number
  childIds?: string[]
  parentId?: string
  role?: AXValueRaw
  name?: AXValueRaw
  value?: AXValueRaw
  description?: AXValueRaw
  ignored?: boolean
  properties?: AXProperty[]
}
export interface AXTreeResponse { nodes: AXNode[] }

export interface SnapshotResult {
  text: string
  refs: Record<string, RefTarget>
  nodeCount: number
  refCount: number
  truncated: boolean
}

// --- axValue.String() port ---
function axStr(v?: AXValueRaw): string {
  if (!v || v.value == null) return ''
  const x = v.value
  if (typeof x === 'string') return x
  if (typeof x === 'boolean') return x ? 'true' : 'false'
  if (typeof x === 'number') return `${x}`
  return String(x).replace(/^"|"$/g, '')
}

function trimText(s: string, limit: number): string {
  s = s.trim().split(/\s+/).filter(Boolean).join(' ')
  const runes = [...s]
  if (limit <= 0 || runes.length <= limit) return s
  return runes.slice(0, limit).join('') + '...'
}

function quote(s: string): string { return JSON.stringify(s) }

const IMPORTANT_ROLES = new Set([
  'button', 'textbox', 'searchbox', 'link', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'heading', 'slider', 'spinbutton', 'switch', 'listbox',
  'option', 'treeitem', 'gridcell', 'cell',
])
function isImportantRole(role: string): boolean { return IMPORTANT_ROLES.has(role.toLowerCase()) }

function isFocusable(n: AXNode): boolean {
  return (n.properties ?? []).some(p => p.name.toLowerCase() === 'focusable' && axStr(p.value) === 'true')
}
function isEditable(n: AXNode): boolean {
  for (const p of n.properties ?? []) {
    if (p.name.toLowerCase() === 'editable') { const v = axStr(p.value); return v !== '' && v !== 'false' }
  }
  return false
}
function shouldKeep(n: AXNode, role: string, name: string, value: string, desc: string): boolean {
  if (n.ignored) return false
  if (role === '' || role === 'none' || role === 'generic') return false
  if (name === '' && value === '' && desc === '' && !isImportantRole(role) && !isFocusable(n) && !isEditable(n)) return false
  return true
}
function boundsFromNode(n: AXNode): Bounds | null {
  for (const p of n.properties ?? []) {
    if (p.name.toLowerCase() !== 'bounds' || p.value?.value == null) continue
    const b = p.value.value as Bounds
    if (b && b.width > 0 && b.height > 0) return b
  }
  return null
}
function compactFlags(n: AXNode): string[] {
  const flags: string[] = []
  for (const p of n.properties ?? []) {
    const name = p.name.toLowerCase()
    const value = axStr(p.value)
    switch (name) {
      case 'disabled': case 'focused': case 'selected': case 'checked': case 'pressed': case 'expanded':
        if (value !== '' && value !== 'false') flags.push(`${name}=${value}`); break
      case 'editable':
        if (value !== '' && value !== 'false') flags.push('editable'); break
      case 'level':
        if (value !== '') flags.push(`level=${value}`); break
      case 'url':
        if (value !== '') flags.push(`href=${quote(trimText(value, MAX_VALUE_CHARS))}`); break
    }
  }
  return flags
}

class Walk {
  out = ''
  refs: RefTarget[] = []
  shown = 0
  truncated = false
  emitting: boolean
  matchedRef = false
  constructor(
    private byId: Map<string, AXNode>,
    private maxNodes: number, private maxChars: number, private maxDepth: number,
    private targetRef: string, private refBase: number,
  ) { this.emitting = targetRef === '' }

  walk(node: AXNode | undefined, visualDepth: number): void {
    if (this.truncated || !node) return
    const role = axStr(node.role)
    const name = trimText(axStr(node.name), MAX_VALUE_CHARS)
    const value = trimText(axStr(node.value), MAX_VALUE_CHARS)
    const desc = trimText(axStr(node.description), MAX_VALUE_CHARS)
    const keep = shouldKeep(node, role, name, value, desc)
    let childDepth = visualDepth

    if (keep) {
      let refName = ''
      if (isImportantRole(role) || isFocusable(node) || isEditable(node)) {
        // #7 (part 1): the ref NAME (e0,e1…) is positional within THIS snapshot and is
        // re-minted on every re-snapshot, but the stored RefTarget carries the CDP
        // `backendDOMNodeId` — a stable per-document node handle. resolvePoint() resolves
        // a ref THROUGH that backendId (boxModelBounds), so the same element addresses
        // consistently across calls after a refresh; the name is just a lookup label, the
        // backendId is the real address. (nodeId is the volatile AX id — not used to act.)
        refName = `e${this.refBase + this.refs.length}`
        this.refs.push({ ref: refName, nodeId: node.nodeId, backendId: node.backendDOMNodeId ?? 0,
          role, name, bounds: boundsFromNode(node), sessionId: '', frameOffset: null })
      }
      let enteredHere = false
      if (this.targetRef !== '' && !this.emitting && refName === this.targetRef) {
        this.emitting = true; this.matchedRef = true; enteredHere = true
      }
      if (this.emitting) {
        if (this.shown >= this.maxNodes || this.out.length >= this.maxChars) { this.truncated = true; return }
        this.writeNode(node, role, name, value, desc, refName, visualDepth)
        this.shown++
        childDepth = visualDepth + 1
      }
      if (this.emitting && childDepth > this.maxDepth) { if (enteredHere) this.emitting = false; return }
      for (const cid of node.childIds ?? []) { this.walk(this.byId.get(cid), childDepth); if (this.truncated) break }
      if (enteredHere) this.emitting = false
      return
    }
    for (const cid of node.childIds ?? []) { this.walk(this.byId.get(cid), visualDepth); if (this.truncated) break }
  }

  private writeNode(node: AXNode, role: string, name: string, value: string, desc: string, refName: string, depth: number): void {
    let line = '  '.repeat(depth)
    line += refName !== '' ? `[${refName}] ` : '- '
    line += role
    if (name !== '') line += ` ${quote(name)}`
    if (value !== '' && value !== name) line += ` value=${quote(value)}`
    if (desc !== '' && desc !== name) line += ` desc=${quote(desc)}`
    for (const flag of compactFlags(node)) line += ` ${flag}`
    this.out += line + '\n'
  }
}

function indexAndRoots(tree: AXTreeResponse): { byId: Map<string, AXNode>; roots: AXNode[] } {
  const byId = new Map<string, AXNode>()
  for (const n of tree.nodes) byId.set(n.nodeId, n)
  const roots: AXNode[] = []
  for (const n of tree.nodes) if (!n.parentId || !byId.has(n.parentId)) roots.push(n)
  return { byId, roots }
}

function refsToMap(arr: RefTarget[]): Record<string, RefTarget> {
  const m: Record<string, RefTarget> = {}
  for (const r of arr) m[r.ref] = r
  return m
}

export function compactSnapshot(
  raw: AXTreeResponse, tab: BrowserTab, snapshotId: string, opts: SnapshotOptions = {},
): SnapshotResult {
  const maxNodes = opts.maxNodes && opts.maxNodes > 0 ? opts.maxNodes : DEFAULT_MAX_NODES
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : MAX_OUTPUT_CHARS
  const maxDepth = opts.depth && opts.depth > 0 ? opts.depth : DEFAULT_MAX_DEPTH
  const { byId, roots } = indexAndRoots(raw)
  const targetRef = (opts.refId ?? '').trim()

  const w = new Walk(byId, maxNodes, maxChars, maxDepth, targetRef, 0)
  let header = `snapshotId=${snapshotId} url=${quote(tab.url)} title=${quote(tab.title)}\n\n`
  for (const r of roots) w.walk(r, 0)
  if (targetRef !== '' && !w.matchedRef) {
    throw new Error(`ref ${quote(targetRef)} not found in this snapshot; take a fresh browser_snapshot`)
  }
  let text = header + w.out
  if (w.truncated) {
    text += `\n... snapshot truncated at ${maxNodes} nodes / ${maxChars} chars. Narrow it: pass a smaller depth, or focus a subtree with ref_id=<ref>.\n`
  }
  return { text: text.trim(), refs: refsToMap(w.refs), nodeCount: raw.nodes.length, refCount: w.refs.length, truncated: w.truncated }
}

// renderFrameTree: one OOPIF frame, refs starting at refBase, indented under header.
function renderFrameTree(raw: AXTreeResponse, refBase: number, opts: SnapshotOptions): { text: string; refs: RefTarget[] } {
  const maxNodes = opts.maxNodes && opts.maxNodes > 0 ? opts.maxNodes : DEFAULT_MAX_NODES
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : MAX_OUTPUT_CHARS
  const maxDepth = opts.depth && opts.depth > 0 ? opts.depth : DEFAULT_MAX_DEPTH
  const { byId, roots } = indexAndRoots(raw)
  const w = new Walk(byId, maxNodes, maxChars, maxDepth, '', refBase)
  for (const r of roots) w.walk(r, 1)
  return { text: w.out, refs: w.refs }
}

export function compactSnapshotWithFrames(
  raw: AXTreeResponse, frames: FrameAXTree[], tab: BrowserTab, snapshotId: string, opts: SnapshotOptions = {},
): SnapshotResult {
  const base = compactSnapshot(raw, tab, snapshotId, opts)
  if ((opts.refId ?? '') !== '' || frames.length === 0) return base
  let out = base.text
  const refs: RefTarget[] = Object.values(base.refs)
  for (const fr of frames) {
    const { text: ftext, refs: frefs } = renderFrameTree(fr.raw, refs.length, { ...opts, refId: '' })
    if (frefs.length === 0) continue
    out += `\n\n[iframe (cross-origin) ${trimText(fr.url, 120)}]\n` + ftext
    for (const r of frefs) r.sessionId = fr.sessionId
    refs.push(...frefs)
  }
  return { ...base, text: out.trim(), refs: refsToMap(refs), refCount: refs.length }
}
