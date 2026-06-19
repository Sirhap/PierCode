import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X' })),
    },
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
    // a follow-up click can resolve a ref the snapshot stored
    const refs = ctl.registry
    const submit = Object.values((refs as any))   // sanity: registry exists
    expect(submit).toBeDefined()
    // resolve by the actual ref name stored (e0/e1/...)
    expect(out).toMatch(/\[e\d+\] button "Submit"/)
  })

  it('snapshot refs are resolvable until a mutating markStale', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) =>
      method === 'Accessibility.getFullAXTree' ? AX_TREE : {})
    const ctl = makeController({ send })
    await ctl.snapshot({ tabId: 1 })
    // find any stored ref and confirm it resolves, then stale-invalidate
    // (registry is private API but exposed on the controller for the gate/tests)
    const anyRef = 'e0'
    expect(ctl.registry.resolveRef(1, anyRef)).toBeTruthy()
    ctl.registry.markStale(1)
    expect(ctl.registry.resolveRef(1, anyRef)).toBeNull()
  })

  it('snapshot includes OOPIF child-frame elements with continued refs + sessionId', async () => {
    const { makeController } = await import('../../background/browser/controller')
    // main frame: RootWebArea + button "Submit"; child frame: a textbox "Card number".
    const mainTree = {
      nodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Pay' }, childIds: ['2'], backendDOMNodeId: 1 },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Submit' }, childIds: [], backendDOMNodeId: 2 },
      ],
    }
    const frameTree = {
      nodes: [
        { nodeId: 'f1', role: { value: 'textbox' }, name: { value: 'Card number' }, childIds: [], backendDOMNodeId: 50 },
      ],
    }
    const send = vi.fn(async (t: any, method: string) => {
      if (method === 'Accessibility.getFullAXTree') return t.sessionId === 'sess-A' ? frameTree : mainTree
      return {}
    })
    const ctl = makeController({ send, listFrameSessions: () => [{ sessionId: 'sess-A', url: 'https://pay.stripe.com/f' }] })
    const out = await ctl.snapshot({ tabId: 1 })
    expect(out).toContain('button "Submit"')
    expect(out).toContain('iframe (cross-origin)')
    expect(out).toContain('textbox "Card number"')
    // the child-frame ref must resolve AND carry the child session for later clicks.
    // RootWebArea isn't an actionable role (no ref); button=e0, frame textbox=e1.
    const cardRef = ctl.registry.resolveRef(1, 'e1')
    expect(cardRef?.name).toBe('Card number')
    expect(cardRef?.sessionId).toBe('sess-A')
  })

  it('tabs: lists this browser tabs (no fanout)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: vi.fn(async () => ({})) })
    const out = await ctl.tabs({})
    expect(out).toContain('x.com')
  })

  it('getPageText: returns extracted text', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) =>
      method === 'Runtime.evaluate' ? { result: { value: 'hello world' } } : {})
    const ctl = makeController({ send })
    expect(await ctl.getPageText({ tabId: 1 })).toBe('hello world')
  })

  it('screenshot injects as attachment when origin tab accepts', async () => {
    const sendMessage = vi.fn((..._a: any[]) => Promise.resolve({ ok: true }))
    ;(globalThis as any).chrome.tabs.sendMessage = sendMessage
    // OffscreenCanvas/createImageBitmap aren't in jsdom; stub budgetScreenshot's path
    // by making captureScreenshot tiny + under budget so it returns the PNG dataURL
    // without re-encoding (budgetTargetDims keeps it, no canvas needed).
    ;(globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 10, height: 10, close() {} }))
    ;(globalThis as any).fetch = vi.fn(async () => ({ blob: async () => new Blob() }))
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string) =>
      fq === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' } : {})
    const ctl = makeController({ send })
    const out = await ctl.screenshot({ tabId: 1, __originTabId: 99 } as any)
    expect(sendMessage).toHaveBeenCalled()
    expect(sendMessage.mock.calls[0][0]).toBe(99)              // targeted to origin tab
    expect(sendMessage.mock.calls[0][1].type).toBe('BROWSER_ATTACHMENT_UPLOAD')
    expect(out).toMatch(/uploaded/i)
    // Successive captures must get DISTINCT filenames (a fixed screenshot.jpg made the
    // page dedupe/overwrite and the AI couldn't tell shots apart).
    await ctl.screenshot({ tabId: 1, __originTabId: 99 } as any)
    const name1 = sendMessage.mock.calls[0][1].name
    const name2 = sendMessage.mock.calls[1][1].name
    expect(name1).not.toBe(name2)
    expect(name1).toMatch(/^screenshot-\d+\.(png|jpg)$/)
  })

  it('screenshot returns dataURL inline when no origin tab', async () => {
    ;(globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 10, height: 10, close() {} }))
    ;(globalThis as any).fetch = vi.fn(async () => ({ blob: async () => new Blob() }))
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string) =>
      fq === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgo=' } : {})
    const ctl = makeController({ send })
    const out = await ctl.screenshot({ tabId: 1 })
    expect(out).toMatch(/^data:image\//)
  })

  it('AI-page tab without approval is refused', async () => {
    ;(globalThis as any).chrome.tabs.get = vi.fn(async () => ({ id: 1, url: 'https://chatgpt.com/c/1', title: 'GPT' }))
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: vi.fn(async () => ({})) })
    await expect(ctl.snapshot({ tabId: 1 })).rejects.toThrow(/AI conversation tab/)
  })
})
