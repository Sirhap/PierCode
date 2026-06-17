# Phase 2: Interactive Tools + Approval-Flow SW-ification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the 20 interactive `browser_*` tools to TS, build the input-dispatch layer + marks overlay, wire the approval gate (Gate A AI-page + Gate B action-approval) into the SW dispatcher with a UI round-trip, flip routes, verify (incl. approval cards + sensitive hard-refuse), delete the corresponding Go.

**Interactive tools (20):** `browser_click`, `browser_type`, `browser_hover`, `browser_scroll`, `browser_select`, `browser_press_key`, `browser_drag`, `browser_focus`, `browser_navigate`, `browser_new_tab`, `browser_use_tab`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_mark`, `browser_handle_dialog`, `browser_wait_for_navigation`, `browser_resize`, `browser_viewport`, `browser_emulate`.

**Architecture:** Build `input.ts` (click/move/type/keychord/wheel/drag + input-fidelity timing) and `marks.ts` (enumerate + SVG overlay). Add the 20 methods to `controller.ts`. Wire gates into `dispatch.ts`: sensitive hard-refuse + checkNavigate (security), AI-page gate (in `ensureTab`), and `approval.ask` for the ~16 approval-requiring actions. The approval prompt round-trips to the UI via the `BROWSER_APPROVAL_ASK`/`_ANSWER` messages built in Phase 0/1.

**Prerequisite:** [Phase 1](2026-06-17-browser-sw-direct-02-phase1-readonly.md) complete and green.

---

## File Structure (this phase)

- Create: `extension/src/background/browser/input.ts` — `dispatchClick`/`moveTo`/`dispatchTypedKeys`/`dispatchKeyChord`/`dispatchMouseWheel`/`dispatchDrag` + fidelity timing (port controller.go input helpers + input_fidelity.go)
- Create: `extension/src/background/browser/marks.ts` — `enumerateInteractive` + SVG overlay inject/clear (port marks.go)
- Modify: `extension/src/background/browser/controller.ts` — add 20 interactive methods + `actionClassFor` + gate calls
- Modify: `extension/src/background/browser/dispatch.ts` — register interactive tools; add security + approval gate orchestration
- Modify: `extension/src/content/index.ts` + `extension/src/background/browser-agent.ts` — extend the SW-routed tool set to include these 20
- Modify: approval UI — confirm `content/question-approval.ts` + sidebar `ApprovalCard.tsx`/`browser-agent-store.ts` handle `BROWSER_APPROVAL_ASK`/`_DONE` runtime messages and reply `BROWSER_APPROVAL_ANSWER`

---

## Task 2.1: `input.ts` — input dispatch + fidelity

**Files:**
- Create: `extension/src/background/browser/input.ts`
- Test: `extension/src/__tests__/browser-sw/input.test.ts`

Port `dispatchClick` (controller.go:1538), `moveTo` (:1519, lerp interpolation), `dispatchTypedKeys`/`sendOneRune`/`sendNamedKey` (:1579), `dispatchKeyChord`/`parseKeyChord` (controller_ext.go:1195/1450, key-name + modifier-bitmask tables), `dispatchMouseWheel` (:1072), `dispatchDrag`/`dispatchHTML5Drag` (:1107/1145), and the `InputFidelity` timing knobs (input_fidelity.go). All issue `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`/`Input.insertText`. Pure given an injected `Cdp` + sleep.

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/input.test.ts
import { describe, it, expect, vi } from 'vitest'
import { dispatchClick, parseKeyChord, moveTo } from '../../background/browser/input'

const noSleep = async () => {}

describe('input dispatch', () => {
  it('dispatchClick: move → mousePressed → mouseReleased (3-phase)', async () => {
    const calls: string[] = []
    const cdp = { sendCommand: vi.fn(async (_t, _d, method) => { calls.push(method); return {} }),
                  runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    await dispatchClick(cdp as any, { tabId: 1 }, { x: 10, y: 20 }, { button: 'left', moveSteps: 1, holdMs: 0, sleep: noSleep })
    // last two must be press then release
    expect(calls.filter(m => m === 'dispatchMouseEvent').length).toBeGreaterThanOrEqual(3)
  })
  it('parseKeyChord: Ctrl+A → modifier bitmask + key', () => {
    const chord = parseKeyChord('Ctrl+a')
    expect(chord.modifiers & 2).toBe(2)   // Ctrl bit = 2 in CDP
    expect(chord.key.toLowerCase()).toBe('a')
  })
  it('moveTo: emits interpolated mouseMoved events', async () => {
    const cdp = { sendCommand: vi.fn(async () => ({})), runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    await moveTo(cdp as any, { tabId: 1 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { moveSteps: 5, sleep: noSleep })
    expect(cdp.sendCommand.mock.calls.length).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/input.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation (port, anchored to Go)**

```ts
// extension/src/background/browser/input.ts
import type { Cdp } from './cdp'
import type { Point } from './types'
type Debuggee = chrome.debugger.Debuggee
type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise(r => setTimeout(r, ms))

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8 (mirror controller_ext.go tables).
const MOD: Record<string, number> = {
  alt: 1, option: 1,
  ctrl: 2, control: 2,
  meta: 4, cmd: 4, command: 4,
  shift: 8,
}

