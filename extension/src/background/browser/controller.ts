// SW-side browser controller. Holds TabRegistry / EventBus / SecurityPolicy / Cdp
// and exposes one method per browser_* tool. Phase 1 adds the 13 read-only methods;
// interactive (Phase 2) and write (Phase 3) methods are added to the same object.
//
// `send` (low-level CDP transport) is injected: tests pass a mock; production passes
// an attach-ensuring wrapper (wired in background/index.ts). Methods issue CDP via
// the Cdp wrappers and return a string (the tool output text).
import { makeCdp, type Cdp } from './cdp'
import { TabRegistry } from './registry'
import { EventBus } from './events'
import { SecurityPolicy, isAIPage, checkNavigate, sameRegistrableHost, originOf } from './security'
import { compactSnapshotWithFrames } from './snapshot'
import { find } from './find'
import { budgetScreenshot, encodeGif } from './image'
import {
  getContentExpr, pageTextExpr, waitSelectorExpr, waitForFunctionExpr, getAttributesExpr,
  selectExpr, storageExpr, formInputExpr, clipboardReadExpr, clipboardWriteExpr, uploadDataTransferExpr,
} from './in-page-js'
import { resolvePoint, assertPointActionable, resolveRefObject, resolveSelectorObject } from './ref-resolve'
import { Input, parseKeyChord, DEFAULT_FIDELITY, type InputFidelity } from './input'
import { markCollectorExpr, buildMarkOverlayExpr, parseMarks } from './marks'
import { approval } from './approval-singleton'
import { GATE_BYPASS_AI_PAGE_TOOLS } from './gates'
import { classifyOutcome, outcomeSnapshotExpr, parsePageSig, formatOutcome, type PageSig, type Outcome } from './outcome'
import { CircuitBreaker, elementKey } from './circuit-breaker'
import { safeTitle, type BrowserTab } from './types'

type Debuggee = chrome.debugger.Debuggee
type SendFn = (t: Debuggee, m: string, p?: object) => Promise<any>
type Sleep = (ms: number) => Promise<void>

// browser_batch re-dispatches sub-calls through the gated dispatcher. We inject it via
// a setter (called from register.ts) rather than importing ./dispatch here, so there's
// no controller→dispatch static edge (which would make Vite emit a shared preload-helper
// chunk that leaks into the classic-script content.js). See content-build.test.ts.
type DispatchFn = (name: string, args: Record<string, unknown>, callId: string, opts?: { originTabId?: number; skipApproval?: boolean }) => Promise<{ output: string; success: boolean }>
let dispatchRef: DispatchFn | null = null
export function setBatchDispatcher(fn: DispatchFn): void { dispatchRef = fn }

// A cross-origin (OOPIF) child frame session, as tracked by the SW's flat-session
// auto-attach (background/index.ts frameSessionsByTab). listFrameSessions is injected so
// the controller can include those frames' elements in a snapshot without importing
// index.ts (which would create a cycle). Defaults to none → main frame only.
export interface FrameSessionInfo { sessionId: string; url: string }
export interface ControllerDeps {
  send?: SendFn; fidelity?: InputFidelity; sleep?: Sleep
  listFrameSessions?: (tabId: number) => FrameSessionInfo[]
}

