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
