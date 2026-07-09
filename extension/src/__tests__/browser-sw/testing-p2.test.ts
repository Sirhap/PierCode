// P2 testing capabilities: loopback autopilot, maxSteps, scrollIntoView guard,
// visual regression.
import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com/page', title: 'X' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com/page', title: 'X' })),
    },
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    alarms: { create: vi.fn(), clear: vi.fn() },
  }
})

describe('isLoopbackOrigin / loopbackAutoApprove', () => {
  it('recognizes loopback origins only', async () => {
    const { isLoopbackOrigin } = await import('../../background/browser-agent')
    expect(isLoopbackOrigin('http://localhost:3000')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackOrigin('http://app.localhost:3000')).toBe(true)
    expect(isLoopbackOrigin('https://x.com')).toBe(false)
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false)
    expect(isLoopbackOrigin('')).toBe(false)
  })

  it('auto-approves page-confined actions on loopback, never off loopback', async () => {
    const { loopbackAutoApprove } = await import('../../background/browser-agent')
    const lo = 'http://localhost:3000'
    expect(loopbackAutoApprove('browser_type', { text: 'q', submit: true }, lo)).toBe(true)
    expect(loopbackAutoApprove('browser_evaluate', { expression: '1' }, lo)).toBe(true)
    expect(loopbackAutoApprove('browser_form_input', { selector: '#a', value: 'x' }, lo)).toBe(true)
    // same actions on a non-loopback page → never auto
    expect(loopbackAutoApprove('browser_type', { text: 'q', submit: true }, 'https://x.com')).toBe(false)
  })

  it('still gates escape hatches: off-loopback navigate, foreign cookies, clipboard, upload, tab ops', async () => {
    const { loopbackAutoApprove } = await import('../../background/browser-agent')
    const lo = 'http://localhost:3000'
    expect(loopbackAutoApprove('browser_navigate', { url: 'https://evil.com' }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_navigate', { url: 'http://127.0.0.1:3000/x' }, lo)).toBe(true)
    expect(loopbackAutoApprove('browser_set_cookie', { url: 'https://x.com', name: 'a', value: 'b' }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_set_cookie', { domain: 'localhost', name: 'a', value: 'b' }, lo)).toBe(true)
    expect(loopbackAutoApprove('browser_cookies', {}, lo)).toBe(true)   // no explicit target = the loopback tab
    expect(loopbackAutoApprove('browser_clipboard', { op: 'read' }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_upload', { selector: '#f' }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_use_tab', { tabId: 9 }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_finalize_tabs', { close: [9] }, lo)).toBe(false)
  })

  it('batch/test recurse: one escaping child blocks the whole call', async () => {
    const { loopbackAutoApprove } = await import('../../background/browser-agent')
    const lo = 'http://localhost:3000'
    expect(loopbackAutoApprove('browser_batch', {
      actions: [
        { name: 'browser_click', input: { selector: '#a' } },
        { name: 'browser_navigate', input: { url: 'http://localhost:3000/next' } },
      ],
    }, lo)).toBe(true)
    expect(loopbackAutoApprove('browser_batch', {
      actions: [{ name: 'browser_navigate', input: { url: 'https://x.com' } }],
    }, lo)).toBe(false)
    expect(loopbackAutoApprove('browser_test', {
      steps: [{ tool: 'browser_clipboard', args: { op: 'read' } }],
    }, lo)).toBe(false)
  })
})

describe('runBrowserAgentLoop maxSteps', () => {
  it('caps rounds at opts.maxSteps and ends with max-depth', async () => {
    const { runBrowserAgentLoop } = await import('../../background/browser-agent')
    let injects = 0
    const emitted: any[] = []
    const r = await runBrowserAgentLoop({
      platform: 'chatgpt', task: 'poke', targetTabId: 1,
      signal: new AbortController().signal,
      emit: m => emitted.push(m),
      inject: async () => { injects++; return { ok: true } },
      awaitTools: async () => ({ tools: [{ name: 'browser_snapshot', args: {}, call_id: `c${injects}` }], rawContent: '' }),
      exec: async (name, _a, callId) => ({ call_id: callId || 'c', name, output: 'ok', success: true }),
      gate: async () => 'approve',
      askQuestion: async () => '',
      maxSteps: 2,
    })
    expect(r.reason).toBe('max-depth')
    expect(injects).toBe(2)
  })
})

describe('resolvePoint scrollIntoView guard', () => {
  it('ref: issues DOM.scrollIntoViewIfNeeded before getBoxModel', async () => {
    const { resolvePoint } = await import('../../background/browser/ref-resolve')
    const { TabRegistry } = await import('../../background/browser/registry')
    const { makeCdp } = await import('../../background/browser/cdp')
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 'snap1', { e0: { ref: 'e0', nodeId: 'n', backendId: 42, role: 'button', name: 'Go', bounds: null, sessionId: '', frameOffset: null } })
    const calls: string[] = []
    const cdp = makeCdp(async (_t, method) => {
      calls.push(method)
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      return {}
    })
    const p = await resolvePoint(cdp, reg, { tabId: 1 }, { tabId: 1, ref: 'e0' })
    expect(p.point).toEqual({ x: 5, y: 5 })
    expect(calls.indexOf('DOM.scrollIntoViewIfNeeded')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('DOM.scrollIntoViewIfNeeded')).toBeLessThan(calls.indexOf('DOM.getBoxModel'))
  })

  it('selector: expression scrolls before measuring', async () => {
    const { resolvePoint } = await import('../../background/browser/ref-resolve')
    const { TabRegistry } = await import('../../background/browser/registry')
    const { makeCdp } = await import('../../background/browser/cdp')
    let expr = ''
    const cdp = makeCdp(async (_t, method, params: any) => {
      if (method === 'Runtime.evaluate') { expr = params.expression; return { result: { value: { x: 0, y: 0, width: 10, height: 10 } } } }
      return {}
    })
    await resolvePoint(cdp, new TabRegistry(), { tabId: 1 }, { tabId: 1, selector: '#go' })
    expect(expr).toContain('scrollIntoView')
  })
})

describe('visual diff (pure)', () => {
  it('diffRGBA counts pixels beyond tolerance', async () => {
    const { diffRGBA } = await import('../../background/browser/visual')
    const a = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255])   // 2 px
    const same = new Uint8ClampedArray(a)
    expect(diffRGBA(a, same, 2, 1).ratio).toBe(0)
    const b = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 100, 255])   // 2nd px +100 red
    const r = diffRGBA(a, b, 2, 1)
    expect(r.diffPx).toBe(1)
    expect(r.ratio).toBe(0.5)
    // within tolerance → no diff
    const c = new Uint8ClampedArray([10, 0, 0, 255, 100, 100, 100, 255])  // 1st px +10 red ≤ 16
    expect(diffRGBA(a, c, 2, 1).diffPx).toBe(0)
  })

  it('renderVisualOutcome PASS/FAIL text', async () => {
    const { renderVisualOutcome } = await import('../../background/browser/visual')
    const ok = renderVisualOutcome('home', { width: 10, height: 10, totalPx: 100, diffPx: 0, ratio: 0 }, 0.01)
    expect(ok.pass).toBe(true)
    expect(ok.text).toContain('VISUAL PASS')
    const bad = renderVisualOutcome('home', { width: 10, height: 10, totalPx: 100, diffPx: 5, ratio: 0.05 }, 0.01)
    expect(bad.pass).toBe(false)
    expect(bad.text).toContain('VISUAL FAIL')
    expect(bad.text).toContain('5.00%')
  })

  it('validateVisualKey', async () => {
    const { validateVisualKey } = await import('../../background/browser/visual')
    expect(validateVisualKey('home')).toBeNull()
    expect(validateVisualKey('')).toMatch(/key is required/)
    expect(validateVisualKey('x'.repeat(101))).toMatch(/at most 100/)
  })
})

