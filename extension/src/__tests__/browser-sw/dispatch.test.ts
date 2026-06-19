import { describe, it, expect } from 'vitest'
import { browserTabKey, KeyedLock, dispatchBrowserTool, TOOL_TABLE, READONLY_TOOLS } from '../../background/browser/dispatch'

describe('dispatch lock + key', () => {
  it('browserTabKey: tabId → tab:<id>, missing → tab:default', () => {
    expect(browserTabKey({ tabId: 5 })).toBe('tab:5')
    expect(browserTabKey({ tabId: 0 })).toBe('tab:default')
    expect(browserTabKey({})).toBe('tab:default')
    expect(browserTabKey({ tabId: 3.0 })).toBe('tab:3')
  })
  it('KeyedLock serializes same key, parallelizes different keys', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    const slow = (k: string, tag: string, ms: number) => lock.run(k, async () => {
      order.push(`${tag}-start`); await new Promise(r => setTimeout(r, ms)); order.push(`${tag}-end`)
    })
    await Promise.all([slow('tab:1', 'A', 30), slow('tab:1', 'B', 1)])
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
    order.length = 0
    await Promise.all([slow('tab:1', 'C', 20), slow('tab:2', 'D', 20)])
    expect(order.slice(0, 2).sort()).toEqual(['C-start', 'D-start'])
  })

  it('KeyedLock: a rejected op does NOT poison the key (next op still runs)', async () => {
    // Load-bearing invariant: if a failing browser_click wedged its tab's lock, every
    // later op on that tab would hang — re-introducing the deadlock class the migration
    // removed. The caller still sees the rejection; the chain tail must not.
    const lock = new KeyedLock()
    await expect(lock.run('tab:1', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const r = await lock.run('tab:1', async () => 'ok')
    expect(r).toBe('ok')
  })
  it('dispatchBrowserTool: unknown tool → error result', async () => {
    const r = await dispatchBrowserTool('browser_nope', {}, 'c1')
    expect(r.success).toBe(false)
    expect(r.output).toContain('unknown browser tool')
  })
  it('dispatchBrowserTool: registered tool runs under the lock', async () => {
    // mark read-only so it skips the gates (which would need chrome.tabs)
    TOOL_TABLE.set('browser_test_echo', async (a) => `echo:${JSON.stringify(a)}`)
    READONLY_TOOLS.add('browser_test_echo')
    const r = await dispatchBrowserTool('browser_test_echo', { tabId: 2 }, 'c2')
    expect(r.success).toBe(true)
    expect(r.output).toContain('echo:')
    TOOL_TABLE.delete('browser_test_echo')
    READONLY_TOOLS.delete('browser_test_echo')
  })
})
