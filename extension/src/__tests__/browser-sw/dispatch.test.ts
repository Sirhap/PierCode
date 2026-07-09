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

  it('dispatchBrowserTool: browser_batch does NOT self-deadlock re-dispatching same-key sub-calls', async () => {
    // browser_batch runs its sub-actions by re-entering dispatchBrowserTool. If
    // the batch itself were wrapped in lock.run (like every other tool), the
    // first same-key sub-call would queue behind the still-running batch →
    // permanent hang (KeyedLock is not reentrant). The dispatcher special-cases
    // browser_batch to hold no lock; this test would time out without that.
    TOOL_TABLE.set('browser_test_sub', async (a) => `sub:${(a as any).n}`)
    READONLY_TOOLS.add('browser_test_sub')
    TOOL_TABLE.set('browser_batch', async (a) => {
      const acts = (a as any).actions as Array<{ n: number }>
      const out: string[] = []
      for (const act of acts) {
        // No tabId → key tab:default, SAME as the batch itself.
        const r = await dispatchBrowserTool('browser_test_sub', { n: act.n }, '')
        out.push(r.output)
      }
      return out.join(',')
    })

    const result = await Promise.race([
      dispatchBrowserTool('browser_batch', { actions: [{ n: 1 }, { n: 2 }] }, 'cb'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: browser_batch never completed')), 1000)),
    ])
    expect((result as any).success).toBe(true)
    expect((result as any).output).toContain('sub:1')
    expect((result as any).output).toContain('sub:2')

    TOOL_TABLE.delete('browser_test_sub'); READONLY_TOOLS.delete('browser_test_sub')
    TOOL_TABLE.delete('browser_batch')
  })

  it('dispatchBrowserTool: appends a hint (item #4) when the result matches a rule', async () => {
    // A tool whose output trips the snapshot-stale rule gets a recovery hint appended.
    TOOL_TABLE.set('browser_test_stale', async () => 'ref e9 is stale or unknown; take a fresh browser_snapshot')
    READONLY_TOOLS.add('browser_test_stale')
    const r = await dispatchBrowserTool('browser_test_stale', { tabId: 3 }, 'c3')
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Hint:/)
    expect(r.output).toMatch(/stale/i)
    TOOL_TABLE.delete('browser_test_stale')
    READONLY_TOOLS.delete('browser_test_stale')
  })

  it('dispatchBrowserTool: appends an error-recovery hint on the error path', async () => {
    TOOL_TABLE.set('browser_test_boom', async () => { throw new Error('kaboom') })
    READONLY_TOOLS.add('browser_test_boom')
    const r = await dispatchBrowserTool('browser_test_boom', { tabId: 4 }, 'c4')
    expect(r.success).toBe(false)
    expect(r.error).toBe('kaboom')
    expect(r.output).toMatch(/kaboom/)
    expect(r.output).toMatch(/fresh browser_snapshot/i)
    TOOL_TABLE.delete('browser_test_boom')
    READONLY_TOOLS.delete('browser_test_boom')
  })
})
