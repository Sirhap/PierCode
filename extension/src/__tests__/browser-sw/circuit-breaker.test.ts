import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CircuitBreaker, elementKey } from '../../background/browser/circuit-breaker'

// Item #5: element / page / global circuit breakers with CLOSED→OPEN→HALF_OPEN and
// cooldown auto-reset. Date.now() is mocked so we can advance past cooldowns.
let now = 1_000_000
beforeEach(() => { now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now) })
afterEach(() => { vi.restoreAllMocks() })
const advance = (ms: number) => { now += ms }

describe('elementKey', () => {
  it('is stable for the same tab + query and distinct across queries/tabs', () => {
    const a = elementKey(1, 'ref:e0')
    expect(elementKey(1, 'ref:e0')).toBe(a)
    expect(elementKey(2, 'ref:e0')).not.toBe(a)
    expect(elementKey(1, 'ref:e1')).not.toBe(a)
    expect(a.startsWith('1:')).toBe(true)
  })
})

describe('element breaker', () => {
  it('opens after 3 fails on the same element, then blocks the waterfall', () => {
    const cb = new CircuitBreaker()
    const k = elementKey(1, 'ref:e0')
    expect(cb.allow(1, k).allowed).toBe(true)
    cb.recordFailure(1, k); cb.recordFailure(1, k)
    expect(cb.allow(1, k).allowed).toBe(true)        // 2 fails: still closed
    cb.recordFailure(1, k)                            // 3rd fail → OPEN
    const d = cb.allow(1, k)
    expect(d.allowed).toBe(false)
    expect(d.scope).toBe('element')
    expect(d.reason).toMatch(/unavailable|repeated/i)
  })

  it('a success resets the element fail count (closes it)', () => {
    const cb = new CircuitBreaker()
    const k = elementKey(1, 'ref:e0')
    cb.recordFailure(1, k); cb.recordFailure(1, k)
    cb.recordSuccess(1, k)
    cb.recordFailure(1, k); cb.recordFailure(1, k)
    expect(cb.allow(1, k).allowed).toBe(true)        // only 2 since the reset
  })

  it('HALF_OPEN after the element cooldown (2min): one trial allowed', () => {
    const cb = new CircuitBreaker()
    const k = elementKey(1, 'ref:e0')
    cb.recordFailure(1, k); cb.recordFailure(1, k); cb.recordFailure(1, k)
    expect(cb.allow(1, k).allowed).toBe(false)       // OPEN
    advance(2 * 60_000 + 1)                           // past element cooldown
    expect(cb.allow(1, k).allowed).toBe(true)        // HALF_OPEN trial
  })
})

describe('page breaker', () => {
  it('opens after 5 DISTINCT failed elements in a tab → suggests reload', () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 5; i++) {
      const k = elementKey(1, `ref:e${i}`)
      cb.recordFailure(1, k)
    }
    // a 6th, fresh element is now blocked at page scope
    const d = cb.allow(1, elementKey(1, 'ref:e9'))
    expect(d.allowed).toBe(false)
    expect(d.scope).toBe('page')
    expect(d.reason).toMatch(/reload/i)
  })

  it('the page breaker is per-tab (a different tab is unaffected)', () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 5; i++) cb.recordFailure(1, elementKey(1, `ref:e${i}`))
    expect(cb.allow(2, elementKey(2, 'ref:e0')).allowed).toBe(true)
  })
})

describe('global breaker', () => {
  it('opens after 10 fails within 5min across any tabs → pause', () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 10; i++) cb.recordFailure(i % 3, elementKey(i % 3, `ref:e${i}`))
    const d = cb.allow(7, elementKey(7, 'ref:new'))
    expect(d.allowed).toBe(false)
    expect(d.scope).toBe('global')
    expect(d.reason).toMatch(/paus/i)
  })

  it('fails older than the 5min window do not count toward the global trip', () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 9; i++) cb.recordFailure(0, elementKey(0, `ref:old${i}`))
    advance(5 * 60_000 + 1)                            // slide the window past those 9
    cb.recordFailure(0, elementKey(0, 'ref:fresh'))    // 1 fresh fail
    // global still closed (only 1 within-window); element/page also closed for a NEW element
    expect(cb.allow(0, elementKey(0, 'ref:other')).allowed).toBe(true)
  })
})
