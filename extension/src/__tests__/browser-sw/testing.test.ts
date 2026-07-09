// browser_assert / browser_wait_stable / browser_test — SW testing primitives.
import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}) },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: 'https://x.com/page', title: 'X Page' }]),
      get: vi.fn(async () => ({ id: 1, url: 'https://x.com/page', title: 'X Page' })),
    },
    runtime: { sendMessage: vi.fn() },
  }
})

// Runtime.evaluate mock helper: value per expression matcher.
function evalSend(handler: (expr: string) => unknown) {
  return vi.fn(async (_t: any, method: string, params?: any) => {
    if (method === 'Runtime.evaluate') return { result: { value: handler(String(params?.expression || '')) } }
    return {}
  })
}

const probeValue = (p: Partial<{ count: number; visible: boolean; text: string; attr: string | null }>) =>
  JSON.stringify({ count: 0, visible: false, text: '', attr: null, ...p })

describe('testing helpers (pure)', () => {
  it('validateAssertArgs rejects bad shapes', async () => {
    const { validateAssertArgs } = await import('../../background/browser/testing')
    expect(validateAssertArgs({ kind: 'nope' as any })).toMatch(/kind must be one of/)
    expect(validateAssertArgs({ kind: 'element_text' })).toMatch(/requires a selector/)
    expect(validateAssertArgs({ kind: 'element_text', selector: '#a' })).toMatch(/requires expect/)
    expect(validateAssertArgs({ kind: 'attribute', selector: '#a', expect: 'x' })).toMatch(/attribute name/)
    expect(validateAssertArgs({ kind: 'element_count', selector: '#a' })).toMatch(/numeric count/)
    expect(validateAssertArgs({ kind: 'url' })).toMatch(/requires expect/)
    expect(validateAssertArgs({ kind: 'url', expect: 'x.com' })).toBeNull()
    expect(validateAssertArgs({ kind: 'console_clean' })).toBeNull()
  })

  it('matchValue: contains / equals / regex (invalid regex = no match, not throw)', async () => {
    const { matchValue } = await import('../../background/browser/testing')
    expect(matchValue('Hello World', 'World')).toBe(true)
    expect(matchValue('Hello', 'Hello', 'equals')).toBe(true)
    expect(matchValue('Hello', 'hell', 'equals')).toBe(false)
    expect(matchValue('v1.2.3', String.raw`^v\d+\.\d+`, 'regex')).toBe(true)
    expect(matchValue('abc', '[', 'regex')).toBe(false)
  })

  it('parseTestSteps: aliases, limits, nesting', async () => {
    const { parseTestSteps } = await import('../../background/browser/testing')
    expect(parseTestSteps([])).toMatch(/non-empty/)
    expect(parseTestSteps([{ name: 'exec_cmd', input: {} }])).toMatch(/not a browser_\* tool/)
    expect(parseTestSteps([{ name: 'browser_test', input: {} }])).toMatch(/cannot be nested/)
    const ok = parseTestSteps([
      { name: 'browser_click', input: { selector: '#b' } },
      { tool: 'browser_assert', args: { kind: 'title', expect: 'X' } },   // alias shape
    ])
    expect(Array.isArray(ok)).toBe(true)
    expect((ok as any)[1]).toEqual({ name: 'browser_assert', input: { kind: 'title', expect: 'X' } })
    expect(parseTestSteps(Array.from({ length: 51 }, () => ({ name: 'browser_wait', input: {} })))).toMatch(/at most 50/)
  })

  it('renderTestReport: human lines + parseable JSON line, no fenced block', async () => {
    const { renderTestReport } = await import('../../background/browser/testing')
    const out = renderTestReport({
      name: 't1', result: 'FAIL', passed: 1, failed: 1, skipped: 1, durationMs: 42,
      steps: [
        { index: 1, tool: 'browser_navigate', status: 'pass', ms: 10 },
        { index: 2, tool: 'browser_assert', status: 'fail', ms: 5, error: 'ASSERT FAIL: x' },
        { index: 3, tool: 'browser_click', status: 'skipped', ms: 0 },
      ],
      pageUrl: 'https://x.com', consoleTail: ['[error] boom'],
    })
    expect(out).toContain('TEST REPORT: t1')
    expect(out).toContain('1. ✓ browser_navigate')
    expect(out).toContain('2. ✗ browser_assert')
    expect(out).toContain('3. ○ browser_click — skipped')
    expect(out).toContain('[error] boom')
    expect(out).not.toContain('```')
    const jsonLine = out.split('\n').find(l => l.startsWith('JSON: '))
    expect(jsonLine).toBeTruthy()
    const parsed = JSON.parse(jsonLine!.slice(6))
    expect(parsed).toMatchObject({ name: 't1', result: 'FAIL', passed: 1, failed: 1, skipped: 1 })
  })
})

