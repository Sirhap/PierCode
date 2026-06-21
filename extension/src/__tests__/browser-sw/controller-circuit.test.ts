import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

// Item #5: the circuit breaker WIRED into the click path. After 3 consecutive
// SILENT_CLICK outcomes on the same element key, the breaker opens and the next click
// short-circuits — returning the "unavailable" reason WITHOUT spinning the waterfall.
beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X', windowId: 9 })),
    },
    windows: { update: vi.fn(async () => {}) },
    runtime: { sendMessage: vi.fn() },
  }
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
})
const noSleep = async () => {}

// A page signature that NEVER changes → every click classifies as SILENT_CLICK.
const STATIC_SIG = JSON.stringify({
  url: 'https://x.com/a', activeTag: 'BODY', activeText: '', dialogCount: 0,
  openMenuCount: 0, domSize: 100, ariaState: '', targetVisible: true, newOverlayText: '',
})

function makeSilentSend(jsClicks: string[]) {
  return vi.fn(async (_t: any, fq: string, p: any) => {
    if (fq === 'Accessibility.getFullAXTree') return AX_TREE
    if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
    if (fq === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
    if (fq === 'Runtime.callFunctionOn') { jsClicks.push('js-click'); return { result: { value: 'clicked' } } }
    if (fq === 'Runtime.evaluate') {
      const expr: string = p?.expression || ''
      if (expr.includes('location.href')) return { result: { value: STATIC_SIG } }   // always silent
      return { result: { value: true } }
    }
    return {}
  })
}

describe('controller circuit breaker (item #5)', () => {
  it('opens after 3 SILENT_CLICK on the same ref and then short-circuits without escalating', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const jsClicks: string[] = []
    const send = makeSilentSend(jsClicks)
    const ctl = makeController({ send, sleep: noSleep })

    // 3 attempts: each is SILENT_CLICK, each escalates through the waterfall, each records a
    // failure. A fresh snapshot precedes each (a click markStale()s refs — mirrors the AI's
    // observe→act loop).
    for (let i = 0; i < 3; i++) {
      await ctl.snapshot({ tabId: 1 })
      const out = await ctl.click({ tabId: 1, ref: 'e0' })
      expect(out).toMatch(/outcome=SILENT_CLICK/)
    }
    const clicksBefore = jsClicks.length
    expect(clicksBefore).toBeGreaterThan(0)               // waterfall ran on the failing attempts

    // 4th attempt: breaker is OPEN → short-circuit with the unavailable reason, no waterfall.
    await ctl.snapshot({ tabId: 1 })
    const blocked = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(blocked).toMatch(/unavailable|repeated/i)
    expect(blocked).toMatch(/skipped click/i)
    expect(blocked).not.toMatch(/escalated/)
    expect(jsClicks.length).toBe(clicksBefore)            // no further escalation attempts
  })

  it('a different element on the same tab is unaffected by another element opening', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = makeSilentSend([])
    const ctl = makeController({ send, sleep: noSleep })
    for (let i = 0; i < 3; i++) { await ctl.snapshot({ tabId: 1 }); await ctl.click({ tabId: 1, ref: 'e0' }) }   // open e0
    await ctl.snapshot({ tabId: 1 })
    const other = await ctl.click({ tabId: 1, ref: 'e1' })                 // e1 still allowed
    expect(other).not.toMatch(/skipped click/i)
  })

  it('raw x/y clicks skip the breaker entirely (never short-circuit)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = makeSilentSend([])
    const ctl = makeController({ send, sleep: noSleep })
    // Many silent x/y clicks must never trip the breaker (no element to address).
    for (let i = 0; i < 6; i++) {
      const out = await ctl.click({ tabId: 1, x: 5, y: 5 })
      expect(out).not.toMatch(/skipped click/i)
      expect(out).toMatch(/outcome=SILENT_CLICK/)
    }
  })

  it('a SUCCESS resets the element circuit so it never opens mid-stream', async () => {
    const { makeController } = await import('../../background/browser/controller')
    let nav = 0
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (fq === 'Runtime.callFunctionOn') return { result: { value: 'clicked' } }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        // Alternate: every click navigates (url changes within the pair) → SUCCESS.
        if (expr.includes('location.href')) return { result: { value: JSON.stringify({ ...JSON.parse(STATIC_SIG), url: `https://x.com/n${nav++}` }) } }
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    for (let i = 0; i < 5; i++) {
      await ctl.snapshot({ tabId: 1 })
      const out = await ctl.click({ tabId: 1, ref: 'e0' })
      expect(out).not.toMatch(/skipped click/i)           // success keeps it closed forever
    }
  })
})