export function makeController(deps: ControllerDeps = {}) {
  const cdp: Cdp = makeCdp(deps.send)
  const registry = new TabRegistry()
  const events = new EventBus()
  const security = new SecurityPolicy()
  const input = new Input(cdp, { fidelity: deps.fidelity ?? DEFAULT_FIDELITY, sleep: deps.sleep, registry })
  const breaker = new CircuitBreaker()   // item #5: element/page/global fail-fast for dead targets
  const settleMs = 0  // mirror default fidelity SettleMS=0; per-tab settle is a no-op
  let snapSeq = 0

  function target(tabId: number): Debuggee { return { tabId } }
  async function settle(_tabId: number): Promise<void> { if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs)) }

  // ── Outcome Contract (item #1) ────────────────────────────────────────────
  // Capture a compact page signature for the before/after interaction probe.
  // Best-effort: a restricted page or detached frame returns null (→ UNKNOWN,
  // which is suppressed from the annotation). Never throws — observation-only.
  async function captureSig(tgt: Debuggee, point?: { x: number; y: number }): Promise<PageSig | null> {
    try { return parsePageSig(await cdp.runtimeEvaluate(tgt, outcomeSnapshotExpr(point))) }
    catch { return null }
  }
  // Append the structured outcome to a tool's output text. UNKNOWN is dropped so we
  // don't spam noise on every interaction; SUCCESS/SILENT_CLICK/WRONG_ELEMENT annotate.
  function annotateOutcome(out: string, before: PageSig | null, after: PageSig | null, action: 'click' | 'type' | 'select'): string {
    const r = classifyOutcome(before, after, action)
    const o: Outcome = r.outcome
    if (o === 'UNKNOWN') return out
    return out + formatOutcome(r)
  }

  // ── Ralph interaction waterfall (item #2) ─────────────────────────────────
  // After the primary coordinate click yields a SILENT_CLICK outcome, degrade
  // through cheaper-to-noisier tiers, re-probing the outcome after each:
  //   raw CDP coordinate → JS element.click()+dispatchEvent → keyboard focus+Enter/Space.
  // Caps total tier attempts and a wall-clock budget so a permanently-dead element
  // can't spin forever (the Circuit Breaker, item #5, fail-fasts repeat offenders).
  // Escalation needs a resolvable element (ref/selector); a raw x/y point has nothing
  // to degrade to, so it is skipped. Returns the final outcome + an escalation note.
  const WATERFALL_BUDGET_MS = 4000
  interface ClickHandle { backendId?: number; selector?: string }
  async function clickWaterfall(
    tgt: Debuggee, point: { x: number; y: number },
    el: ClickHandle | null, before: PageSig | null, after: PageSig | null,
  ): Promise<{ after: PageSig | null; escalated: string[] }> {
    const escalated: string[] = []
    let cur = classifyOutcome(before, after, 'click')
    if (cur.outcome === 'SUCCESS') return { after, escalated }
    // No element handle (raw x/y click) or no probe baseline → cannot meaningfully
    // escalate or measure escalation. Keep the tier-1 result.
    if (!el || (el.backendId == null && !el.selector) || before == null) return { after, escalated }

    // Resolve a Runtime objectId for the JS-click tier (ref → backendId, else selector).
    const getObjectId = async (): Promise<string | null> => {
      try {
        if (el.backendId != null) return await resolveRefObject(cdp, tgt, el.backendId)
        if (el.selector) return await resolveSelectorObject(cdp, tgt, el.selector)
      } catch { /* gone */ }
      return null
    }

    const deadline = Date.now() + WATERFALL_BUDGET_MS
    const tiers: Array<{ name: string; run: () => Promise<void> }> = [
      // raw CDP press/release at the point (no moveTo fidelity; defeats hover-state interceptors).
      { name: 'cdp-coord', run: async () => {
        await cdp.sendCommand(tgt, 'Input', 'dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
        await cdp.sendCommand(tgt, 'Input', 'dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
      } },
      // JS element.click() + a synthetic bubbling MouseEvent (handles non-isTrusted listeners).
      { name: 'js-click', run: async () => {
        const objectId = await getObjectId()
        if (!objectId) return
        await cdp.callFunctionOnObject(tgt, objectId,
          `function(){ try{ this.click(); }catch(e){} this.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return 'ok'; }`)
      } },
      // Keyboard activation: focus the node, then Enter then Space (covers button/link/checkbox).
      { name: 'keyboard', run: async () => {
        if (el.backendId != null) { try { await cdp.sendCommand(tgt, 'DOM', 'focus', { backendNodeId: el.backendId }) } catch { /* not focusable */ } }
        else if (el.selector) { await cdp.runtimeEvaluate(tgt, `(()=>{const el=document.querySelector(${JSON.stringify(el.selector)});if(el&&el.focus)el.focus();return !!el;})()`) }
        await input.sendNamedKey(tgt, 'Enter', '\r')
        await input.sendNamedKey(tgt, ' ', ' ')
      } },
    ]

    let outSig = after
    for (const tier of tiers) {
      if (Date.now() > deadline) break
      try { await tier.run() } catch { continue }     // a failed tier just falls to the next
      escalated.push(tier.name)
      outSig = await captureSig(tgt, point)
      cur = classifyOutcome(before, outSig, 'click')
      if (cur.outcome === 'SUCCESS') break
    }
    return { after: outSig, escalated }
  }

  // Resolve the target tab; enforce the AI-page gate (hard refuse) unless allowAIPage.
  // allowAIPage is set for the tab-ESTABLISHING tools (browser_use_tab / browser_new_tab)
  // whose whole purpose is to grant control of (or open) a tab — gating them would
  // deadlock: the gate tells the model to "use browser_use_tab", but then blocks
  // browser_use_tab itself.
  async function ensureTab(args: { tabId?: number }, allowAIPage = false): Promise<BrowserTab> {
    let id = (typeof args.tabId === 'number' && args.tabId > 0) ? args.tabId : registry.default()
    if (id == null) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!active?.id) throw new Error('no controllable tab; open or specify a tabId')
      id = active.id
    }
    const t = await chrome.tabs.get(id)
    const tab: BrowserTab = { tabId: id, url: t.url || '', title: safeTitle(t.title || '') }
    if (!allowAIPage && isAIPage(tab.url) && !registry.isApproved(id)) {
      throw new Error('refusing to control AI conversation tab by default; use browser_use_tab and approve explicitly')
    }
    registry.upsertTab(tab)
    return tab
  }

  // Enable a CDP domain once per tab (dedupe via EventBus). Best-effort.
  async function ensureDomain(tabId: number, domain: string): Promise<void> {
    if (events.domainEnabled(tabId, domain)) return
    // Mark enabled ONLY after the command actually succeeds (audit #10). The old
    // code marked it unconditionally after the try/catch, so a transient first
    // failure (e.g. the tab still attaching) cached "enabled" and the domain was
    // never re-enabled until the tab closed. On failure we leave it unmarked so
    // the next call retries; a genuinely restricted page just retries cheaply.
    try {
      await cdp.sendCommand(target(tabId), domain, 'enable')
      events.markDomainEnabled(tabId, domain)
    } catch { /* transient or restricted page: leave unmarked so a later call retries */ }
  }

  const api = {
    registry, events, security,
    // exported for the dispatch gate to pre-resolve a tab (Phase 2). Some tools must
    // skip the AI-page gate during pre-resolution:
    //  - use_tab/new_tab ESTABLISH control (they ARE the approval path; gating deadlocks).
    //  - finalize_tabs CLOSES tabs by an explicit id list and ignores the resolved
    //    default tab entirely, so blocking on "the default tab is an AI page" is a false
    //    deadlock. It still gets its approval prompt via runGates.
    // (zoom/cookies/etc. genuinely act on the target tab, so they stay gated.)
    async resolveTabForGate(args: { tabId?: number }, toolName?: string): Promise<BrowserTab> {
      return ensureTab(args, !!toolName && GATE_BYPASS_AI_PAGE_TOOLS.has(toolName))
    },

    async snapshot(args: { tabId?: number; coordinates?: boolean; refId?: string; depth?: number }): Promise<string> {
      const tab = await ensureTab(args)
      await ensureDomain(tab.tabId, 'Accessibility')
      const raw = await cdp.sendCommand(target(tab.tabId), 'Accessibility', 'getFullAXTree')
      const id = `snap${++snapSeq}`
      // Include cross-origin (OOPIF) child frames so elements inside embedded payment
      // forms / docs are visible + clickable (mirrors Go controller.go collectFrameAXTrees).
      // A subtree filter (refId) only applies to the main tree, so skip frames then.
      const frames: { raw: any; sessionId: string; url: string }[] = []
      if (!args.refId) {
        for (const fs of deps.listFrameSessions?.(tab.tabId) ?? []) {
          try {
            const childTarget = { tabId: tab.tabId, sessionId: fs.sessionId } as Debuggee
            const fraw = await cdp.sendCommand(childTarget, 'Accessibility', 'getFullAXTree')
            frames.push({ raw: fraw, sessionId: fs.sessionId, url: fs.url })
          } catch { /* frame detached / not enabled — skip it */ }
        }
      }
      const r = compactSnapshotWithFrames(raw, frames, tab, id, { refId: args.refId, depth: args.depth })
      registry.storeSnapshot(tab.tabId, id, r.refs)
      return r.text || '(empty snapshot)'
    },

    async tabs(_args: Record<string, unknown>): Promise<string> {
      // Single browser: list this browser's tabs only (no cross-browser fanout).
      const list = await chrome.tabs.query({})
      return list.map(t => `#${t.id} ${safeTitle(t.title || '')} — ${t.url}`).join('\n') || '(no tabs)'
    },

    async screenshot(args: { tabId?: number; maxDim?: number; __originTabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
      const dataUrl = await budgetScreenshot(out.data, 'image/png', args.maxDim ?? 1000)
      return deliverMedia(dataUrl, 'screenshot', args.__originTabId)
    },

    async find(args: { tabId?: number; query: string; limit?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const els = await find(cdp, target(tab.tabId), { tabId: tab.tabId, query: args.query, limit: args.limit })
      if (!els.length) return '(no matches)'
      return els.map(e => {
        const loc = e.x != null ? ` @(${e.x},${e.y})${e.frame ? ` [${e.frame}]` : ''}` : ''
        return `[${e.score}] ${e.role} ${JSON.stringify(e.text)} → ${e.ref}${loc}`
      }).join('\n')
    },

    async getContent(args: { tabId?: number; format?: 'text' | 'html' | 'structured'; selector?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const s = (await cdp.runtimeEvaluate(target(tab.tabId), getContentExpr(args.format ?? 'text', args.selector))) ?? ''
      const str = String(s)
      return str.length > 100000 ? str.slice(0, 100000) + '\n…[truncated]' : str
    },

    async getPageText(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const s = String((await cdp.runtimeEvaluate(target(tab.tabId), pageTextExpr())) ?? '')
      return s.length > 100000 ? s.slice(0, 100000) + '\n…[truncated]' : s
    },

    async getAttributes(args: { tabId?: number; selector: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), getAttributesExpr(args.selector))
      if (r == null) return `selector ${args.selector} not found`
      return typeof r === 'string' ? r : JSON.stringify(r, null, 2)
    },

    async console(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      await ensureDomain(tab.tabId, 'Runtime')
      const msgs = events.readConsole(tab.tabId)
      return msgs.map(m => `[${m.level}] ${m.text}`).join('\n') || '(no console messages)'
    },

    async network(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      await ensureDomain(tab.tabId, 'Network')
      const reqs = events.readNetwork(tab.tabId)
      return reqs.map(r => `${r.method} ${r.url}${r.status ? ` ${r.status}` : ''}`).join('\n') || '(no requests)'
    },

    async wait(args: { tabId?: number; selector?: string; timeoutMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const deadline = Date.now() + (args.timeoutMs ?? 5000)
      if (!args.selector) { await new Promise(r => setTimeout(r, Math.min(args.timeoutMs ?? 500, 2000))); return 'ok' }
      while (Date.now() < deadline) {
        if (await cdp.runtimeEvaluate(target(tab.tabId), waitSelectorExpr(args.selector))) return 'ok'
        await new Promise(r => setTimeout(r, 100))
      }
      return `wait timed out for ${args.selector}`
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

    async pdf(args: { tabId?: number; __originTabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'printToPDF', {})
      return deliverMedia(`data:application/pdf;base64,${out.data}`, 'page', args.__originTabId)
    },

    async record(args: { tabId?: number; frames?: number; delayMs?: number; __originTabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const n = Math.min(Math.max(args.frames ?? 6, 1), 30)
      const delay = args.delayMs ?? 200
      const shots: string[] = []
      for (let i = 0; i < n; i++) {
        const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
        shots.push(out.data)
        if (i < n - 1) await new Promise(r => setTimeout(r, delay))
      }
      return deliverMedia(await encodeGif(shots, 'image/png', delay), 'recording', args.__originTabId)
    },

    // ── interactive (Phase 2) ────────────────────────────────────────────────
    // Sensitivity + approval gates run in dispatch.ts before these; each mutating
    // method ends with registry.markStale so a stale ref can't be clicked next.

    async click(args: { tabId?: number; ref?: string; selector?: string; mark?: number; x?: number; y?: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<string> {
      const tab = await ensureTab(args)
      // Circuit breaker (item #5): only when there is a resolvable element handle
      // (ref/selector/mark). A raw x/y click has nothing to address/escalate, so it
      // skips the breaker — the same bail condition the waterfall uses below.
      const cbQuery = clickQuery(args)
      const cbKey = cbQuery ? elementKey(tab.tabId, cbQuery) : null
      if (cbKey) {
        const d = breaker.allow(tab.tabId, cbKey)
        if (!d.allowed) {
          // Fail fast: skip the waterfall entirely and tell the AI why (unavailable/reload/paused).
          return `skipped click on ${cbQuery} in tabId=${tab.tabId} — ${d.reason}`
        }
      }
      let point: { x: number; y: number }, sessionId: string
      try {
        ({ point, sessionId } = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ref: args.ref, selector: args.selector, mark: args.mark, x: args.x, y: args.y }))
      } catch (e) {
        // A thrown resolution error (stale ref / missing selector) is a failure too.
        if (cbKey) breaker.recordFailure(tab.tabId, cbKey)
        throw e
      }
      const tgt: Debuggee = sessionId ? ({ tabId: tab.tabId, sessionId } as Debuggee) : target(tab.tabId)
      // Skip elementFromPoint for iframe targets (topmost at the point is the <iframe>).
      if (!sessionId) await assertPointActionable(cdp, tgt, point)
      const button = args.button ?? 'left'
      const preOrigin = originOf(tab.url)
      const before = await captureSig(tgt, point)               // outcome probe (best-effort)
      await input.dispatchClick(tgt, tab.tabId, point.x, point.y, button, args.clickCount ?? 1)
      let after = await captureSig(tgt, point)
      // Ralph interaction waterfall (item #2): only for a plain left single-click (a
      // right/double-click degraded via JS/keyboard would change semantics). Escalate
      // through cheaper→noisier tiers when tier-1 produced a SILENT_CLICK outcome.
      let escNote = ''
      if (button === 'left' && (args.clickCount ?? 1) === 1) {
        const reft = args.ref ? registry.resolveRef(tab.tabId, args.ref) : null
        const handle: { backendId?: number; selector?: string } | null =
          reft ? { backendId: reft.backendId } : (args.selector ? { selector: args.selector } : null)
        const w = await clickWaterfall(tgt, point, handle, before, after)
        after = w.after
        if (w.escalated.length) escNote = `\n[escalated: ${w.escalated.join(' → ')}]`
      }
      // Circuit breaker bookkeeping (item #5): SUCCESS closes the element circuit;
      // SILENT_CLICK/WRONG_ELEMENT trip it toward OPEN (3 strikes → fail fast next time).
      if (cbKey) {
        const o = classifyOutcome(before, after, 'click').outcome
        if (o === 'SUCCESS') breaker.recordSuccess(tab.tabId, cbKey)
        else if (o === 'SILENT_CLICK' || o === 'WRONG_ELEMENT') breaker.recordFailure(tab.tabId, cbKey)
      }
      registry.markStale(tab.tabId)
      await settle(tab.tabId)
      let note = ''
      try {
        const t = await chrome.tabs.get(tab.tabId)
        const postOrigin = originOf(t.url || '')
        if (preOrigin && postOrigin && postOrigin !== preOrigin) {
          note = `\nNote: this click navigated the controlled tab cross-origin: ${preOrigin} → ${postOrigin}.`
        }
      } catch { /* tab gone */ }
      const verb = button === 'right' ? 'right-clicked' : (args.clickCount === 2 ? 'double-clicked' : 'clicked')
      return annotateOutcome(`${verb} at ${Math.round(point.x)},${Math.round(point.y)} in tabId=${tab.tabId}${note}${escNote}`, before, after, 'click')
    },

    async type(args: { tabId?: number; ref?: string; selector?: string; x?: number; y?: number; text: string; clear?: boolean; submit?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      const { point, sessionId } = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ref: args.ref, selector: args.selector, x: args.x, y: args.y })
      const tgt: Debuggee = sessionId ? ({ tabId: tab.tabId, sessionId } as Debuggee) : target(tab.tabId)
      await input.dispatchClick(tgt, tab.tabId, point.x, point.y, 'left', 1)   // focus
      const before = await captureSig(tgt, point)               // probe AFTER focus, BEFORE typing
      if (args.clear) {
        const selectAll = isMac() ? ['Meta'] : ['Ctrl']
        await input.sendKeyChordMods(tgt, selectAll, 'a')
        await input.sendNamedKey(tgt, 'Backspace', '')
      }
      await input.dispatchTypedKeys(tgt, args.text)
      if (args.submit) await input.sendNamedKey(tgt, 'Enter', '\r')
      const after = await captureSig(tgt, point)
      registry.markStale(tab.tabId)
      return annotateOutcome(`typed ${[...args.text].length} chars into tabId=${tab.tabId}`, before, after, 'type')
    },

    async hover(args: { tabId?: number; ref?: string; selector?: string; x?: number; y?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const { point, sessionId } = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ref: args.ref, selector: args.selector, x: args.x, y: args.y })
      const tgt: Debuggee = sessionId ? ({ tabId: tab.tabId, sessionId } as Debuggee) : target(tab.tabId)
      await input.moveTo(tgt, tab.tabId, point.x, point.y, 'none', 0)
      return `hovered at ${Math.round(point.x)},${Math.round(point.y)}`
    },

    async scroll(args: { tabId?: number; ref?: string; selector?: string; deltaX?: number; deltaY?: number; x?: number; y?: number }): Promise<string> {
      const tab = await ensureTab(args)
      // selector → scrollIntoView via querySelector.
      if (args.selector) {
        const expr = `(()=>{const el=document.querySelector(${JSON.stringify(args.selector)});if(!el)return 'not found';el.scrollIntoView({block:'center'});return 'ok';})()`
        const r = await cdp.runtimeEvaluate(target(tab.tabId), expr)
        registry.markStale(tab.tabId)
        return r === 'ok' ? 'scrolled into view' : `selector ${args.selector} not found`
      }
      // ref → DOM.scrollIntoViewIfNeeded on its backend node (works for OOPIF too).
      if (args.ref) {
        const t = registry.resolveRef(tab.tabId, args.ref)
        if (!t) throw new Error(`ref ${args.ref} is stale or unknown; take a fresh browser_snapshot`)
        const tgt: Debuggee = t.sessionId ? ({ tabId: tab.tabId, sessionId: t.sessionId } as Debuggee) : target(tab.tabId)
        try {
          await cdp.sendCommand(tgt, 'DOM', 'scrollIntoViewIfNeeded', { backendNodeId: t.backendId })
          registry.markStale(tab.tabId)
          return 'scrolled ref into view'
        } catch (e) {
          // CDP scrollIntoViewIfNeeded failed — do NOT report success (audit #11:
          // the old code swallowed the error and returned 'scrolled ref into
          // view' anyway, so the agent believed an element it never scrolled to
          // was in view). Surface the real failure so the caller can retry with a
          // fresh snapshot or a wheel scroll.
          registry.markStale(tab.tabId)
          throw new Error(`could not scroll ref ${args.ref} into view: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // else mouse-wheel at point (or viewport center).
      const dx = args.deltaX ?? 0
      const dy = args.deltaY ?? DEFAULT_FIDELITY.wheelTickPx
      const px = args.x ?? 200, py = args.y ?? 200
      await input.dispatchMouseWheel(target(tab.tabId), px, py, dx, dy)
      registry.markStale(tab.tabId)
      return `scrolled (${dx},${dy})`
    },

    async select(args: { tabId?: number; selector: string; by?: 'value' | 'label' | 'index'; value: string }): Promise<string> {
      const tab = await ensureTab(args)
      const before = await captureSig(target(tab.tabId))         // outcome probe (best-effort)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), selectExpr(args.selector, args.by ?? 'value', args.value))
      const after = await captureSig(target(tab.tabId))
      registry.markStale(tab.tabId)
      return annotateOutcome(String(r), before, after, 'select')
    },

    async pressKey(args: { tabId?: number; key: string }): Promise<string> {
      const tab = await ensureTab(args)
      const { mods, key } = parseKeyChord(args.key)
      if (mods.length) await input.sendKeyChordMods(target(tab.tabId), mods, key)
      else await input.sendNamedKey(target(tab.tabId), key, namedKeyText(key))
      registry.markStale(tab.tabId)
      return `pressed ${args.key}`
    },

    async drag(args: { tabId?: number; fromRef?: string; fromSelector?: string; fromX?: number; fromY?: number; toRef?: string; toSelector?: string; toX?: number; toY?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const a = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ref: args.fromRef, selector: args.fromSelector, x: args.fromX, y: args.fromY })
      const b = await resolvePoint(cdp, registry, target(tab.tabId), { tabId: tab.tabId, ref: args.toRef, selector: args.toSelector, x: args.toX, y: args.toY })
      // Route each endpoint's mouse events to the CDP session that owns it.
      // resolvePoint returns frame-local coordinates plus the backend node's
      // sessionId (set for a cross-process iframe). Dispatching to the main page
      // target with frame-local coords (the old code, audit #12) lands the drag
      // at the wrong place — or on the main page — for an OOPIF element. This
      // mirrors click()'s session-aware dispatch. The press goes to the source
      // session, the release to the destination session (same session for the
      // common in-frame drag; best-effort across frames).
      const fromTgt: Debuggee = a.sessionId ? ({ tabId: tab.tabId, sessionId: a.sessionId } as Debuggee) : target(tab.tabId)
      const toTgt: Debuggee = b.sessionId ? ({ tabId: tab.tabId, sessionId: b.sessionId } as Debuggee) : target(tab.tabId)
      await input.moveTo(fromTgt, tab.tabId, a.point.x, a.point.y, 'none', 0)
      await cdp.sendCommand(fromTgt, 'Input', 'dispatchMouseEvent', { type: 'mousePressed', x: a.point.x, y: a.point.y, button: 'left', buttons: 1, clickCount: 1 })
      await input.moveTo(toTgt, tab.tabId, b.point.x, b.point.y, 'left', 1)
      await cdp.sendCommand(toTgt, 'Input', 'dispatchMouseEvent', { type: 'mouseReleased', x: b.point.x, y: b.point.y, button: 'left', buttons: 0, clickCount: 1 })
      registry.markStale(tab.tabId)
      return `dragged ${Math.round(a.point.x)},${Math.round(a.point.y)} → ${Math.round(b.point.x)},${Math.round(b.point.y)}`
    },

    async focus(args: { tabId?: number; ref?: string; selector?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const sel = args.selector
      const expr = sel
        ? `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'not found';el.focus();return 'ok';})()`
        : `(()=>'need a selector')()`
      const r = await cdp.runtimeEvaluate(target(tab.tabId), expr)
      return String(r)
    },

    async newTab(args: { url?: string }): Promise<string> {
      const url = args.url ?? 'about:blank'
      const navErr = checkNavigate(url)
      if (navErr) throw new Error(navErr)
      const t = await chrome.tabs.create({ url, active: false })
      if (t.id == null) throw new Error('failed to create tab')
      const isWorker = /[?&]piercode_agent=/.test(url)
      registry.markCreated(t.id)
      if (!isWorker) {
        registry.setDefault({ tabId: t.id, url, title: safeTitle(t.title || '') })
        if (isAIPage(url)) registry.markApproved(t.id)   // AI page the AI opened itself
      }
      return `opened tabId=${t.id} url=${url}`
    },

    async useTab(args: { tabId: number; reason?: string }): Promise<string> {
      const t = await chrome.tabs.get(args.tabId)
      const tab: BrowserTab = { tabId: args.tabId, url: t.url || '', title: safeTitle(t.title || '') }
      registry.markApproved(args.tabId)      // approval already granted via gate (browser_use_tab)
      registry.markClaimed(args.tabId)
      registry.setDefault(tab)
      return `controlling tabId=${args.tabId} (${tab.url})`
    },

    async navigate(args: { tabId?: number; url: string; __originTabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const navErr = checkNavigate(args.url)
      if (navErr) throw new Error(navErr)
      if (!sameRegistrableHost(tab.url, args.url)) {
        let host = ''; try { host = new URL(args.url).hostname } catch { /* */ }
        await approval.ask({ host, actionClass: 'interact', action: 'browser_navigate 跨域导航', callId: '', originTabId: args.__originTabId })
      }
      await cdp.sendCommand(target(tab.tabId), 'Page', 'enable')
      await cdp.sendCommand(target(tab.tabId), 'Page', 'navigate', { url: args.url })
      registry.markStale(tab.tabId)
      registry.upsertTab({ tabId: tab.tabId, url: args.url, title: tab.title })
      return `navigated tabId=${tab.tabId} to ${args.url}`
    },

    async goBack(args: { tabId?: number; __originTabId?: number }): Promise<string> { return navHistory(args, -1) },
    async goForward(args: { tabId?: number; __originTabId?: number }): Promise<string> { return navHistory(args, +1) },

    async reload(args: { tabId?: number; hard?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      await cdp.sendCommand(target(tab.tabId), 'Page', 'reload', { ignoreCache: !!args.hard })
      registry.markStale(tab.tabId)
      return `reloaded tabId=${tab.tabId}`
    },

    async mark(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const raw = await cdp.runtimeEvaluate(target(tab.tabId), markCollectorExpr())
      const marks = parseMarks(raw)
      registry.setMarks(tab.tabId, marks)
      await cdp.runtimeEvaluate(target(tab.tabId), buildMarkOverlayExpr(marks))
      return marks.map(m => `[${m.index}] ${m.role} ${JSON.stringify(m.text)} @(${m.cx},${m.cy})`).join('\n') || '(no interactive elements)'
    },

    async handleDialog(args: { tabId?: number; accept?: boolean; promptText?: string }): Promise<string> {
      const tab = await ensureTab(args)
      await cdp.sendCommand(target(tab.tabId), 'Page', 'handleJavaScriptDialog', {
        accept: args.accept !== false, promptText: args.promptText,
      })
      return `dialog ${args.accept !== false ? 'accepted' : 'dismissed'}`
    },

    async waitForNavigation(args: { tabId?: number; timeoutMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      try { await events.waitForNav(tab.tabId, args.timeoutMs ?? 10000); registry.markStale(tab.tabId); return 'navigation complete' }
      catch (e) { return e instanceof Error ? e.message : String(e) }
    },

    async resize(args: { width: number; height: number; tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const t = await chrome.tabs.get(tab.tabId)
      if (typeof t.windowId === 'number') await chrome.windows.update(t.windowId, { width: args.width, height: args.height })
      return `resized window to ${args.width}x${args.height}`
    },

    async viewport(args: { tabId?: number; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; clear?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      if (args.clear) { await cdp.sendCommand(target(tab.tabId), 'Emulation', 'clearDeviceMetricsOverride'); return 'viewport override cleared' }
      await cdp.sendCommand(target(tab.tabId), 'Emulation', 'setDeviceMetricsOverride', {
        width: args.width ?? 1280, height: args.height ?? 800,
        deviceScaleFactor: args.deviceScaleFactor ?? 1, mobile: !!args.mobile,
      })
      return `viewport set ${args.width ?? 1280}x${args.height ?? 800}`
    },

    async emulate(args: { tabId?: number; userAgent?: string; locale?: string; timezone?: string; offline?: boolean }): Promise<string> {
      const tab = await ensureTab(args)
      const applied: string[] = []
      if (args.userAgent) { await cdp.sendCommand(target(tab.tabId), 'Emulation', 'setUserAgentOverride', { userAgent: args.userAgent }); applied.push('userAgent') }
      if (args.timezone) { await cdp.sendCommand(target(tab.tabId), 'Emulation', 'setTimezoneOverride', { timezoneId: args.timezone }); applied.push('timezone') }
      if (args.locale) { await cdp.sendCommand(target(tab.tabId), 'Emulation', 'setLocaleOverride', { locale: args.locale }); applied.push('locale') }
      if (args.offline != null) { await cdp.sendCommand(target(tab.tabId), 'Network', 'emulateNetworkConditions', { offline: args.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); applied.push(args.offline ? 'offline' : 'online') }
      return applied.length ? `emulating: ${applied.join(', ')}` : 'no emulation options provided'
    },

    // ── write / high-risk (Phase 3) ──────────────────────────────────────────
    // High-risk tools (evaluate/cookies/clipboard/upload) are approval-gated by
    // their action class in dispatch.ts before reaching here.

    async evaluate(args: { tabId?: number; expression: string }): Promise<string> {
      const tab = await ensureTab(args)
      const wrapped = `(function(){ var __r = (${args.expression}); return JSON.stringify(__r === undefined ? null : __r); })()`
      const r = await cdp.runtimeEvaluate(target(tab.tabId), wrapped)
      registry.markStale(tab.tabId)
      return typeof r === 'string' ? r : JSON.stringify(r)
    },

    async storage(args: { tabId?: number; area?: 'local' | 'session'; op: string; key?: string; value?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), storageExpr(args.area ?? 'local', args.op, args.key, args.value))
      return typeof r === 'string' ? r : JSON.stringify(r)
    },

    async formInput(args: { tabId?: number; selector: string; kind: 'text' | 'checkbox' | 'radio' | 'contenteditable'; value: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), formInputExpr(args.selector, args.kind, args.value))
      registry.markStale(tab.tabId)
      return String(r)
    },

    async clipboard(args: { tabId?: number; op: 'read' | 'write'; text?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const expr = args.op === 'write' ? clipboardWriteExpr(args.text ?? '') : clipboardReadExpr()
      return String(await cdp.runtimeEvaluate(target(tab.tabId), expr))
    },

    async cookies(args: { tabId?: number; url?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const list = await chrome.cookies.getAll({ url: args.url ?? tab.url })
      return list.map(c => `${c.name}=${c.value}`).join('\n') || '(no cookies)'
    },

    async setCookie(args: { url: string; name: string; value: string; domain?: string; path?: string }): Promise<string> {
      await chrome.cookies.set({ url: args.url, name: args.name, value: args.value, domain: args.domain, path: args.path })
      return `set cookie ${args.name}`
    },

    async downloads(_args: Record<string, unknown>): Promise<string> {
      const items = await chrome.downloads.search({ limit: 20, orderBy: ['-startTime'] })
      return items.map(d => `${d.filename || d.url} (${d.state})`).join('\n') || '(no downloads)'
    },

    async upload(args: { tabId?: number; selector: string; fileName: string; base64?: string; mime?: string }): Promise<string> {
      const tab = await ensureTab(args)
      // SW has no filesystem: caller must supply base64 bytes (no local path).
      if (!args.base64) return 'upload requires base64 file bytes (local paths are unsupported in the extension service worker)'
      const r = await cdp.runtimeEvaluate(target(tab.tabId),
        uploadDataTransferExpr(args.selector, args.fileName, args.base64, args.mime ?? 'application/octet-stream'))
      registry.markStale(tab.tabId)
      return String(r)
    },

    async zoom(args: { tabId?: number; __originTabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      // Region screenshot — capture full and budget down (clip-rect refinement TODO).
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
      const dataUrl = await budgetScreenshot(out.data, 'image/png', 1200)
      return deliverMedia(dataUrl, 'zoom', args.__originTabId)
    },

    async finalizeTabs(args: { tabId?: number; close?: number[] }): Promise<string> {
      const ids = args.close ?? []
      let closed = 0
      for (const id of ids) {
        try { await chrome.tabs.remove(id); closed++ } catch { /* already gone */ }
        registry.clearDefault(id)
      }
      return `finalized ${closed}/${ids.length} tabs`
    },

    async batch(args: { tabId?: number; actions: Array<{ name: string; input?: Record<string, unknown> }>; __originTabId?: number }): Promise<string> {
      // Re-dispatch each sub-call through the full gated path. Uses the module-level
      // `dispatchRef` (set by register.ts) instead of importing ./dispatch here — a
      // controller→dispatch static import would force Vite to emit a shared
      // vite-preload-helper chunk that leaks into content.js (content-build.test.ts).
      if (!dispatchRef) return 'browser_batch unavailable (dispatcher not wired)'
      const out: string[] = []
      const opts = { originTabId: args.__originTabId }   // propagate the AI-page tab to sub-calls
      for (const a of args.actions ?? []) {
        const r = await dispatchRef(a.name, { tabId: args.tabId, ...(a.input ?? {}) }, '', opts)
        out.push(`### ${a.name}\n${r.output}`)
      }
      return out.join('\n\n') || '(empty batch)'
    },
  }

  // Cross-origin-gated history navigation (port controller_ext.go navigateHistory).
  async function navHistory(args: { tabId?: number; __originTabId?: number }, dir: -1 | 1): Promise<string> {
    const tab = await ensureTab(args)
    const hist = await cdp.sendCommand(target(tab.tabId), 'Page', 'getNavigationHistory')
    const entries = hist.entries as Array<{ id: number; url: string }>
    const idx = hist.currentIndex as number
    const targetIdx = idx + dir
    if (targetIdx < 0 || targetIdx >= entries.length) return dir < 0 ? 'no back history' : 'no forward history'
    const dest = entries[targetIdx]
    if (!sameRegistrableHost(tab.url, dest.url)) {
      let host = ''; try { host = new URL(dest.url).hostname } catch { /* */ }
      await approval.ask({ host, actionClass: 'interact', action: '历史导航到新域名', callId: '', originTabId: args.__originTabId })
    }
    await cdp.sendCommand(target(tab.tabId), 'Page', 'navigateToHistoryEntry', { entryId: dest.id })
    registry.markStale(tab.tabId)
    return `${dir < 0 ? 'back' : 'forward'} to ${dest.url}`
  }

  return api
}

function isMac(): boolean {
  try { return /mac/i.test((navigator as any).platform || (navigator as any).userAgentData?.platform || '') } catch { return false }
}

// Element-locating query string for the circuit breaker key (item #5). A raw x/y
// click addresses no element, so it returns '' → the breaker is skipped (the same
// bail the waterfall uses). ref/selector/mark each yield a stable, distinct token.
function clickQuery(args: { ref?: string; selector?: string; mark?: number }): string {
  if (args.ref) return `ref:${args.ref}`
  if (args.selector) return `sel:${args.selector}`
  if (typeof args.mark === 'number') return `mark:${args.mark}`
  return ''
}

// Deliver a captured media dataURL (screenshot/zoom/record/pdf): inject it into the
// AI page's chat input as an attachment when we know the origin tab, otherwise return
// the dataURL inline. Attachment delivery avoids blasting a multi-KB base64 string into
// the model's text context (token cost); the SW holds the bytes from CDP and sends them
// to the content script (BROWSER_ATTACHMENT_UPLOAD), which runs the file-input/paste/drop
// injection — no Go server / no /attachments fetch (unlike the old WS attachment path).
// Monotonic media counter so successive screenshots/pdfs/recordings get DISTINCT
// attachment filenames. A fixed `screenshot.jpg` made every capture share one name —
// the AI page (and the user) couldn't tell shots apart, and some pages dedupe/overwrite
// a re-added same-named file. Seeded once; bumped per delivery.
let mediaSeq = 0

async function deliverMedia(dataUrl: string, label: string, originTabId?: number): Promise<string> {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl
  const b64 = dataUrl.slice(comma + 1)
  const mimeMatch = /^data:([^;,]+)/.exec(dataUrl)
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream'
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg'
    : mime === 'image/gif' ? 'gif' : mime === 'application/pdf' ? 'pdf' : 'bin'
  const name = `${label}-${++mediaSeq}.${ext}`
  if (typeof originTabId === 'number') {
    const injected = await injectAttachment(originTabId, b64, name, mime)
    if (injected) return `uploaded ${label} (${name}) to the current AI chat page as an attachment`
  }
  return dataUrl
}

// Inject a base64 image into the AI page's chat input as an attachment, by asking
// the content script on `tabId` to run its existing file-input/paste/drop pipeline.
// Returns true if the page accepted it. Mirrors the Go WS browser_attachment_upload
// flow, but the bytes are already in hand (no server fetch).
async function injectAttachment(tabId: number, base64: string, name: string, mime: string): Promise<boolean> {
  try {
    const r: any = await chrome.tabs.sendMessage(tabId, {
      type: 'BROWSER_ATTACHMENT_UPLOAD', base64, name, mime,
    })
    return !!r?.ok
  } catch {
    return false   // no content script / page rejected → caller falls back to dataURL
  }
}
function namedKeyText(key: string): string {
  if (key === 'Enter') return '\r'
  if (key === 'Tab') return '\t'
  return key.length === 1 ? key : ''
}

export type Controller = ReturnType<typeof makeController>

// Lazy singleton. background/index.ts calls initController(send) at startup with an
// attach-ensuring transport; dispatch.ts reads getController(). Tests use makeController.
let _instance: Controller | null = null
export function initController(deps: ControllerDeps = {}): Controller {
  _instance = makeController(deps)
  return _instance
}
export function getController(): Controller {
  if (!_instance) _instance = makeController()
  return _instance
}