describe('controller.assert', () => {
  it('url contains → PASS; equals mismatch → throws with expected vs actual', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: evalSend(() => null) })
    await expect(ctl.assert({ kind: 'url', expect: 'x.com' })).resolves.toContain('ASSERT PASS')
    await expect(ctl.assert({ kind: 'url', expect: 'https://y.com', match: 'equals' }))
      .rejects.toThrow(/ASSERT FAIL.*expected https:\/\/y\.com.*actual https:\/\/x\.com\/page/)
  })

  it('element_text / element_visible / element_count / attribute via one probe', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({
      send: evalSend(() => probeValue({ count: 3, visible: false, text: 'Order complete', attr: 'primary' })),
    })
    await expect(ctl.assert({ kind: 'element_text', selector: '#s', expect: 'complete' })).resolves.toContain('ASSERT PASS')
    await expect(ctl.assert({ kind: 'element_text', selector: '#s', expect: 'pending' }))
      .rejects.toThrow(/actual Order complete/)
    await expect(ctl.assert({ kind: 'element_visible', selector: '#s' }))
      .rejects.toThrow(/present but hidden/)
    await expect(ctl.assert({ kind: 'element_count', selector: '#s', count: 2, op: '>=' })).resolves.toContain('ASSERT PASS')
    await expect(ctl.assert({ kind: 'attribute', selector: '#s', attribute: 'class', expect: 'primary', match: 'equals' }))
      .resolves.toContain('ASSERT PASS')
  })

  it('element_exists / not_exists on missing element', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: evalSend(() => probeValue({ count: 0 })) })
    await expect(ctl.assert({ kind: 'element_exists', selector: '#gone' })).rejects.toThrow(/count=0/)
    await expect(ctl.assert({ kind: 'element_not_exists', selector: '#gone' })).resolves.toContain('ASSERT PASS')
  })

  it('console_clean: fails on recorded error (with pattern filter)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: evalSend(() => null) })
    ctl.events.recordConsole(1, { level: 'error', text: 'TypeError: boom' })
    ctl.events.recordConsole(1, { level: 'log', text: 'fine' })
    await expect(ctl.assert({ kind: 'console_clean' })).rejects.toThrow(/TypeError: boom/)
    await expect(ctl.assert({ kind: 'console_clean', pattern: 'NetworkError' })).resolves.toContain('ASSERT PASS')
  })

  it('network_ok: fails on >=400 response (with url filter)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const ctl = makeController({ send: evalSend(() => null) })
    ctl.events.recordNetwork(1, { requestId: 'r1', url: 'https://x.com/api/save', method: 'POST', status: 500 })
    ctl.events.recordNetwork(1, { requestId: 'r2', url: 'https://x.com/ok', method: 'GET', status: 200 })
    await expect(ctl.assert({ kind: 'network_ok' })).rejects.toThrow(/500 https:\/\/x\.com\/api\/save/)
    await expect(ctl.assert({ kind: 'network_ok', pattern: '/ok' })).resolves.toContain('ASSERT PASS')
  })

  it('invalid args throw a validation error (not an evaluate attempt)', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = evalSend(() => null)
    const ctl = makeController({ send })
    await expect(ctl.assert({ kind: 'bogus' } as any)).rejects.toThrow(/kind must be one of/)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('controller.waitStable', () => {
  it('evaluates a MutationObserver quiet-window promise and returns its note', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = evalSend(expr => (expr.includes('MutationObserver') ? 'stable after 320ms (quiet 300ms)' : null))
    const ctl = makeController({ send })
    const out = await ctl.waitStable({ tabId: 1, quietMs: 300, timeoutMs: 2000 })
    expect(out).toContain('stable after 320ms')
    const expr = String((send.mock.calls[0] as any)[2]?.expression || '')
    expect(expr).toContain('MutationObserver')
  })
})