describe('controller.visualDiff (storage paths)', () => {
  it('compare without a baseline throws a clear redirect to action=baseline', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) =>
      method === 'Page.captureScreenshot' ? { data: 'aGk=' } : {})
    const ctl = makeController({ send })
    await expect(ctl.visualDiff({ action: 'compare', key: 'home' })).rejects.toThrow(/no baseline for key "home"/)
  })

  it('missing key rejected before any CDP call; clear/list work off storage', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async () => ({}))
    const ctl = makeController({ send })
    await expect(ctl.visualDiff({ action: 'compare' })).rejects.toThrow(/key is required/)
    expect(send).not.toHaveBeenCalled()
    ;(chrome.storage.local.get as any).mockResolvedValueOnce({
      piercode_visual_baseline_home: { base64: 'x', width: 8, height: 6, savedAt: 0 },
      other_key: 1,
    })
    const listed = await ctl.visualDiff({ action: 'list' })
    expect(listed).toContain('home — 8x6')
    expect(listed).not.toContain('other_key')
    const cleared = await ctl.visualDiff({ action: 'clear', key: 'home' })
    expect(cleared).toContain('cleared visual baseline "home"')
    expect(chrome.storage.local.remove).toHaveBeenCalledWith('piercode_visual_baseline_home')
  })
})
