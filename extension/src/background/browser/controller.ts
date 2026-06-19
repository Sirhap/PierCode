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
import { SecurityPolicy, isAIPage } from './security'
import { compactSnapshotWithFrames } from './snapshot'
import { find } from './find'
import { budgetScreenshot, encodeGif } from './image'
import { getContentExpr, pageTextExpr, waitSelectorExpr, waitForFunctionExpr, getAttributesExpr } from './in-page-js'
import { safeTitle, type BrowserTab } from './types'

type Debuggee = chrome.debugger.Debuggee
type SendFn = (t: Debuggee, m: string, p?: object) => Promise<any>

export interface ControllerDeps { send?: SendFn }

export function makeController(deps: ControllerDeps = {}) {
  const cdp: Cdp = makeCdp(deps.send)
  const registry = new TabRegistry()
  const events = new EventBus()
  const security = new SecurityPolicy()
  let snapSeq = 0

  function target(tabId: number): Debuggee { return { tabId } }

  // Resolve the target tab; enforce the AI-page gate (hard refuse).
  async function ensureTab(args: { tabId?: number }): Promise<BrowserTab> {
    let id = (typeof args.tabId === 'number' && args.tabId > 0) ? args.tabId : registry.default()
    if (id == null) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!active?.id) throw new Error('no controllable tab; open or specify a tabId')
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

  // Enable a CDP domain once per tab (dedupe via EventBus). Best-effort.
  async function ensureDomain(tabId: number, domain: string): Promise<void> {
    if (events.domainEnabled(tabId, domain)) return
    try { await cdp.sendCommand(target(tabId), domain, 'enable') } catch { /* restricted page */ }
    events.markDomainEnabled(tabId, domain)
  }

  const api = {
    registry, events, security,
    // exported for the dispatch gate to pre-resolve a tab (Phase 2)
    async resolveTabForGate(args: { tabId?: number }): Promise<BrowserTab> { return ensureTab(args) },

    async snapshot(args: { tabId?: number; coordinates?: boolean; refId?: string; depth?: number }): Promise<string> {
      const tab = await ensureTab(args)
      await ensureDomain(tab.tabId, 'Accessibility')
      const raw = await cdp.sendCommand(target(tab.tabId), 'Accessibility', 'getFullAXTree')
      const id = `snap${++snapSeq}`
      const r = compactSnapshotWithFrames(raw, [], tab, id, { refId: args.refId, depth: args.depth })
      registry.storeSnapshot(tab.tabId, id, r.refs)
      return r.text || '(empty snapshot)'
    },

    async tabs(_args: Record<string, unknown>): Promise<string> {
      // Single browser: list this browser's tabs only (no cross-browser fanout).
      const list = await chrome.tabs.query({})
      return list.map(t => `#${t.id} ${safeTitle(t.title || '')} — ${t.url}`).join('\n') || '(no tabs)'
    },

    async screenshot(args: { tabId?: number; maxDim?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
      return budgetScreenshot(out.data, 'image/png', args.maxDim ?? 1000)
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

    async pdf(args: { tabId?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'printToPDF', {})
      return `data:application/pdf;base64,${out.data}`
    },

    async record(args: { tabId?: number; frames?: number; delayMs?: number }): Promise<string> {
      const tab = await ensureTab(args)
      const n = Math.min(Math.max(args.frames ?? 6, 1), 30)
      const delay = args.delayMs ?? 200
      const shots: string[] = []
      for (let i = 0; i < n; i++) {
        const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
        shots.push(out.data)
        if (i < n - 1) await new Promise(r => setTimeout(r, delay))
      }
      return encodeGif(shots, 'image/png', delay)
    },
  }
  return api
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