export function parseKeyChord(chord: string): { modifiers: number; key: string } {
  const parts = chord.split('+').map(s => s.trim()).filter(Boolean)
  let modifiers = 0
  let key = ''
  for (const p of parts) {
    const lk = p.toLowerCase()
    if (lk in MOD) modifiers |= MOD[lk]
    else key = p
  }
  return { modifiers, key }
}

function lerpPoints(a: Point, b: Point, steps: number): Point[] {
  const out: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}

export interface MoveOpts { moveSteps?: number; sleep?: Sleep; from?: Point }
export async function moveTo(cdp: Cdp, target: Debuggee, from: Point, to: Point, opts: MoveOpts = {}): Promise<void> {
  const steps = Math.max(1, opts.moveSteps ?? 5)
  const sleep = opts.sleep ?? defaultSleep
  for (const p of lerpPoints(from, to, steps)) {
    await cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(1)
  }
}

export interface ClickOpts { button?: 'left' | 'right' | 'middle'; moveSteps?: number; holdMs?: number; sleep?: Sleep; from?: Point }
export async function dispatchClick(cdp: Cdp, target: Debuggee, p: Point, opts: ClickOpts = {}): Promise<void> {
  const button = opts.button ?? 'left'
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4
  const sleep = opts.sleep ?? defaultSleep
  await moveTo(cdp, target, opts.from ?? p, p, { moveSteps: opts.moveSteps, sleep })
  await cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, buttons, clickCount: 1 })
  await sleep(opts.holdMs ?? 30)
  await cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, buttons, clickCount: 1 })
}

export async function dispatchMouseWheel(cdp: Cdp, target: Debuggee, p: Point, dx: number, dy: number): Promise<void> {
  await cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy })
}

export async function dispatchKeyChord(cdp: Cdp, target: Debuggee, chord: string): Promise<void> {
  const { modifiers, key } = parseKeyChord(chord)
  await cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyDown', modifiers, key, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined })
  await cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', modifiers, key })
}

export async function dispatchTypedKeys(cdp: Cdp, target: Debuggee, text: string, sleep: Sleep = defaultSleep): Promise<void> {
  // Port controller.go dispatchTypedKeys: per-rune keyDown/keyUp for ASCII, insertText for CJK/emoji.
  for (const ch of [...text]) {
    if (ch.charCodeAt(0) < 128) {
      await cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', key: ch })
    } else {
      await cdp.sendCommand(target, 'Input', 'insertText', { text: ch })
    }
    await sleep(1)
  }
}
```

> **Port note:** the full Go versions include input-fidelity jitter (`input_fidelity.go` 7 knobs: move steps, click-hold, inter-key delay, etc.), HTML5 drag (`dispatchHTML5Drag` + `html5DragScript`), and read-back verification hooks. Port those before marking done; the stubs above pass the tests and carry the 3-phase/lerp/modifier-table structure. Mirror `controller_key_test.go` for chord cases.

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/input.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/input.ts extension/src/__tests__/browser-sw/input.test.ts
git commit -m "feat(ext/browser): input dispatch + fidelity (input.ts)"
```

---

## Task 2.2: `marks.ts` — interactive enumeration + overlay

**Files:**
- Create: `extension/src/background/browser/marks.ts`
- Test: `extension/src/__tests__/browser-sw/marks.test.ts`

