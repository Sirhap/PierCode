import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

// Wiring test for item #1: click/type annotate their output with a structured outcome.
beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X', windowId: 9 })),
      create: vi.fn(async (o: any) => ({ id: 42, url: o.url, title: '' })),
    },
    windows: { update: vi.fn(async () => {}) },
    runtime: { sendMessage: vi.fn() },
  }
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
})

const noSleep = async () => {}

// A `send` that drives both the AX tree (for refs) and the outcome snapshot eval.
// `outcomeQueue` supplies successive PageSig JSON strings for the before/after probes.
function makeSend(outcomeQueue: string[], extra?: (fq: string, p: any) => any) {
  let oi = 0
  return vi.fn(async (_t: any, fq: string, p: any) => {
    if (fq === 'Accessibility.getFullAXTree') return AX_TREE
    if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
    if (fq === 'Runtime.evaluate') {
      const expr: string = p?.expression || ''
      if (expr.includes('elementFromPoint(') && !expr.includes('location.href')) return { result: { value: true } } // assertPointActionable
      if (expr.includes('location.href')) { const v = outcomeQueue[Math.min(oi++, outcomeQueue.length - 1)]; return { result: { value: v } } }
      if (extra) { const r = extra(fq, p); if (r !== undefined) return r }
      return { result: { value: true } }
    }
    if (extra) { const r = extra(fq, p); if (r !== undefined) return r }
    return {}
  })
}

const SIG = (over: Record<string, unknown> = {}) => JSON.stringify({
  url: 'https://x.com/a', activeTag: 'BODY', activeText: '', dialogCount: 0,
  openMenuCount: 0, domSize: 100, ariaState: '', targetVisible: true, newOverlayText: '', ...over,
})

describe('controller outcome annotation', () => {
  it('click appends outcome=SUCCESS when the page navigates', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: makeSend([SIG(), SIG({ url: 'https://x.com/b' })]), sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(out).toMatch(/clicked at/)            // original text preserved
    expect(out).toMatch(/outcome=SUCCESS/)       // annotation appended
  })

  it('click appends outcome=SILENT_CLICK when nothing changes', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: makeSend([SIG(), SIG()]), sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(out).toMatch(/outcome=SILENT_CLICK/)
  })

  it('click annotation degrades silently to no-annotation if the probe throws', async () => {
    const { makeController } = await import('../../background/browser/controller')
    // outcome probe returns undefined value → parsePageSig null → UNKNOWN, but UNKNOWN
    // is suppressed from the annotation so we do not spam noise on every click.
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) throw new Error('probe blocked')
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(out).toMatch(/clicked at/)            // base text intact
    expect(out).not.toMatch(/outcome=/)          // no annotation on probe failure
  })

  it('type appends outcome=SUCCESS when the focused field value changes', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({
      send: makeSend(
        [SIG({ activeTag: 'INPUT', activeText: '' }), SIG({ activeTag: 'INPUT', activeText: 'hi' })],
        (fq) => (fq === 'Runtime.evaluate' ? undefined : undefined),
      ),
      sleep: noSleep,
    })
    // selector path → resolvePoint via selectorRectExpr; give it a rect.
    const out = await ctl.type({ tabId: 1, x: 5, y: 5, text: 'hi' })
    expect(out).toMatch(/typed 2 chars/)
    expect(out).toMatch(/outcome=SUCCESS/)
  })
})
