# Phase 1: Read-Only Tools End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the 13 read-only `browser_*` tools to TS, wire them into the SW dispatcher, flip BOTH routes (content auto-exec + browser-agent sidebar) to send `EXEC_BROWSER_TOOL` instead of POSTing `/exec`, verify end-to-end (including cross-browser + Go-less), then delete the corresponding Go.

**Read-only tools (13):** `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_find`, `browser_console`, `browser_network`, `browser_get_content`, `browser_get_page_text`, `browser_pdf`, `browser_record`, `browser_wait`, `browser_wait_for_function`, `browser_get_attributes`.

**Architecture:** Build `snapshot.ts`, `find.ts`, `image.ts`, `in-page-js.ts`, fill `controller.ts` with these 13 methods, register them in `dispatch.ts` `TOOL_TABLE`, add the `EXEC_BROWSER_TOOL` handler in `index.ts`, and change the two send-sites. Screenshots/PDF/record return base64 (no filesystem in SW).

**Prerequisite:** [Phase 0](2026-06-17-browser-sw-direct-01-phase0-infra.md) complete and green.

---

## File Structure (this phase)

- Create: `extension/src/background/browser/snapshot.ts` — AX tree → compact text (port `snapshot.go`)
- Create: `extension/src/background/browser/find.ts` — element scoring (port `controller_find.go` `Find` + `findElementsExpression`)
- Create: `extension/src/background/browser/image.ts` — screenshot token-budget (OffscreenCanvas), PDF base64, GIF encode
- Create: `extension/src/background/browser/in-page-js.ts` — page JS strings (getContent/getPageText/waitFor/getAttributes)
- Create: `extension/src/background/browser/controller.ts` — controller singleton; this phase adds the 13 read methods
- Modify: `extension/src/background/index.ts` — add `EXEC_BROWSER_TOOL` onMessage handler (near :1024) + feed `chrome.debugger.onEvent` console/network into the EventBus
- Modify: `extension/src/content/index.ts:1417` `executeToolCallRaw` — route read-only browser_* to SW
- Modify: `extension/src/background/browser-agent.ts:382` `execBrowserTool` — route to SW

---

## Task 1.1: `in-page-js.ts` — page JS string builders

**Files:**
- Create: `extension/src/background/browser/in-page-js.ts`
- Test: `extension/src/__tests__/browser-sw/in-page-js.test.ts`

Port the in-page JS expression builders the read tools need, from `controller_ext.go`/`controller_state.go`: `getContentExpression` (innerText/outerHTML/structured, 100 KiB cap), `pageTextExpression` (readability extractor, :249), `waitSelectorExpression`, `waitLoadStateExpression`, `waitForFunctionExpression`, and `getAttributesExpression` (:266). These are pure string builders → trivially testable (assert the returned string contains the right calls + JSON-escaped args).

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/in-page-js.test.ts
import { describe, it, expect } from 'vitest'
import { getContentExpr, waitSelectorExpr, getAttributesExpr } from '../../background/browser/in-page-js'

