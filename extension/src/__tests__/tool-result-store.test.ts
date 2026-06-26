import { describe, it, expect, beforeEach, vi } from 'vitest'

// localStorage shim (jsdom not needed — store is pure storage).
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
globalThis.localStorage = new MemStorage() as any

const { saveToolResult, loadToolResult } = await import('../content/tool-result-store')

const rec = (over: Partial<Parameters<typeof saveToolResult>[1]> = {}) => ({
  name: 'read_file',
  argsPreview: '/tmp/x',
  output: 'hello world',
  status: 'done' as const,
  durationMs: 123,
  ts: Date.now(),
  ...over,
})

describe('tool-result-store', () => {
  beforeEach(() => { (globalThis.localStorage as any).clear() })

  it('save/load round-trips', () => {
    saveToolResult('k1', rec())
    const got = loadToolResult('k1')
    expect(got).not.toBeNull()
    expect(got!.output).toBe('hello world')
    expect(got!.status).toBe('done')
    expect(got!.durationMs).toBe(123)
  })

  it('miss returns null', () => {
    expect(loadToolResult('nope')).toBeNull()
  })

  it('prunes entries older than TTL on the next save', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000 // 8d > 7d TTL
    saveToolResult('stale', rec({ ts: old }))
    // A fresh save triggers the TTL sweep.
    saveToolResult('fresh', rec())
    expect(loadToolResult('stale')).toBeNull()
    expect(loadToolResult('fresh')).not.toBeNull()
  })

  it('load returns null for an entry past TTL even without a save sweep', () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000
    saveToolResult('stale', rec({ ts: old }))
    expect(loadToolResult('stale')).toBeNull()
  })

  it('truncates oversized output', () => {
    const big = 'x'.repeat(5000)
    saveToolResult('big', rec({ output: big }))
    const got = loadToolResult('big')
    expect(got!.output.length).toBeLessThan(5000)
    expect(got!.output).toContain('已截断')
  })

  it('evicts oldest entries beyond the count cap', () => {
    // Insert 205 entries with increasing ts; cap is 200, so the 5 oldest go.
    const base = Date.now() - 1000
    for (let i = 0; i < 205; i++) {
      saveToolResult(`key${i}`, rec({ ts: base + i }))
    }
    // Oldest 5 (key0..key4) evicted.
    expect(loadToolResult('key0')).toBeNull()
    expect(loadToolResult('key4')).toBeNull()
    expect(loadToolResult('key5')).not.toBeNull()
    expect(loadToolResult('key204')).not.toBeNull()
  })

  it('swallows storage errors — load returns null when getItem throws', () => {
    const spy = vi.spyOn(globalThis.localStorage as any, 'getItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveToolResult('e', rec())).not.toThrow()
    expect(loadToolResult('e')).toBeNull()
    spy.mockRestore()
  })
})
