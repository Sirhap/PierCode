import { describe, it, expect, vi } from 'vitest'
import { makeCdp } from '../../background/browser/cdp'

describe('cdp wrappers', () => {
  it('runtimeEvaluate: wraps expr, returns Runtime.evaluate result.value', async () => {
    const send = vi.fn(async (_t: any, method: string, params: any) => {
      expect(method).toBe('Runtime.evaluate')
      expect(params.returnByValue).toBe(true)
      return { result: { value: 42 } }
    })
    const cdp = makeCdp(send)
    const v = await cdp.runtimeEvaluate({ tabId: 1 }, '1 + 41')
    expect(v).toBe(42)
    expect(send).toHaveBeenCalledOnce()
  })
  it('runtimeEvaluate: throws on exceptionDetails', async () => {
    const send = vi.fn(async () => ({ exceptionDetails: { text: 'boom' }, result: {} }))
    const cdp = makeCdp(send)
    await expect(cdp.runtimeEvaluate({ tabId: 1 }, 'throw 1')).rejects.toThrow(/boom/)
  })
  it('sendCommand: passes domain.method + params through', async () => {
    const send = vi.fn(async () => ({ ok: 1 }))
    const cdp = makeCdp(send)
    const r = await cdp.sendCommand({ tabId: 2 }, 'Page', 'navigate', { url: 'https://x.com' })
    expect(send).toHaveBeenCalledWith({ tabId: 2 }, 'Page.navigate', { url: 'https://x.com' })
    expect(r).toEqual({ ok: 1 })
  })
})