describe('controller.test (scripted runner)', () => {
  async function makeHarness(dispatchImpl: (name: string, args: Record<string, unknown>) => { output: string; success: boolean }) {
    const { makeController, setBatchDispatcher } = await import('../../background/browser/controller')
    const ctl = makeController({ send: evalSend(() => 'stable') })
    const calls: Array<{ name: string; args: Record<string, unknown>; opts: any }> = []
    setBatchDispatcher(async (name, args, _cid, opts) => {
      calls.push({ name, args, opts })
      return dispatchImpl(name, args)
    })
    return { ctl, calls }
  }

  it('stop-on-first-failure: later steps report skipped; report carries artifacts', async () => {
    const { ctl, calls } = await makeHarness(name =>
      name === 'browser_assert'
        ? { output: 'ASSERT FAIL: element_text — expected x; actual y', success: false }
        : { output: 'ok', success: true })
    ctl.events.recordConsole(1, { level: 'error', text: 'boom' })
    const out = await ctl.test({
      name: 'login flow',
      steps: [
        { name: 'browser_click', input: { selector: '#go' } },
        { name: 'browser_assert', input: { kind: 'element_text', selector: '#s', expect: 'x' } },
        { name: 'browser_click', input: { selector: '#never' } },
      ],
    })
    expect(out).toContain('TEST REPORT: login flow')
    expect(out).toContain('result: FAIL (1 passed, 1 failed, 1 skipped of 3)')
    expect(out).toContain('3. ○ browser_click — skipped')
    expect(out).toContain('page: https://x.com/page')
    expect(out).toContain('[error] boom')
    // only the first two steps dispatched
    expect(calls.map(c => c.name)).toEqual(['browser_click', 'browser_assert'])
  })

  it('stopOnFailure:false runs every step; PASS report when all green', async () => {
    const { ctl, calls } = await makeHarness(() => ({ output: 'ok', success: true }))
    const out = await ctl.test({
      steps: [
        { name: 'browser_navigate', input: { url: 'https://x.com' } },
        { name: 'browser_assert', input: { kind: 'url', expect: 'x.com' } },
      ],
      stopOnFailure: false,
    })
    expect(out).toContain('result: PASS (2 passed, 0 failed, 0 skipped of 2)')
    expect(calls).toHaveLength(2)
  })

  it('forwards __skipApproval + default tabId to steps (sidebar route contract)', async () => {
    const { ctl, calls } = await makeHarness(() => ({ output: 'ok', success: true }))
    await ctl.test({
      tabId: 7,
      steps: [{ name: 'browser_click', input: { selector: '#b' } }],
      __skipApproval: true,
    })
    expect(calls[0].opts.skipApproval).toBe(true)
    expect(calls[0].args.tabId).toBe(7)
  })

  it('batch forwards __skipApproval to sub-calls too', async () => {
    const { ctl, calls } = await makeHarness(() => ({ output: 'ok', success: true }))
    await ctl.batch({ actions: [{ name: 'browser_click', input: { selector: '#b' } }], __skipApproval: true })
    expect(calls[0].opts.skipApproval).toBe(true)
  })

  it('rejects nested browser_test / non-browser steps via parse', async () => {
    const { ctl } = await makeHarness(() => ({ output: 'ok', success: true }))
    await expect(ctl.test({ steps: [{ name: 'browser_test', input: {} }] })).rejects.toThrow(/cannot be nested/)
    await expect(ctl.test({ steps: [{ name: 'write_file', input: {} }] })).rejects.toThrow(/not a browser_\* tool/)
  })
})

