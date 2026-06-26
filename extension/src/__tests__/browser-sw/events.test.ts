import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../../background/browser/events'

describe('EventBus', () => {
  it('console ring caps at 1000, keeps newest', () => {
    const bus = new EventBus()
    for (let i = 0; i < 1100; i++) bus.recordConsole(1, { level: 'log', text: `m${i}` })
    const msgs = bus.readConsole(1)
    expect(msgs.length).toBe(1000)
    expect(msgs[msgs.length - 1].text).toBe('m1099')
    expect(msgs[0].text).toBe('m100')
  })
  it('network ring caps at 500', () => {
    const bus = new EventBus()
    for (let i = 0; i < 600; i++) bus.recordNetwork(1, { requestId: `r${i}`, url: `https://x/${i}`, method: 'GET' })
    expect(bus.readNetwork(1).length).toBe(500)
  })
  it('clear on tab removal', () => {
    const bus = new EventBus()
    bus.recordConsole(2, { level: 'log', text: 'a' })
    bus.clearTab(2)
    expect(bus.readConsole(2).length).toBe(0)
  })
  it('nav waiter resolves on matching event', async () => {
    const bus = new EventBus()
    const p = bus.waitForNav(3, 1000)
    bus.handleNavEvent(3, { url: 'https://done.com' })
    await expect(p).resolves.toMatchObject({ url: 'https://done.com' })
  })
  it('nav waiter does not leak its resolver on timeout', async () => {
    vi.useFakeTimers()
    try {
      const bus = new EventBus()
      const p = bus.waitForNav(4, 1000)
      // Swallow the expected rejection so it doesn't surface as unhandled.
      p.catch(() => {})
      // Before timeout: one resolver registered.
      expect((bus as any).navWaiters.get(4)?.length).toBe(1)
      vi.advanceTimersByTime(1001)
      await Promise.resolve()
      // After timeout: the dead resolver must be spliced out, not left to fire
      // (and resolve an already-rejected promise) on the next nav event.
      expect((bus as any).navWaiters.get(4)?.length ?? 0).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('domain-enable dedupe', () => {
    const bus = new EventBus()
    expect(bus.domainEnabled(1, 'Network')).toBe(false)
    bus.markDomainEnabled(1, 'Network')
    expect(bus.domainEnabled(1, 'Network')).toBe(true)
  })
})
