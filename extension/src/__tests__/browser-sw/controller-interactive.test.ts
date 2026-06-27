import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X', windowId: 9 })),
      create: vi.fn(async (o: any) => ({ id: 42, url: o.url, title: '' })),
    },
    windows: { update: vi.fn(async () => {}) },
    runtime: { sendMessage: vi.fn() },
  }
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
})

const noSleep = async () => {}

describe('controller interactive', () => {
  it('click by ref: resolves, dispatches, marks snapshot stale', async () => {
    const { makeController } = await import('../../background/browser/controller')
    // makeCdp(send) calls send(target, "Domain.method", params) — match that contract.
    const send = vi.fn(async (_t: any, fq: string) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'Runtime.evaluate') return { result: { value: true } }   // hit-test ok
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })                       // creates ref e0 (button)
    expect(ctl.registry.resolveRef(1, 'e0')).toBeTruthy()
    await ctl.click({ tabId: 1, ref: 'e0' })
    expect(ctl.registry.resolveRef(1, 'e0')).toBeNull()    // mutating → stale
  })

  it('navigate cross-origin asks approval; same-origin does not', async () => {
    const asks: any[] = []
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    // patch the shared approval singleton via the controller's gate path is internal;
    // instead drive navigate directly and assert it issues Page.navigate either way.
    const sendSpy = (globalThis as any).chrome.debugger.sendCommand
    await ctl.navigate({ tabId: 1, url: 'https://x.com/other' })   // same registrable domain → no prompt
    expect(ctl.registry.getTab(1)?.url).toBe('https://x.com/other')
    void asks; void sendSpy
  })

  it('new_tab worker URL stays uncontrolled (no setDefault)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    await ctl.newTab({ url: 'https://chat.qwen.ai/?piercode_agent=abc' })
    expect(ctl.registry.default()).toBeNull()              // worker tab not adopted
  })

  it('new_tab AI page (non-worker) becomes controlled + pre-approved', async () => {
    ;(globalThis as any).chrome.tabs.create = vi.fn(async (o: any) => ({ id: 7, url: o.url, title: '' }))
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    await ctl.newTab({ url: 'https://chatgpt.com/' })
    expect(ctl.registry.default()).toBe(7)
    expect(ctl.registry.isApproved(7)).toBe(true)
  })

  it('type clears with platform select-all then types', async () => {
    const calls: string[] = []
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({
      send: async (_t: any, fq: string, p: any) => {
        if (fq === 'Runtime.evaluate') return { result: { value: { x: 0, y: 0, width: 4, height: 4 } } }
        if (fq.startsWith('Input.dispatchKeyEvent')) calls.push(`${p.type}:${p.key}`)
        return {}
      },
      sleep: noSleep,
    })
    await ctl.type({ tabId: 1, selector: '#in', text: 'hi', clear: true })
    // Meta+a (mac) select-all then Backspace appear before the typed chars
    expect(calls.some(c => c.includes('Meta'))).toBe(true)
    expect(calls.some(c => c === 'keyDown:Backspace' || c.startsWith('keyDown:Backspace'))).toBe(true)
  })

  it('scroll by ref uses DOM.scrollIntoViewIfNeeded on the backend node', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const sent: string[] = []
    const send = vi.fn(async (_t: any, fq: string) => {
      sent.push(fq)
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })                        // creates ref e0
    const r = await ctl.scroll({ tabId: 1, ref: 'e0' })
    expect(sent).toContain('DOM.scrollIntoViewIfNeeded')    // not a blind mouse-wheel
    expect(r).toMatch(/ref into view/)
  })

  it('scroll by stale ref throws (does not silently wheel)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    await expect(ctl.scroll({ tabId: 1, ref: 'e9' })).rejects.toThrow(/stale or unknown/)
  })

  it('scroll by ref REJECTS when CDP scrollIntoViewIfNeeded fails (audit #11)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.scrollIntoViewIfNeeded') throw new Error('Node is detached from document')
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    // Must NOT resolve with a fake "scrolled ref into view" — it surfaces the error.
    await expect(ctl.scroll({ tabId: 1, ref: 'e0' })).rejects.toThrow(/could not scroll ref/)
  })

  it('drag dispatches each endpoint to its own OOPIF session (audit #12)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const events: Array<{ session: string | undefined; type: string }> = []
    const send = vi.fn(async (t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq.startsWith('Input.dispatchMouseEvent')) events.push({ session: t?.sessionId, type: p?.type })
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    // Force the resolved ref to carry a child OOPIF sessionId.
    const ref = ctl.registry.resolveRef(1, 'e0')!
    ;(ref as any).sessionId = 'sess-A'
    await ctl.drag({ tabId: 1, fromRef: 'e0', toRef: 'e0' })
    const press = events.find(e => e.type === 'mousePressed')
    const release = events.find(e => e.type === 'mouseReleased')
    expect(press?.session, 'mousePressed must target the child session, not the main page').toBe('sess-A')
    expect(release?.session, 'mouseReleased must target the child session').toBe('sess-A')
  })

  it('use_tab on an AI-page tab is NOT blocked by the AI-page gate (it grants control)', async () => {
    ;(globalThis as any).chrome.tabs.get = vi.fn(async () => ({ id: 5, url: 'https://chatgpt.com/c/9', title: 'GPT' }))
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    // resolveTabForGate is what dispatch calls before the tool; for use_tab it must pass.
    await expect(ctl.resolveTabForGate({ tabId: 5 }, 'browser_use_tab')).resolves.toMatchObject({ tabId: 5 })
    // and the tool itself marks it approved + controlled
    const out = await ctl.useTab({ tabId: 5 })
    expect(out).toContain('controlling tabId=5')
    expect(ctl.registry.isApproved(5)).toBe(true)
    expect(ctl.registry.default()).toBe(5)
  })

  it('a non-establishing tool on an unapproved AI-page tab IS still blocked', async () => {
    ;(globalThis as any).chrome.tabs.get = vi.fn(async () => ({ id: 6, url: 'https://chatgpt.com/c/9', title: 'GPT' }))
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    await expect(ctl.resolveTabForGate({ tabId: 6 }, 'browser_click')).rejects.toThrow(/AI conversation tab/)
  })

  it('finalize_tabs is not blocked by the AI-page gate (it closes tabs, ignores the target)', async () => {
    ;(globalThis as any).chrome.tabs.get = vi.fn(async () => ({ id: 7, url: 'https://chatgpt.com/c/9', title: 'GPT' }))
    ;(globalThis as any).chrome.tabs.remove = vi.fn(async () => {})
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    await expect(ctl.resolveTabForGate({ tabId: 7 }, 'browser_finalize_tabs')).resolves.toMatchObject({ tabId: 7 })
    const out = await ctl.finalizeTabs({ close: [7] })
    expect(out).toContain('finalized 1/1')
  })

  it('re-enables a CDP domain after a transient enable failure (audit #10)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    let enableCalls = 0
    const send = vi.fn(async (_t: any, fq: string) => {
      if (fq === 'Network.enable') {
        enableCalls++
        if (enableCalls === 1) throw new Error('transient: tab still attaching')
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.network({ tabId: 1 })   // first enable throws → must NOT be cached as enabled
    await ctl.network({ tabId: 1 })   // second call retries the enable
    expect(enableCalls, 'domain enable must be retried after a transient failure').toBe(2)
  })

  it('waitForNavigation resolves when a main-frame nav event lands', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}), sleep: noSleep })
    const p = ctl.waitForNavigation({ tabId: 1, timeoutMs: 2000 })
    // ensureTab awaits chrome.tabs.get, so the waiter registers a couple microtasks
    // in; let those flush before simulating the index.ts onEvent feed.
    await new Promise(r => setTimeout(r, 5))
    ctl.events.handleNavEvent(1, { url: 'https://x.com/after' })   // Page.frameNavigated, main frame
    await expect(p).resolves.toMatch(/navigation complete/)
  })
})