describe('dispatch stamps __skipApproval for re-dispatching meta-tools', () => {
  it('browser_test dispatched with skipApproval carries the stamp into args', async () => {
    const { dispatchBrowserTool, TOOL_TABLE } = await import('../../background/browser/dispatch')
    const seen: Record<string, unknown>[] = []
    TOOL_TABLE.set('browser_test', async args => { seen.push(args); return 'ok' })
    try {
      const r = await dispatchBrowserTool('browser_test', {}, 'c1', { skipApproval: true })
      expect(r.success).toBe(true)
      expect(seen[0]?.__skipApproval).toBe(true)
    } finally {
      TOOL_TABLE.delete('browser_test')
    }
  })
})

describe('intercept helpers (pure)', () => {
  it('urlMatches: substring + glob', async () => {
    const { urlMatches } = await import('../../background/browser/intercept')
    expect(urlMatches('/api/user', 'https://x.com/api/user?id=1')).toBe(true)
    expect(urlMatches('/api/other', 'https://x.com/api/user')).toBe(false)
    expect(urlMatches('*://x.com/api/*', 'https://x.com/api/user')).toBe(true)
    expect(urlMatches('*.png', 'https://x.com/a/b.png')).toBe(true)
    expect(urlMatches('', 'anything')).toBe(true)   // empty = match all
  })

  it('resolvePaused: first-match, method filter, times budget, fail vs fulfill', async () => {
    const { InterceptStore, resolvePaused } = await import('../../background/browser/intercept')
    const s = new InterceptStore()
    s.add(1, { urlPattern: '/api/login', method: 'POST', fulfill: { status: 401, body: 'no' } })
    s.add(1, { urlPattern: '/track', fail: 'BlockedByClient', times: 1 })
    const rules = s.rules(1)

    const a = resolvePaused(rules, 'https://x.com/api/login', 'POST')
    expect(a.kind).toBe('fulfill')
    expect((a as any).fulfill.status).toBe(401)
    // method mismatch → no rule → continue
    expect(resolvePaused(rules, 'https://x.com/api/login', 'GET').kind).toBe('continue')
    // times:1 → first blocks, second falls through
    expect(resolvePaused(rules, 'https://x.com/track', 'GET').kind).toBe('fail')
    expect(resolvePaused(rules, 'https://x.com/track', 'GET').kind).toBe('continue')
  })

  it('describe + clearTab', async () => {
    const { InterceptStore } = await import('../../background/browser/intercept')
    const s = new InterceptStore()
    expect(s.describe(1)).toContain('no active intercepts')
    s.add(1, { urlPattern: '/a', fulfill: { status: 200 } })
    expect(s.describe(1)).toContain('#1')
    expect(s.has(1)).toBe(true)
    s.clearTab(1)
    expect(s.has(1)).toBe(false)
  })
})