describe('in-page JS builders', () => {
  it('getContentExpr embeds the mode and caps length', () => {
    const e = getContentExpr('text')
    expect(e).toContain('innerText')
    expect(e).toContain('100000')   // 100 KiB cap
  })
  it('waitSelectorExpr JSON-escapes the selector', () => {
    expect(waitSelectorExpr('a[href="x"]')).toContain(JSON.stringify('a[href="x"]'))
  })
  it('getAttributesExpr targets the selector', () => {
    expect(getAttributesExpr('#id')).toContain(JSON.stringify('#id'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/in-page-js.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Translate each Go expression builder verbatim (they are already JS-as-Go-strings; in TS write them as real template functions). Below are the signatures + the two simplest bodies; port the rest from the named Go ranges 1:1.

```ts
// extension/src/background/browser/in-page-js.ts
// Ported from controller_ext.go / controller_state.go embedded JS strings.

export function getContentExpr(mode: 'text' | 'html' | 'structured'): string {
  // Port of controller_ext.go getContentExpression (100 KiB cap at 100000).
  const pick = mode === 'html' ? 'document.documentElement.outerHTML'
    : mode === 'structured' ? '/* structured walk — port from Go */ document.body && document.body.innerText'
    : 'document.body && document.body.innerText'
  return `(() => { const s = (${pick}) || ''; return s.length > 100000 ? s.slice(0, 100000) + "\\n…[truncated]" : s; })()`
}

export function waitSelectorExpr(selector: string): string {
  return `(() => !!document.querySelector(${JSON.stringify(selector)}))()`
}

export function waitLoadStateExpr(state: 'load' | 'domcontentloaded' | 'networkidle'): string {
  // Port controller_ext.go waitLoadStateExpression.
  if (state === 'domcontentloaded') return `(() => document.readyState !== 'loading')()`
  return `(() => document.readyState === 'complete')()`
}

export function waitForFunctionExpr(expr: string): string {
  return `(() => { try { return !!(${expr}); } catch { return false; } })()`
}

export function getAttributesExpr(selector: string): string {
  // Port controller_state.go:266 GetAttributes expression: attrs + computed styles.
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value;
    const cs = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), attributes: attrs,
      styles: { display: cs.display, visibility: cs.visibility, color: cs.color } }; })()`
}

// pageTextExpr: readability extraction — port controller_ext.go pageTextExpression (~25 LOC).
export function pageTextExpr(): string {
  return `(() => { const t = document.body ? document.body.innerText : ''; return (t||'').slice(0, 100000); })()`
}
```

> **Port note:** `getContentExpr('structured')` and `pageTextExpr()` have richer Go bodies (structured DOM walk / readability). Port those bodies fully from the Go source before marking this task done; the stubs above keep the test green but must be replaced with the real extraction logic to match Go output.

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/in-page-js.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/in-page-js.ts extension/src/__tests__/browser-sw/in-page-js.test.ts
git commit -m "feat(ext/browser): in-page JS builders (in-page-js.ts)"
```

---

## Task 1.2: `snapshot.ts` — AX tree → compact text (highest-risk port)

**Files:**
- Create: `extension/src/background/browser/snapshot.ts`
- Test: `extension/src/__tests__/browser-sw/snapshot.test.ts`

Port `snapshot.go` (439 LOC): `CompactSnapshot` (raw AX tree JSON → indented hierarchy + `refs` map), `CompactSnapshotWithFrames` (merge OOPIF frame trees), `renderFrameTree`, the AX-node walk, `shouldKeepAXNode`, `boundsFromNode`, `compactFlags`, `axValue.String`. **This is the snapshot ref system** — refs assigned here are stored in the registry and resolved by clicks. Behavior must match Go exactly. Use the Go test fixtures as input.

- [ ] **Step 1: Capture a Go AX-tree fixture as test input**

Run: `git grep -l "getFullAXTree\|CompactSnapshot" internal/browser/*_test.go`
Then copy a representative raw AX-tree JSON payload from the Go test (or `internal/browser/snapshot.go` test data) into a TS fixture.

```ts
// extension/src/__tests__/browser-sw/fixtures/ax-tree.ts
// Minimal CDP Accessibility.getFullAXTree payload (mirror a Go test case).
export const AX_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' }, childIds: ['2', '3'], backendDOMNodeId: 100 },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Submit' }, childIds: [], backendDOMNodeId: 101 },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Home' }, childIds: [], backendDOMNodeId: 102 },
  ],
}
```

- [ ] **Step 2: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/snapshot.test.ts
import { describe, it, expect } from 'vitest'
import { compactSnapshot } from '../../background/browser/snapshot'
import { AX_TREE } from './fixtures/ax-tree'

describe('compactSnapshot', () => {
  it('renders an indented hierarchy and assigns refs to interactive nodes', () => {
    const { text, refs } = compactSnapshot(AX_TREE, { tabId: 1, url: 'https://x.com', title: 'Test Page' }, 'snap1', {})
    expect(text).toContain('button "Submit"')
    expect(text).toContain('link "Home"')
    // each interactive node gets a stable ref like [e2]
    const refKeys = Object.keys(refs)
    expect(refKeys.length).toBeGreaterThanOrEqual(2)
    // ref targets carry backendId for later DOM.getBoxModel resolution
    const submit = Object.values(refs).find(r => r.name === 'Submit')
    expect(submit?.backendId).toBe(101)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation (full port of snapshot.go)**

Port `snapshot.go` function-by-function. The public entry returns `{ text, refs }` where `refs` is keyed by ref string (`e<N>`). Mirror Go's ref numbering, indentation, role/name formatting, `shouldKeepAXNode` filter, and OOPIF frame appending (`compactSnapshotWithFrames`). This is ~440 LOC of pure transform — translate it directly; the fixture test + the Go test assertions are the contract.

```ts
// extension/src/background/browser/snapshot.ts
// Full port of internal/browser/snapshot.go (pure AX-tree → text + refs).
import type { BrowserTab, RefTarget, Bounds } from './types'

export interface SnapshotOptions { coordinates?: boolean; maxNodes?: number }
interface AXNode {
  nodeId: string; role?: { value?: string }; name?: { value?: string }
  childIds?: string[]; backendDOMNodeId?: number; ignored?: boolean
  properties?: Array<{ name: string; value?: { value?: any } }>
}

// Roles that get a clickable ref (mirror Go shouldKeepAXNode interactive set).
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem',
  'tab', 'switch', 'searchbox', 'slider', 'option',
])

export function compactSnapshot(
  raw: { nodes: AXNode[] }, tab: BrowserTab, snapshotId: string, opts: SnapshotOptions,
): { text: string; refs: Record<string, RefTarget> } {
  const byId = new Map<string, AXNode>()
  for (const n of raw.nodes) byId.set(n.nodeId, n)
  const refs: Record<string, RefTarget> = {}
  let refCounter = 0
  const lines: string[] = []

  const walk = (id: string, depth: number) => {
    const n = byId.get(id)
    if (!n || n.ignored) return
    const role = n.role?.value || ''
    const name = n.name?.value || ''
    if (shouldKeep(role, name)) {
      let ref = ''
      if (INTERACTIVE.has(role)) {
        ref = `e${++refCounter}`
        refs[ref] = { ref, nodeId: n.nodeId, backendId: n.backendDOMNodeId ?? 0,
          role, name, bounds: null, sessionId: '', frameOffset: null }
      }
      const indent = '  '.repeat(depth)
      const refTag = ref ? ` [${ref}]` : ''
      lines.push(`${indent}${role} ${JSON.stringify(name)}${refTag}`)
    }
    for (const c of n.childIds ?? []) walk(c, depth + (shouldKeep(role, name) ? 1 : 0))
  }
  const root = raw.nodes[0]
  if (root) walk(root.nodeId, 0)
  return { text: lines.join('\n'), refs }
}

function shouldKeep(role: string, name: string): boolean {
  // Port Go shouldKeepAXNode: keep interactive roles + named structural roles.
  if (INTERACTIVE.has(role)) return true
  if (!name) return false
  return ['heading', 'RootWebArea', 'img', 'StaticText', 'list', 'listitem', 'cell', 'row'].includes(role)
}
```

> **Port note:** the stub above passes the fixture test but is a SIMPLIFIED renderer. Before marking done, complete it against `snapshot.go`: `boundsFromNode` (coordinate block when `opts.coordinates`), `compactFlags` (state badges like `checked`/`disabled`/`expanded`), `axValue.String` formatting, `renderFrameTree` + `compactSnapshotWithFrames` (OOPIF append with `refBase` offset and per-frame `sessionId`/`frameOffset` on refs), and `maxNodes` truncation. Add a vitest case per Go snapshot test assertion.

- [ ] **Step 5: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/snapshot.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/browser/snapshot.ts extension/src/__tests__/browser-sw/snapshot.test.ts extension/src/__tests__/browser-sw/fixtures/ax-tree.ts
git commit -m "feat(ext/browser): AX-tree compact snapshot + refs (snapshot.ts)"
```

---

## Task 1.3: `find.ts` — interactive element scoring

**Files:**
- Create: `extension/src/background/browser/find.ts`
- Test: `extension/src/__tests__/browser-sw/find.test.ts`

Port `controller_find.go` `Find` (:16) + `findElementsExpression` (:477, ~125 LOC of in-page JS). The JS scores/ranks interactive elements matching a query in the main frame + OOPIF frames. The in-page JS is a pure string → test by asserting it contains the scoring logic + JSON-escaped query; the orchestration (run JS, merge frames) gets a `Cdp`-injected test.

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/find.test.ts
import { describe, it, expect, vi } from 'vitest'
import { findElementsExpr, find } from '../../background/browser/find'

describe('find', () => {
  it('findElementsExpr embeds the query + limit', () => {
    const e = findElementsExpr('Submit', 10)
    expect(e).toContain(JSON.stringify('Submit'))
    expect(e).toContain('10')
  })
  it('find runs the expr and returns ranked results', async () => {
    const results = [{ text: 'Submit', role: 'button', selector: 'button#go', score: 9 }]
    const cdp = { runtimeEvaluate: vi.fn(async () => results), sendCommand: vi.fn(), callFunctionOnObject: vi.fn() }
    const out = await find(cdp as any, { tabId: 1 }, { query: 'Submit', limit: 10 })
    expect(out[0].text).toBe('Submit')
    expect(cdp.runtimeEvaluate).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/find.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Port `findElementsExpression` verbatim (the 125-LOC scoring JS) and the `Find` orchestration (run on main frame + each OOPIF session, merge, sort by score). Signature locked by the test.

```ts
// extension/src/background/browser/find.ts
import type { Cdp } from './cdp'
type Debuggee = chrome.debugger.Debuggee

export interface FindRequest { tabId: number; query: string; limit?: number }
export interface FoundElement { text: string; role: string; selector: string; score: number }

export function findElementsExpr(query: string, limit: number): string {
  // Port of controller_find.go findElementsExpression (~125 LOC). Below is the shape;
  // replace the body with the full Go scoring logic (text match, role weight,
  // visibility, proximity) before marking done.
  return `(() => {
    const q = ${JSON.stringify(query)}.toLowerCase();
    const limit = ${limit};
    const els = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role],[onclick]'));
    const scored = [];
    for (const el of els) {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!text) continue;
      let score = 0;
      const t = text.toLowerCase();
      if (t === q) score += 10; else if (t.includes(q)) score += 5;
      if (score === 0) continue;
      scored.push({ text: text.slice(0, 120), role: el.getAttribute('role') || el.tagName.toLowerCase(),
        selector: '', score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  })()`
}

export async function find(cdp: Cdp, target: Debuggee, req: FindRequest): Promise<FoundElement[]> {
  const limit = req.limit ?? 20
  const main = (await cdp.runtimeEvaluate(target, findElementsExpr(req.query, limit))) as FoundElement[] || []
  // OOPIF: also run on each child session and merge (port the frame loop from Find).
  return main.sort((a, b) => b.score - a.score).slice(0, limit)
}
```

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/find.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/find.ts extension/src/__tests__/browser-sw/find.test.ts
git commit -m "feat(ext/browser): interactive element find/scoring (find.ts)"
```

---

## Task 1.4: `image.ts` — screenshot budget + PDF/GIF base64

**Files:**
- Create: `extension/src/background/browser/image.ts`
- Test: `extension/src/__tests__/browser-sw/image.test.ts`

Port `screenshot_budget.go` (downscale/re-encode for vision-token budget) using `OffscreenCanvas` + `createImageBitmap` (SW-available), and `screenshot_gif.go` (GIF assembly) using a JS GIF encoder. PDF and screenshot return base64/dataURL (no filesystem). The token-budget downscale math ports directly; the codec changes.

- [ ] **Step 1: Decide GIF encoder + add dep**

Run: `cd extension && npm install gifenc`
Expected: `gifenc` (a small, SW-compatible GIF encoder) added. (If `gifenc` proves unsuitable in SW, fall back to emitting a frames-zip via `fflate`; note the choice in the module header.)

- [ ] **Step 2: Write the failing test**

OffscreenCanvas isn't in jsdom; test the **pure budget math** (target-dimension computation) separately from the canvas call.

```ts
// extension/src/__tests__/browser-sw/image.test.ts
import { describe, it, expect } from 'vitest'
import { budgetTargetDims } from '../../background/browser/image'

describe('image budget', () => {
  it('downscales to fit the max-dimension budget, preserves aspect', () => {
    // port of screenshot_budget.go downscaleBox: cap longest side at maxDim
    expect(budgetTargetDims(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 })
    expect(budgetTargetDims(800, 600, 1000)).toEqual({ width: 800, height: 600 }) // under budget: unchanged
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/image.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```ts
// extension/src/background/browser/image.ts
// Screenshot budget (OffscreenCanvas) + GIF (gifenc). PDF base64 passthrough.

/** Pure: target dims that cap the longest side at maxDim, preserving aspect.
 *  Port of screenshot_budget.go downscaleBox. */
export function budgetTargetDims(w: number, h: number, maxDim: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { width: w, height: h }
  const scale = maxDim / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/** Downscale a base64 PNG/JPEG to the budget and re-encode as JPEG dataURL.
 *  Uses OffscreenCanvas (available in SW). */
export async function budgetScreenshot(base64: string, mime: string, maxDim: number, quality = 0.8): Promise<string> {
  const blob = await (await fetch(`data:${mime};base64,${base64}`)).blob()
  const bmp = await createImageBitmap(blob)
  const { width, height } = budgetTargetDims(bmp.width, bmp.height, maxDim)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, width, height)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const buf = new Uint8Array(await out.arrayBuffer())
  let bin = ''; for (const b of buf) bin += String.fromCharCode(b)
  return `data:image/jpeg;base64,${btoa(bin)}`
}

/** Assemble frames (base64 PNGs) into an animated GIF dataURL. Port of screenshot_gif.go. */
export async function encodeGif(frames: string[], _mime: string, delayMs = 200): Promise<string> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const enc = GIFEncoder()
  for (const f of frames) {
    const blob = await (await fetch(`data:image/png;base64,${f}`)).blob()
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    enc.writeFrame(index, width, height, { palette, delay: delayMs })
  }
  enc.finish()
  const bytes = enc.bytes()
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/gif;base64,${btoa(bin)}`
}
```

- [ ] **Step 5: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/image.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/browser/image.ts extension/src/__tests__/browser-sw/image.test.ts extension/package.json extension/package-lock.json
git commit -m "feat(ext/browser): screenshot budget + GIF encode (image.ts)"
```

---

## Task 1.5: `controller.ts` — the 13 read-only methods + register

**Files:**
- Create: `extension/src/background/browser/controller.ts`
- Test: `extension/src/__tests__/browser-sw/controller-readonly.test.ts`

The controller singleton holds the `TabRegistry`, `EventBus`, `SecurityPolicy`, `Cdp`, and `ApprovalManager`, and exposes the 13 read methods. Each method mirrors its Go counterpart but issues CDP via `cdp.ts` and returns a string (tool output). Then register each into `dispatch.ts` `TOOL_TABLE` + `READONLY_TOOLS`. `ensureTab` (tab resolution + domain enable + AI-page gate) is implemented here.

- [ ] **Step 1: Write the failing test (snapshot tool path, mocked CDP)**

```ts
// extension/src/__tests__/browser-sw/controller-readonly.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

// Stub chrome before importing the controller (it reads chrome.* at call time).
beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: { query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
            get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X' })) },
    runtime: { sendMessage: vi.fn() },
  }
})

describe('controller read-only', () => {
  it('snapshot: enables Accessibility, renders tree, stores refs', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) => {
      if (method === 'Accessibility.getFullAXTree') return AX_TREE
      return {}
    })
    const ctl = makeController({ send })
    const out = await ctl.snapshot({ tabId: 1 })
    expect(out).toContain('button "Submit"')
    // a follow-up click can resolve the ref the snapshot stored
    expect(ctl.registry.resolveRef(1, 'e1')).toBeTruthy()
  })

  it('tabs: lists this browser\'s tabs (no fanout)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: vi.fn(async () => ({})) })
    const out = await ctl.tabs({})
    expect(out).toContain('x.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-readonly.test.ts`
Expected: FAIL — module/`makeController` not found.

- [ ] **Step 3: Write the implementation**

Build `makeController({ send })` returning an object with: `registry`, `events`, `security`, and the 13 methods. Each method ports its Go controller method. `ensureTab` resolves explicit `tabId` → default → (read-only never auto-creates) and runs the AI-page gate. Read methods don't call `approval.ask`. `tabs()` uses `chrome.tabs.query` directly (no fanout — single browser).

```ts
// extension/src/background/browser/controller.ts
import { makeCdp, type Cdp } from './cdp'
import { TabRegistry } from './registry'
import { EventBus } from './events'
import { SecurityPolicy, isAIPage } from './security'
import { compactSnapshot } from './snapshot'
import { find } from './find'
import { budgetScreenshot, encodeGif } from './image'
import { getContentExpr, pageTextExpr, waitSelectorExpr, waitForFunctionExpr, getAttributesExpr } from './in-page-js'
import { safeTitle, type BrowserTab } from './types'

type Debuggee = chrome.debugger.Debuggee

export interface ControllerDeps { send?: (t: Debuggee, m: string, p?: object) => Promise<any> }

export function makeController(deps: ControllerDeps = {}) {
  const cdp: Cdp = makeCdp(deps.send)
  const registry = new TabRegistry()
  const events = new EventBus()
  const security = new SecurityPolicy()
  let snapSeq = 0

  // Resolve the target tab; enforce the AI-page gate (hard refuse).
  async function ensureTab(args: { tabId?: number }): Promise<BrowserTab> {
    let id = (typeof args.tabId === 'number' && args.tabId > 0) ? args.tabId : registry.default()
    if (id == null) {
      // read-only: adopt the active tab of this browser as a transient target
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!active?.id) throw new Error('no controllable tab')
      id = active.id
    }
    const t = await chrome.tabs.get(id)
    const tab: BrowserTab = { tabId: id, url: t.url || '', title: safeTitle(t.title || '') }
    if (isAIPage(tab.url) && !registry.isApproved(id)) {
      throw new Error('refusing to control AI conversation tab by default; use browser_use_tab and approve explicitly')
    }
    registry.upsertTab(tab)
    return tab
  }
  function target(tabId: number): Debuggee { return { tabId } }

  return {
    registry, events, security,

    async snapshot(args: { tabId?: number; coordinates?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      await cdp.sendCommand(target(tab.tabId), 'Accessibility', 'enable')
      const raw = await cdp.sendCommand(target(tab.tabId), 'Accessibility', 'getFullAXTree')
      const id = `snap${++snapSeq}`
      const { text, refs } = compactSnapshot(raw, tab, id, { coordinates: args.coordinates })
      registry.storeSnapshot(tab.tabId, id, refs)
      return text || '(empty snapshot)'
    },

    async tabs(_args: {}): Promise<string> {
      const list = await chrome.tabs.query({})
      return list.map(t => `#${t.id} ${safeTitle(t.title || '')} — ${t.url}`).join('\n') || '(no tabs)'
    },

    async screenshot(args: { tabId?: number; maxDim?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
      const dataUrl = await budgetScreenshot(out.data, 'image/png', args.maxDim ?? 1000)
      return dataUrl   // base64 dataURL; content/sidebar renders it
    },

    async find(args: { tabId?: number; query: string; limit?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const els = await find(cdp, target(tab.tabId), { tabId: tab.tabId, query: args.query, limit: args.limit })
      return els.map(e => `[${e.score}] ${e.role} "${e.text}"`).join('\n') || '(no matches)'
    },

    async getContent(args: { tabId?: number; mode?: 'text' | 'html' | 'structured' }): Promise<string> {
      const tab = await ensureTab(args)
      return (await cdp.runtimeEvaluate(target(tab.tabId), getContentExpr(args.mode ?? 'text'))) || ''
    },

    async getPageText(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      return (await cdp.runtimeEvaluate(target(tab.tabId), pageTextExpr())) || ''
    },

    async getAttributes(args: { tabId?: number; selector: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), getAttributesExpr(args.selector))
      return r ? JSON.stringify(r, null, 2) : `selector ${args.selector} not found`
    },

    async console(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      return events.readConsole(tab.tabId).map(m => `[${m.level}] ${m.text}`).join('\n') || '(no console messages)'
    },

    async network(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      return events.readNetwork(tab.tabId).map(r => `${r.method} ${r.url} ${r.status ?? ''}`).join('\n') || '(no requests)'
    },

    async wait(args: { tabId?: number; selector?: string; timeoutMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const deadline = Date.now() + (args.timeoutMs ?? 5000)
      while (Date.now() < deadline) {
        if (!args.selector) return 'ok'
        if (await cdp.runtimeEvaluate(target(tab.tabId), waitSelectorExpr(args.selector))) return 'ok'
        await new Promise(r => setTimeout(r, 100))
      }
      return `wait timed out${args.selector ? ` for ${args.selector}` : ''}`
    },

    async waitForFunction(args: { tabId?: number; expression: string; timeoutMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const deadline = Date.now() + (args.timeoutMs ?? 5000)
      while (Date.now() < deadline) {
        if (await cdp.runtimeEvaluate(target(tab.tabId), waitForFunctionExpr(args.expression))) return 'ok'
        await new Promise(r => setTimeout(r, 100))
      }
      return 'waitForFunction timed out'
    },

    async pdf(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'printToPDF', {})
      return `data:application/pdf;base64,${out.data}`
    },

    async record(args: { tabId?: number; frames?: number; delayMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const n = args.frames ?? 6
      const shots: string[] = []
      for (let i = 0; i < n; i++) {
        const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
        shots.push(out.data)
        await new Promise(r => setTimeout(r, args.delayMs ?? 200))
      }
      return await encodeGif(shots, 'image/png', args.delayMs ?? 200)
    },
  }
}

export type Controller = ReturnType<typeof makeController>
export const controller = makeController()
```

> **Port note:** `console`/`network` return whatever the EventBus holds; for them to have data, the SW must (Task 1.7) feed `chrome.debugger.onEvent` `Runtime.consoleAPICalled`/`Network.*` into `events`. Enabling the domains (`Runtime.enable`/`Network.enable`) on first read is part of each method's full port — mirror `controller_find.go` ReadConsole/ReadNetwork which enable+read.

- [ ] **Step 4: Register the methods in dispatch**

Add to `dispatch.ts` (append after the `TOOL_TABLE`/`READONLY_TOOLS` declarations):

```ts
// extension/src/background/browser/dispatch.ts  (append)
import { controller } from './controller'

const READ_METHODS: Array<[string, (args: any) => Promise<string>]> = [
  ['browser_snapshot', a => controller.snapshot(a)],
  ['browser_tabs', a => controller.tabs(a)],
  ['browser_screenshot', a => controller.screenshot(a)],
  ['browser_find', a => controller.find(a)],
  ['browser_get_content', a => controller.getContent(a)],
  ['browser_get_page_text', a => controller.getPageText(a)],
  ['browser_get_attributes', a => controller.getAttributes(a)],
  ['browser_console', a => controller.console(a)],
  ['browser_network', a => controller.network(a)],
  ['browser_wait', a => controller.wait(a)],
  ['browser_wait_for_function', a => controller.waitForFunction(a)],
  ['browser_pdf', a => controller.pdf(a)],
  ['browser_record', a => controller.record(a)],
]
for (const [name, fn] of READ_METHODS) { TOOL_TABLE.set(name, fn); READONLY_TOOLS.add(name) }
```

- [ ] **Step 5: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-readonly.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/browser/controller.ts extension/src/background/browser/dispatch.ts extension/src/__tests__/browser-sw/controller-readonly.test.ts
git commit -m "feat(ext/browser): 13 read-only controller methods + register"
```

---

## Task 1.6: SW `EXEC_BROWSER_TOOL` handler + event feed

**Files:**
- Modify: `extension/src/background/index.ts` (onMessage chain near :1024; onEvent near :1127)
- Test: covered by E2E (Task 1.9); add a focused handler test if practical.

- [ ] **Step 1: Add the handler in the onMessage chain**

Insert alongside the existing `if (msg.type === 'FETCH')` blocks (`index.ts:1024+`):

```ts
// extension/src/background/index.ts  (inside chrome.runtime.onMessage.addListener)
import { dispatchBrowserTool } from './browser/dispatch'
import { controller as browserController } from './browser/controller'
import { approval as browserApproval } from './browser/approval-singleton'  // see note

  if (msg.type === 'EXEC_BROWSER_TOOL') {
    const callId = msg.callId || `bsw-${Date.now()}`
    dispatchBrowserTool(msg.name, msg.args || {}, callId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ callId, name: msg.name, output: String(e), error: String(e), success: false }))
    return true   // async response
  }
  if (msg.type === 'BROWSER_APPROVAL_ANSWER') {
    browserApproval.deliver({ approvalId: msg.approvalId, approved: msg.approved, reason: msg.reason, scope: msg.scope })
    sendResponse({ ok: true })
    return true
  }
```

> Create `extension/src/background/browser/approval-singleton.ts` exporting a single `ApprovalManager` instance shared by the controller (Phase 2 wires it into gates) and this handler:
> ```ts
> import { ApprovalManager } from './approval'
> export const approval = new ApprovalManager()
> ```

- [ ] **Step 2: Feed CDP console/network events into the EventBus**

In the existing `chrome.debugger.onEvent.addListener` (`index.ts:1127`), after the current relay logic, also push into the controller's bus:

```ts
// extension/src/background/index.ts  (inside chrome.debugger.onEvent listener)
  if (source.tabId != null) {
    if (method === 'Runtime.consoleAPICalled') {
      browserController.events.recordConsole(source.tabId, {
        level: (params as any).type || 'log',
        text: ((params as any).args || []).map((a: any) => a.value ?? a.description ?? '').join(' '),
      })
    } else if (method === 'Network.responseReceived') {
      const r = (params as any).response || {}
      browserController.events.recordNetwork(source.tabId, { requestId: (params as any).requestId, url: r.url, method: r.method || 'GET', status: r.status })
    }
  }
```

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: builds; `content-build.test.ts` still green (these imports are SW-side only).

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/browser/approval-singleton.ts
git commit -m "feat(ext/browser): SW EXEC_BROWSER_TOOL handler + event feed"
```

---

## Task 1.7: Flip the two routes for read-only tools

**Files:**
- Modify: `extension/src/content/index.ts:1417` `executeToolCallRaw`
- Modify: `extension/src/background/browser-agent.ts:382` `execBrowserTool`

Route read-only `browser_*` to the SW. **Keep `/exec` as the path for everything else** (interactive/write browser tools still go to Go until their phase; file/shell always go to Go). Gate on a tool-name set.

- [ ] **Step 1: content/index.ts — send EXEC_BROWSER_TOOL for read-only browser tools**

In `executeToolCallRaw`, before the `bgFetch('/exec')` call, add:

```ts
// extension/src/content/index.ts  (inside executeToolCallRaw, after the question branch)
  const PHASE1_SW_TOOLS = new Set([
    'browser_snapshot','browser_tabs','browser_screenshot','browser_find','browser_console',
    'browser_network','browser_get_content','browser_get_page_text','browser_pdf','browser_record',
    'browser_wait','browser_wait_for_function','browser_get_attributes',
  ])
  if (typeof toolCall.name === 'string' && PHASE1_SW_TOOLS.has(toolCall.name)) {
    const callId = getToolCallId(toolCall)
    const r: any = await new Promise(res => chrome.runtime.sendMessage(
      { type: 'EXEC_BROWSER_TOOL', name: toolCall.name, args: toolCall.args || {}, callId,
        conversationUrl: location.href }, res))
    if (!r) return `[PierCode] 浏览器工具无响应`
    const out = r.output || r.error || '[PierCode] 空响应'
    return `### ${toolCall.name} #${callId}\n${out}`
  }
```

This adds NO ESM import (uses `chrome.runtime.sendMessage`) — `content-build.test.ts` stays green.

- [ ] **Step 2: browser-agent.ts — route read-only via SW dispatch directly**

`execBrowserTool` runs in the SW already, so it can call `dispatchBrowserTool` in-process instead of `fetch('/exec')` for read-only tools:

```ts
// extension/src/background/browser-agent.ts  (top of execBrowserTool)
import { dispatchBrowserTool } from './browser/dispatch'
import { READONLY_TOOLS } from './browser/dispatch'
// ...
  if (READONLY_TOOLS.has(name)) {
    const r = await dispatchBrowserTool(name, args, cid)
    return { call_id: cid, name, output: r.output, success: r.success }
  }
```

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm test -- src/__tests__/content-build.test.ts`
Expected: type-clean; content-build green.

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/index.ts extension/src/background/browser-agent.ts
git commit -m "feat(ext/browser): route read-only browser_* to SW (both routes)"
```

---

## Task 1.8: End-to-end verification (new chain + cross-browser + Go-less)

**Files:** none (manual + script verification).

- [ ] **Step 1: Build + load**

Run: `cd extension && npm run build`
Load `extension/dist` unpacked in Chrome.

- [ ] **Step 2: Verify read-only tools on the new chain**

Open the browser-agent sidebar, run a task that triggers: `browser_snapshot`, `browser_screenshot`, `browser_get_page_text`. Confirm in the SW console (chrome://extensions → service worker) that `EXEC_BROWSER_TOOL` fired and **no `/exec` POST** went out for these tools (Network tab on the SW). Screenshot renders from the returned dataURL.

- [ ] **Step 3: Cross-browser non-interference**

Start one Go server. Connect TWO Chrome instances (each with the extension). In each, run a `browser_snapshot` task simultaneously. Confirm each operates only on its own browser's tab and neither answers "No tab with id" for the other — the old broadcast race is gone because reads never traverse the server.

- [ ] **Step 4: Go-less read-only**

Stop the Go server. In the browser-agent sidebar, run a read-only task (snapshot + get_page_text). Confirm it still works — these no longer need `/exec`. (Note: the prompt fetch may still need the server; if so, document that the first prompt load needs the server but tool execution does not.)

- [ ] **Step 5: Record results**

Note any divergence from Go output format. Fix in the TS port. Re-run `npm test`.

---

## Task 1.9: Delete the Go for read-only tools

**Files:**
- Modify: `internal/executor/executor.go` (unregister 13 read tools)
- Delete: read-only tool structs + their controller methods + helpers + tests

Only after Tasks 1.1–1.8 are green.

- [ ] **Step 1: Unregister the 13 read tools in executor.go**

Remove the `reg.Register(...)` lines for the 13 read-only browser tools in `New()` (executor.go:139-182 region). Remove them from `isReadOnlyTool()` (executor.go:577-582).

- [ ] **Step 2: Delete the tool structs**

Delete the read-only tool definitions from `internal/tool/browser_tools.go` (snapshot/screenshot/record/tabs), `browser_tools_ext.go` (wait/wait_for_function/get_content/get_page_text/pdf), `browser_tools_find.go` (find/console/network), `browser_tools_state.go` (get_attributes). Leave interactive/write tools (Phase 2/3).

- [ ] **Step 3: Delete now-unused controller methods + helpers**

Delete `Snapshot`/`Screenshot`/`RecordGIF`/`ListTabs`/`Wait`/`WaitForFunction`/`GetContent`/`GetPageText`/`PDF`/`Find`/`ReadConsole`/`ReadNetwork`/`GetAttributes` from `controller*.go`, plus helpers now unreferenced (`snapshot.go` entirely, `screenshot_budget.go`, `screenshot_gif.go`, `collectFrameAXTrees`, find helpers). Remove the matching entries from the `BrowserController` interface in `tool.go`. **Run `go build` after each deletion to catch references** — some helpers are shared with Phase 2/3 tools (e.g. `runtimeEvaluate`); keep those.

- [ ] **Step 4: Delete the replaced Go tests**

Delete `internal/browser/controller_find_test.go` (find/console/network) and the snapshot/screenshot test cases now covered by vitest. Keep tests for methods still in Go.

- [ ] **Step 5: Gate — all green**

Run: `go test ./... && go build ./cmd/server`
Run: `cd extension && npx tsc --noEmit && npm test`
Expected: all green. Go no longer has the 13 read tools; TS owns them.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(browser): remove Go read-only browser tools (now SW-native)"
```

**Phase 1 done.** 13 read-only tools run in the SW end-to-end; cross-browser race solved for reads; Go-less reads verified. Proceed to [Phase 2](2026-06-17-browser-sw-direct-03-phase2-interactive.md).
