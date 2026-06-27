import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AX_TREE } from './fixtures/ax-tree'

// Item #2: the click degradation chain. Tier 1 (coordinate click) runs first; on a
// SILENT_CLICK outcome the waterfall escalates through CSS → CDP coord → JS click →
// keyboard, stopping at the first tier that produces a SUCCESS outcome.
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

const SIG = (over: Record<string, unknown> = {}) => JSON.stringify({
  url: 'https://x.com/a', activeTag: 'BODY', activeText: '', dialogCount: 0,
  openMenuCount: 0, domSize: 100, ariaState: '', targetVisible: true, newOverlayText: '', ...over,
})

describe('click waterfall', () => {
  it('stops at tier 1 when the coordinate click succeeds (no escalation note)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    let probe = 0
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) {
          // before=base, after=navigated → SUCCESS on the first tier
          return { result: { value: probe++ === 0 ? SIG() : SIG({ url: 'https://x.com/b' }) } }
        }
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(out).toMatch(/outcome=SUCCESS/)
    expect(out).not.toMatch(/escalated/)
  })

  it('escalates to the JS-click tier when the coordinate click is silent', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const jsClicks: string[] = []
    let phase = 0   // 0 = pre tier-1, then each probe pair advances
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (fq === 'Runtime.callFunctionOn') { jsClicks.push('js-click'); return { result: { value: 'clicked' } } }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) {
          // tier-1 before/after identical (silent). After the JS-click tier runs, the
          // page "changes": once a js-click has been recorded, report a dom delta.
          phase++
          const changed = jsClicks.length > 0
          return { result: { value: changed ? SIG({ domSize: 200 }) : SIG() } }
        }
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(jsClicks.length).toBeGreaterThan(0)     // the JS-click tier was attempted
    expect(out).toMatch(/outcome=SUCCESS/)
    expect(out).toMatch(/escalated/)               // notes that it had to degrade
    void phase
  })

  it('reports SILENT_CLICK after exhausting the chain when nothing works', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (fq === 'Runtime.callFunctionOn') return { result: { value: 'clicked' } }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) return { result: { value: SIG() } }  // never changes
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    const out = await ctl.click({ tabId: 1, ref: 'e0' })
    expect(out).toMatch(/outcome=SILENT_CLICK/)
  })

  it('keyboard tier does not press Space after Enter already acts (audit #4)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const keys: string[] = []
    let enterPressed = false
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Accessibility.getFullAXTree') return AX_TREE
      if (fq === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (fq === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (fq === 'DOM.focus') return {}
      if (fq === 'Runtime.callFunctionOn') return { result: { value: 'clicked' } }   // js-click stays silent
      if (fq.startsWith('Input.dispatchKeyEvent')) {
        if (p?.type === 'keyDown') {
          const k = String(p?.key ?? '')
          keys.push(k)
          if (k === 'Enter') enterPressed = true
        }
        return {}
      }
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) {
          // Everything stays silent UNTIL Enter is pressed; then the page changes,
          // so the keyboard tier's mid-probe sees SUCCESS and must skip Space.
          return { result: { value: enterPressed ? SIG({ domSize: 300 }) : SIG() } }
        }
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    await ctl.snapshot({ tabId: 1 })
    await ctl.click({ tabId: 1, ref: 'e0' })
    expect(keys).toContain('Enter')
    expect(keys, 'Space must not be pressed once Enter already activated the control').not.toContain(' ')
  })

  it('escalation is skipped for explicit x/y coordinate clicks (no element to degrade to)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, fq: string, p: any) => {
      if (fq === 'Runtime.evaluate') {
        const expr: string = p?.expression || ''
        if (expr.includes('location.href')) return { result: { value: SIG() } }
        return { result: { value: true } }
      }
      return {}
    })
    const ctl = makeController({ send, sleep: noSleep })
    const out = await ctl.click({ tabId: 1, x: 50, y: 60 })
    // silent, but with only a raw point there is no ref/selector to escalate through
    expect(out).toMatch(/outcome=SILENT_CLICK/)
    expect(out).not.toMatch(/escalated/)
  })
})
