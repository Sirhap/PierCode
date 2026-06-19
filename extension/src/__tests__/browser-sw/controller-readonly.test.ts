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

  it('AI-page tab without approval is refused', async () => {
    ;(globalThis as any).chrome.tabs.get = vi.fn(async () => ({ id: 1, url: 'https://chatgpt.com/c/1', title: 'GPT' }))
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: vi.fn(async () => ({})) })
    await expect(ctl.snapshot({ tabId: 1 })).rejects.toThrow(/AI conversation tab/)
  })
})