describe('controller.intercept', () => {
  function cdpRecorder() {
    const calls: Array<{ method: string; params: any }> = []
    const send = vi.fn(async (_t: any, method: string, params?: any) => {
      calls.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { value: null } }
      return {}
    })
    return { send, calls }
  }

  it('add enables Fetch once, then rule add does not re-enable', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const { send, calls } = cdpRecorder()
    const ctl = makeController({ send })
    await ctl.intercept({ action: 'add', url: '/api', status: 200, body: '{"ok":1}' })
    await ctl.intercept({ action: 'add', url: '/track', fail: 'BlockedByClient' })
    const enables = calls.filter(c => c.method === 'Fetch.enable')
    expect(enables).toHaveLength(1)
    expect(enables[0].params.patterns[0]).toMatchObject({ urlPattern: '*', requestStage: 'Request' })
    expect(ctl.intercepts.rules(1)).toHaveLength(2)
  })

  it('add with bad fail reason throws and adds no rule', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const { send } = cdpRecorder()
    const ctl = makeController({ send })
    await expect(ctl.intercept({ action: 'add', url: '/x', fail: 'Bogus' })).rejects.toThrow(/fail must be/)
    expect(ctl.intercepts.rules(1)).toHaveLength(0)
  })

  it('clear disables Fetch and drops rules', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const { send, calls } = cdpRecorder()
    const ctl = makeController({ send })
    await ctl.intercept({ action: 'add', url: '/api' })
    await ctl.intercept({ action: 'clear' })
    expect(calls.some(c => c.method === 'Fetch.disable')).toBe(true)
    expect(ctl.intercepts.has(1)).toBe(false)
    expect(ctl.events.domainEnabled(1, 'Fetch')).toBe(false)
  })

  it('handleInterceptPaused fulfills a match, continues a non-match, always resolves', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const { send, calls } = cdpRecorder()
    const ctl = makeController({ send })
    await ctl.intercept({ action: 'add', url: '/api/user', status: 201, body: 'X', contentType: 'application/json' })
    calls.length = 0
    await ctl.handleInterceptPaused(1, { requestId: 'r1', request: { url: 'https://x.com/api/user', method: 'GET' } })
    const fulfill = calls.find(c => c.method === 'Fetch.fulfillRequest')
    expect(fulfill?.params.responseCode).toBe(201)
    expect(fulfill?.params.responseHeaders).toContainEqual({ name: 'Content-Type', value: 'application/json' })
    // non-match → continueRequest
    calls.length = 0
    await ctl.handleInterceptPaused(1, { requestId: 'r2', request: { url: 'https://x.com/other', method: 'GET' } })
    expect(calls.find(c => c.method === 'Fetch.continueRequest')?.params.requestId).toBe('r2')
  })

  it('handleInterceptPaused falls back to continue when the chosen verb throws', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const calls: string[] = []
    const send = vi.fn(async (_t: any, method: string) => {
      calls.push(method)
      if (method === 'Fetch.fulfillRequest') throw new Error('request gone')
      if (method === 'Runtime.evaluate') return { result: { value: null } }
      return {}
    })
    const ctl = makeController({ send })
    await ctl.intercept({ action: 'add', url: '/api' })
    await ctl.handleInterceptPaused(1, { requestId: 'r9', request: { url: 'https://x.com/api', method: 'GET' } })
    expect(calls).toContain('Fetch.fulfillRequest')
    expect(calls).toContain('Fetch.continueRequest')   // last-resort resolve
  })
})

describe('controller.reset', () => {
  it('clears cookies/cache/storage/emulation and marks stale', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const calls: string[] = []
    const send = vi.fn(async (_t: any, method: string) => {
      calls.push(method)
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } }
      return {}
    })
    const ctl = makeController({ send })
    const out = await ctl.reset({ tabId: 1 })
    expect(out).toContain('reset')
    expect(calls).toContain('Network.clearBrowserCookies')
    expect(calls).toContain('Network.clearBrowserCache')
    expect(calls).toContain('Storage.clearDataForOrigin')
    expect(calls).toContain('Emulation.clearDeviceMetricsOverride')
    expect(ctl.registry.resolveRef(1, 'e0')).toBeNull()   // stale (no snapshot anyway)
  })

  it('opt-out flags skip their part', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const calls: string[] = []
    const send = vi.fn(async (_t: any, method: string) => { calls.push(method); return method === 'Runtime.evaluate' ? { result: { value: 'ok' } } : {} })
    const ctl = makeController({ send })
    await ctl.reset({ tabId: 1, cookies: false, cache: false, storage: false })
    expect(calls).not.toContain('Network.clearBrowserCookies')
    expect(calls).not.toContain('Storage.clearDataForOrigin')
    expect(calls).toContain('Emulation.clearDeviceMetricsOverride')
  })
})

describe('buildPageSnapshot settleFirst', () => {
  it('settles (browser_wait_stable) before snapshot on non-first turns only', async () => {
    const { buildPageSnapshot } = await import('../../background/page-snapshot')
    const seq: string[] = []
    const exec = async (name: string) => { seq.push(name); return { output: 'body\n\nnodeCount=1 refCount=0', success: true } }
    await buildPageSnapshot(exec, { tabId: 1, settleFirst: true })
    expect(seq).toEqual(['browser_wait_stable', 'browser_snapshot'])
    seq.length = 0
    await buildPageSnapshot(exec, { tabId: 1 })
    expect(seq).toEqual(['browser_snapshot'])
  })
})
