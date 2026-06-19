import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X' })),
    },
    cookies: { getAll: vi.fn(async () => [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), set: vi.fn(async () => ({})) },
    downloads: { search: vi.fn(async () => [{ filename: '/tmp/a.zip', state: 'complete' }]) },
    runtime: { sendMessage: vi.fn() },
  }
})

describe('controller write', () => {
  it('evaluate returns the serialized result', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string) =>
      fq === 'Runtime.evaluate' ? { result: { value: JSON.stringify({ sum: 3 }) } } : {})
    const ctl = makeController({ send })
    const out = await ctl.evaluate({ tabId: 1, expression: '({sum:1+2})' })
    expect(out).toContain('sum')
  })

  it('storage set returns ok', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string) => fq === 'Runtime.evaluate' ? { result: { value: 'ok' } } : {})
    const ctl = makeController({ send })
    expect(await ctl.storage({ tabId: 1, area: 'local', op: 'set', key: 'k', value: 'v' })).toBe('ok')
  })

  it('cookies lists name=value pairs', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}) })
    const out = await ctl.cookies({ tabId: 1 })
    expect(out).toContain('a=1')
    expect(out).toContain('b=2')
  })

  it('upload without base64 rejects with a clear message', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}) })
    const out = await ctl.upload({ tabId: 1, selector: '#f', fileName: 'a.png' })
    expect(out).toMatch(/base64|unsupported/i)
  })

  it('downloads lists recent items', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: async () => ({}) })
    expect(await ctl.downloads({})).toContain('a.zip')
  })

  it('batch re-dispatches sub-calls and concatenates output', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const { registerBrowserTools } = await import('../../background/browser/register')
    const { initController } = await import('../../background/browser/controller')
    // batch re-dispatches via the dispatch TOOL_TABLE, which calls getController().
    // Initialize the singleton with our send so the sub-calls resolve in this test.
    initController({ send: async (_t: any, fq: string) => fq === 'Runtime.evaluate' ? { result: { value: 'page text' } } : {} })
    registerBrowserTools()
    const ctl = makeController({ send: async () => ({}) })
    const out = await ctl.batch({ tabId: 1, actions: [{ name: 'browser_get_page_text', input: {} }] })
    expect(out).toContain('browser_get_page_text')
  })
})