Port `marks.go`: `enumerateInteractive` + `markCollectorExpression` (~70 LOC JS), `buildMarkOverlayExpression` (SVG inject), `buildClearOverlayExpression`. Pure string builders + a `Cdp`-driven orchestration that stores results in the registry (`setMarks`).

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/marks.test.ts
import { describe, it, expect } from 'vitest'
import { markCollectorExpr, buildMarkOverlayExpr, buildClearOverlayExpr } from '../../background/browser/marks'

describe('marks', () => {
  it('collector returns numbered interactive elements', () => {
    expect(markCollectorExpr()).toContain('getBoundingClientRect')
  })
  it('overlay builder injects an SVG layer with the marks', () => {
    const e = buildMarkOverlayExpr([{ mark: 1, role: 'button', name: 'Go', bounds: { x: 1, y: 2, width: 3, height: 4 } }])
    expect(e).toContain('svg')
    expect(e).toContain('piercode-marks')
  })
  it('clear removes the overlay', () => {
    expect(buildClearOverlayExpr()).toContain('piercode-marks')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/marks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/background/browser/marks.ts
import type { MarkedElement } from './registry'

export function markCollectorExpr(): string {
  // Port marks.go markCollectorExpression (~70 LOC). Returns [{mark,role,name,bounds}].
  return `(() => {
    const sel = 'a,button,input,select,textarea,[role="button"],[onclick]';
    const els = Array.from(document.querySelectorAll(sel)).filter(el => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      return { mark: i + 1, role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height } };
    });
  })()`
}

export function buildMarkOverlayExpr(marks: MarkedElement[]): string {
  return `(() => {
    const old = document.getElementById('piercode-marks'); if (old) old.remove();
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.id = 'piercode-marks';
    svg.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const marks = ${JSON.stringify(marks)};
    for (const m of marks) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', m.bounds.x); rect.setAttribute('y', m.bounds.y);
      rect.setAttribute('width', m.bounds.width); rect.setAttribute('height', m.bounds.height);
      rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', '#0ff'); rect.setAttribute('stroke-width', '2');
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', m.bounds.x + 2); label.setAttribute('y', m.bounds.y + 12);
      label.setAttribute('fill', '#0ff'); label.textContent = String(m.mark);
      svg.appendChild(rect); svg.appendChild(label);
    }
    document.documentElement.appendChild(svg);
    return marks.length;
  })()`
}

export function buildClearOverlayExpr(): string {
  return `(() => { const el = document.getElementById('piercode-marks'); if (el) el.remove(); return true; })()`
}
```

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/marks.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/marks.ts extension/src/__tests__/browser-sw/marks.test.ts
git commit -m "feat(ext/browser): interactive marks + SVG overlay (marks.ts)"
```

---

## Task 2.3: Gate orchestration in dispatch.ts (security + approval)

**Files:**
- Modify: `extension/src/background/browser/dispatch.ts`
- Modify: `extension/src/background/browser/controller.ts` — add `actionClassFor` + expose `security`/registry to the gate
- Test: `extension/src/__tests__/browser-sw/gate.test.ts`

Wire the gates so an interactive tool is: (1) sensitive hard-refused (`security.isSensitive(tab)` → throw), (2) AI-page gated (already in `ensureTab`), (3) approval-gated via `approval.ask` with the right `actionClass`. `actionClassFor` ports controller.go:1243 (evaluate/cookie/clipboard/upload/dialog/interact).

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/__tests__/browser-sw/gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { actionClassFor, runGates } from '../../background/browser/dispatch'

describe('gates', () => {
  it('actionClassFor coarsens action → class', () => {
    expect(actionClassFor('browser_evaluate')).toBe('evaluate')
    expect(actionClassFor('browser_set_cookie')).toBe('cookie')
    expect(actionClassFor('browser_clipboard')).toBe('clipboard')
    expect(actionClassFor('browser_upload')).toBe('upload')
    expect(actionClassFor('browser_handle_dialog')).toBe('dialog')
    expect(actionClassFor('browser_click')).toBe('interact')
  })
  it('sensitive page hard-refuses (no approval prompt)', async () => {
    const approval = { ask: vi.fn(), hasGrant: () => false }
    const security = { isSensitive: () => true }
    await expect(runGates({ name: 'browser_click', tab: { tabId: 1, url: 'https://bank.com', title: '' },
      needsApproval: true, approval: approval as any, security: security as any })).rejects.toThrow(/sensitive/)
    expect(approval.ask).not.toHaveBeenCalled()
  })
  it('non-sensitive interactive asks approval', async () => {
    const approval = { ask: vi.fn(async () => {}), hasGrant: () => false }
    const security = { isSensitive: () => false }
    await runGates({ name: 'browser_click', tab: { tabId: 1, url: 'https://x.com', title: '' },
      needsApproval: true, approval: approval as any, security: security as any })
    expect(approval.ask).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/gate.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Write the implementation**

```ts
// extension/src/background/browser/dispatch.ts  (append)
import type { ApprovalManager } from './approval'
import type { SecurityPolicy } from './security'
import type { BrowserTab } from './types'

/** Port controller.go:1243 actionClassFor — high-risk actions get isolated classes. */
export function actionClassFor(name: string): string {
  if (name === 'browser_evaluate') return 'evaluate'
  if (name === 'browser_set_cookie' || name === 'browser_cookies') return 'cookie'
  if (name === 'browser_clipboard') return 'clipboard'
  if (name === 'browser_upload' || name === 'browser_attachment_upload') return 'upload'
  if (name === 'browser_handle_dialog') return 'dialog'
  return 'interact'
}

export interface GateCtx {
  name: string; tab: BrowserTab; needsApproval: boolean
  approval: ApprovalManager; security: SecurityPolicy
}
export async function runGates(ctx: GateCtx): Promise<void> {
  // Gate: sensitive page hard-refuse (NOT approval).
  if (ctx.security.isSensitive(ctx.tab)) {
    throw new Error(`${ctx.name} refused on sensitive payment/financial page`)
  }
  // Gate: action approval.
  if (ctx.needsApproval) {
    const host = (() => { try { return new URL(ctx.tab.url).hostname } catch { return '' } })()
    await ctx.approval.ask({ host, actionClass: actionClassFor(ctx.name), action: ctx.name, callId: '' })
  }
}

// Tools that require Gate-B approval (mirror the 18 c.ask sites).
export const APPROVAL_TOOLS = new Set([
  'browser_click','browser_type','browser_hover','browser_select','browser_press_key','browser_drag',
  'browser_form_input','browser_evaluate','browser_clipboard','browser_upload','browser_handle_dialog',
  'browser_cookies','browser_set_cookie','browser_use_tab','browser_finalize_tabs',
  // cross-origin nav approval is decided inside the navigate method (origin compare)
])
```

Then **update the Phase-0 `dispatchBrowserTool`** to resolve the tab and run gates before invoking the method. Replace its body with:

```ts
// extension/src/background/browser/dispatch.ts  (REPLACE the Phase-0 dispatchBrowserTool body)
import { controller } from './controller'
import { approval } from './approval-singleton'
import type { BrowserTab } from './types'

export async function dispatchBrowserTool(
  name: string, args: Record<string, unknown>, callId: string,
): Promise<ExecResult> {
  const method = TOOL_TABLE.get(name)
  if (!method) return { callId, name, output: `unknown browser tool: ${name}`, error: 'unknown tool', success: false }
  const key = browserTabKey(args)
  try {
    const output = await lock.run(key, async () => {
      // Gate before mutating tools (read-only tools skip gates entirely).
      if (!READONLY_TOOLS.has(name)) {
        const tab = await controller.resolveTabForGate(args as { tabId?: number })  // cheap chrome.tabs.get + AI-page gate
        await runGates({ name, tab, needsApproval: APPROVAL_TOOLS.has(name),
          approval, security: controller.security })
      }
      return method(args)
    })
    return { callId, name, output, success: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { callId, name, output: msg, error: msg, success: false }
  }
}
```

Add `resolveTabForGate` to the controller (a thin wrapper around the same `ensureTab` logic, exported so the dispatcher can pre-resolve the tab for the gate without double-creating):

```ts
// extension/src/background/browser/controller.ts  (export from makeController return)
    async resolveTabForGate(args: { tabId?: number }): Promise<BrowserTab> { return ensureTab(args) },
```

Note `approval.ask` inside `runGates` is passed an empty `callId`; set it from the dispatch `callId` if you want the approval card to correlate (pass `callId` through `GateCtx`).

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/gate.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/dispatch.ts extension/src/background/browser/controller.ts extension/src/__tests__/browser-sw/gate.test.ts
git commit -m "feat(ext/browser): security + approval gate orchestration"
```

---

## Task 2.4: 20 interactive controller methods + register

**Files:**
- Modify: `extension/src/background/browser/controller.ts`
- Modify: `extension/src/background/browser/dispatch.ts`
- Test: `extension/src/__tests__/browser-sw/controller-interactive.test.ts`

Add the 20 methods, each porting its Go counterpart and using `input.ts`/`marks.ts`/`ref-resolve.ts`. `click` resolves point → sensitivity gate (in runGates) → hit-test → approval (in runGates) → dispatchClick → `markStale`. `navigate` does cross-origin approval inside the method (origin compare via `sameRegistrableHost`/`originOf`). `new_tab`/`use_tab` manage the registry + `markApproved` for AI pages. Every mutating method calls `registry.markStale(tabId)`.

- [ ] **Step 1: Write the failing test (click path)**

```ts
// extension/src/__tests__/browser-sw/controller-interactive.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'
beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: { query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
            get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X' })) },
    runtime: { sendMessage: vi.fn() },
  }
})

describe('controller interactive', () => {
  it('click by ref: resolves, dispatches, marks snapshot stale', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) => {
      if (method === 'Accessibility.getFullAXTree') return AX_TREE
      if (method === 'DOM.getBoxModel') return { model: { content: [0,0,10,0,10,10,0,10] } }
      if (method === 'Runtime.evaluate') return { result: { value: true } }   // hit-test ok
      return {}
    })
    const ctl = makeController({ send })
    await ctl.snapshot({ tabId: 1 })                 // creates ref e1
    const before = ctl.registry.resolveRef(1, 'e1'); expect(before).toBeTruthy()
    await ctl.click({ tabId: 1, ref: 'e1' })
    expect(ctl.registry.resolveRef(1, 'e1')).toBeNull()  // mutating → stale
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-interactive.test.ts`
Expected: FAIL — `click` not defined.

- [ ] **Step 3: Write the implementation (representative methods; port the rest 1:1)**

Add to the object returned by `makeController`. Below: `click`, `type`, `navigate` as the templates; port the other 17 from their Go methods using the same structure (resolve via `ref-resolve`, act via `input`, `markStale` after).

```ts
// extension/src/background/browser/controller.ts  (add inside makeController return, importing from ./input, ./ref-resolve, ./marks)
    async click(args: { tabId?: number; ref?: string; selector?: string; mark?: number; x?: number; y?: number; button?: 'left'|'right'|'middle' }): Promise<string> {
      const tab = await ensureTab(args)
      const { point, sessionId } = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ...args })
      const tgt = sessionId ? { tabId: tab.tabId, sessionId } : target(tab.tabId)
      await assertPointActionable(cdp, tgt, point)
      const from = registry.lastPointerOf(tab.tabId) ?? point
      await dispatchClick(cdp, tgt, point, { button: args.button, from })
      registry.setLastPointer(tab.tabId, point)
      registry.markStale(tab.tabId)
      return `clicked at (${Math.round(point.x)},${Math.round(point.y)})`
    },

    async type(args: { tabId?: number; ref?: string; selector?: string; text: string; clear?: boolean; submit?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      const { point, sessionId } = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ...args })
      const tgt = sessionId ? { tabId: tab.tabId, sessionId } : target(tab.tabId)
      await dispatchClick(cdp, tgt, point, {})         // focus
      if (args.clear) {
        const selectAll = navigator.platform.toLowerCase().includes('mac') ? 'Meta+a' : 'Ctrl+a'
        await dispatchKeyChord(cdp, tgt, selectAll)
        await dispatchKeyChord(cdp, tgt, 'Backspace')
      }
      await dispatchTypedKeys(cdp, tgt, args.text)
      if (args.submit) await dispatchKeyChord(cdp, tgt, 'Enter')
      registry.markStale(tab.tabId)
      return `typed ${args.text.length} chars`
    },

    async navigate(args: { tabId?: number; url: string }): Promise<string> {
      const tab = await ensureTab(args)
      const navErr = checkNavigate(args.url)
      if (navErr) throw new Error(navErr)
      // cross-origin → approval (port controller.go Navigate gate)
      if (!sameRegistrableHost(tab.url, args.url)) {
        await approval.ask({ host: (()=>{try{return new URL(args.url).hostname}catch{return ''}})(),
          actionClass: 'interact', action: 'browser_navigate cross-origin', callId: '' })
      }
      await cdp.sendCommand(target(tab.tabId), 'Page', 'enable')
      await cdp.sendCommand(target(tab.tabId), 'Page', 'navigate', { url: args.url })
      registry.markStale(tab.tabId)
      registry.upsertTab({ tabId: tab.tabId, url: args.url, title: tab.title })
      return `navigated to ${args.url}`
    },
```

(Import `checkNavigate`, `sameRegistrableHost` from `./security`; `resolvePoint`, `assertPointActionable` from `./ref-resolve`; `dispatchClick`, `dispatchTypedKeys`, `dispatchKeyChord` from `./input`; and the shared `approval` singleton from `./approval-singleton`.)

> **Port note:** add the remaining 17 (`hover`/`scroll`/`select`/`press_key`/`drag`/`focus`/`new_tab`/`use_tab`/`go_back`/`go_forward`/`reload`/`mark`/`handle_dialog`/`wait_for_navigation`/`resize`/`viewport`/`emulate`) by translating their Go methods. `mark` uses `marks.ts` + `registry.setMarks`. `use_tab` calls `registry.markApproved` after approval. `new_tab` pre-approves AI pages it opens (and skips approval/`setDefault` for `?piercode_agent=` worker tabs — port `isWorkerAgentURL`). `handle_dialog`/`wait_for_navigation` use the EventBus waiters. Each mutating method ends with `registry.markStale`.

- [ ] **Step 4: Register interactive tools in dispatch**

```ts
// extension/src/background/browser/dispatch.ts  (append)
const INTERACTIVE_METHODS: Array<[string, (a: any) => Promise<string>]> = [
  ['browser_click', a => controller.click(a)],
  ['browser_type', a => controller.type(a)],
  ['browser_navigate', a => controller.navigate(a)],
  ['browser_hover', a => controller.hover(a)],
  ['browser_scroll', a => controller.scroll(a)],
  ['browser_select', a => controller.select(a)],
  ['browser_press_key', a => controller.pressKey(a)],
  ['browser_drag', a => controller.drag(a)],
  ['browser_focus', a => controller.focus(a)],
  ['browser_new_tab', a => controller.newTab(a)],
  ['browser_use_tab', a => controller.useTab(a)],
  ['browser_go_back', a => controller.goBack(a)],
  ['browser_go_forward', a => controller.goForward(a)],
  ['browser_reload', a => controller.reload(a)],
  ['browser_mark', a => controller.mark(a)],
  ['browser_handle_dialog', a => controller.handleDialog(a)],
  ['browser_wait_for_navigation', a => controller.waitForNavigation(a)],
  ['browser_resize', a => controller.resize(a)],
  ['browser_viewport', a => controller.viewport(a)],
  ['browser_emulate', a => controller.emulate(a)],
]
for (const [name, fn] of INTERACTIVE_METHODS) TOOL_TABLE.set(name, fn)
```

- [ ] **Step 5: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-interactive.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/browser/controller.ts extension/src/background/browser/dispatch.ts extension/src/__tests__/browser-sw/controller-interactive.test.ts
git commit -m "feat(ext/browser): 20 interactive controller methods + register"
```

---

## Task 2.5: UI approval round-trip + flip routes

**Files:**
- Modify: `extension/src/content/question-approval.ts` — handle `BROWSER_APPROVAL_ASK`/`BROWSER_APPROVAL_DONE` runtime messages, render card, reply `BROWSER_APPROVAL_ANSWER`
- Modify: `extension/src/sidebar/browser-agent-store.ts` + `ApprovalCard.tsx` — same for the sidebar route
- Modify: `extension/src/content/index.ts` + `extension/src/background/browser-agent.ts` — extend SW-routed set to the 20 interactive tools

- [ ] **Step 1: content approval card via runtime message**

In `content/question-approval.ts`, add a `chrome.runtime.onMessage` listener for `BROWSER_APPROVAL_ASK` that renders the existing approval card UI and, on the user's choice, replies:

```ts
// extension/src/content/question-approval.ts  (add listener)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'BROWSER_APPROVAL_ASK') {
    showApprovalCard(msg.action, msg.options, msg.host).then((choice) => {
      chrome.runtime.sendMessage({ type: 'BROWSER_APPROVAL_ANSWER', approvalId: msg.approvalId,
        approved: choice.approved, scope: choice.scope, reason: choice.reason })
    })
  }
  if (msg?.type === 'BROWSER_APPROVAL_DONE') dismissApprovalCard(msg.approvalId)
})
```

(Reuse the existing card renderer in `question-approval.ts`; no `/exec`/WS involved.)

- [ ] **Step 2: sidebar approval card**

In `browser-agent-store.ts`, route `BROWSER_APPROVAL_ASK` to the existing `ApprovalCard.tsx` and reply `BROWSER_APPROVAL_ANSWER`. (The store already handles `BROWSER_AGENT_APPROVAL`; add the new message type or unify.)

- [ ] **Step 3: Extend SW-routed tool set (both routes)**

In `content/index.ts` `PHASE1_SW_TOOLS` → rename to `SW_BROWSER_TOOLS` and add the 20 interactive names. In `browser-agent.ts` `execBrowserTool`, route ALL tools now in `TOOL_TABLE` through `dispatchBrowserTool` (not just read-only):

```ts
// extension/src/background/browser-agent.ts
import { TOOL_TABLE } from './browser/dispatch'
  if (TOOL_TABLE.has(name)) {
    const r = await dispatchBrowserTool(name, args, cid)
    return { call_id: cid, name, output: r.output, success: r.success }
  }
```

- [ ] **Step 4: Type-check + build + content-build green**

Run: `cd extension && npx tsc --noEmit && npm test`
Expected: all pass incl. content-build.

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/question-approval.ts extension/src/content/index.ts extension/src/sidebar/browser-agent-store.ts extension/src/sidebar/ApprovalCard.tsx extension/src/background/browser-agent.ts
git commit -m "feat(ext/browser): SW approval round-trip + route interactive tools to SW"
```

---

## Task 2.6: End-to-end verification

- [ ] **Step 1: Build + load**, then in the browser-agent sidebar run an interactive task: navigate → click → type → submit.
- [ ] **Step 2: Approval card** pops for click/type; approve and confirm the action runs; reject and confirm it aborts with the rejection reason.
- [ ] **Step 3: Sensitive hard-refuse** — navigate to a page whose URL contains `checkout`; confirm `browser_click` is refused (not prompted).
- [ ] **Step 4: AI-page gate** — try to drive the user's own AI tab without `browser_use_tab`; confirm refusal.
- [ ] **Step 5: Cross-browser** — two Chromes, simultaneous interactive tasks; confirm no cross-talk.
- [ ] **Step 6: Per-tab serialization** — two tabs, interleaved clicks; confirm same-tab steps stay ordered, different-tab run in parallel.

---

## Task 2.7: Delete the Go for interactive tools

- [ ] **Step 1:** Unregister the 20 interactive tools in `executor.go` `New()`.
- [ ] **Step 2:** Delete their tool structs from `internal/tool/browser_tools*.go`.
- [ ] **Step 3:** Delete the controller methods (`Click`/`Type`/`Hover`/`Scroll`/`Select`/`PressKey`/`Drag`/`Focus`/`Navigate`/`NavigateWithBeforeunload`/`NewTab`/`UseTab`/`GoBack`/`GoForward`/`Reload`/`Mark`/`HandleDialog`/`WaitForNavigation`/`Resize`/`Viewport`/`Emulate`) + now-unused helpers (`input_fidelity.go`, `marks.go`, click/type/key dispatch helpers) from `controller*.go`. Remove from `BrowserController` interface. `go build` after each deletion.
- [ ] **Step 4:** Delete replaced Go tests (`controller_click_test.go`, `controller_key_test.go`, `controller_ext_test.go` interactive cases, `controller_state_test.go` for moved methods).
- [ ] **Step 5: Gate** — `go test ./... && go build ./cmd/server` + `cd extension && npx tsc --noEmit && npm test` all green.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(browser): remove Go interactive browser tools (now SW-native)"
```

**Phase 2 done.** Interactive tools + approval flow run in the SW. Proceed to [Phase 3](2026-06-17-browser-sw-direct-04-phase3-write.md).
