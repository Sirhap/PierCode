import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApprovalManager } from '../../background/browser/approval'

const tick = () => new Promise(r => setTimeout(r, 0))

describe('ApprovalManager', () => {
  it('grant short-circuits the prompt', async () => {
    const send = vi.fn()
    const m = new ApprovalManager(send)
    m.recordGrant('x.com', 'interact')
    await expect(m.ask({ host: 'x.com', actionClass: 'interact', action: 'click', callId: 'c1' })).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
  it('approve resolves; "session" scope records grant', async () => {
    const send = vi.fn()
    const m = new ApprovalManager(send)
    const p = m.ask({ host: 'x.com', actionClass: 'interact', action: 'click', callId: 'c2' })
    const askMsg = send.mock.calls[0][0]
    expect(askMsg.type).toBe('BROWSER_APPROVAL_ASK')
    m.deliver({ approvalId: askMsg.approvalId, approved: true, scope: 'session' })
    await expect(p).resolves.toBeUndefined()
    send.mockClear()
    await m.ask({ host: 'x.com', actionClass: 'interact', action: 'click', callId: 'c3' })
    expect(send).not.toHaveBeenCalled()
  })
  it('originTabId is forwarded to send (targeted, not broadcast)', async () => {
    const send = vi.fn()
    const m = new ApprovalManager(send)
    void m.ask({ host: 'x.com', actionClass: 'interact', action: 'click', callId: 'c', originTabId: 77 })
    // send(msg, originTabId) — second arg carries the target tab
    expect(send.mock.calls[0][1]).toBe(77)
  })

  it('reject throws with reason', async () => {
    const send = vi.fn()
    const m = new ApprovalManager(send)
    const p = m.ask({ host: 'x.com', actionClass: 'evaluate', action: 'evaluate', callId: 'c4' })
    const askMsg = send.mock.calls[0][0]
    m.deliver({ approvalId: askMsg.approvalId, approved: false, reason: 'nope' })
    await expect(p).rejects.toThrow('nope')
  })
  it('times out → rejects', async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const m = new ApprovalManager(send, 1000)
    const p = m.ask({ host: 'x.com', actionClass: 'interact', action: 'click', callId: 'c5' })
    const expectation = expect(p).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(1001)
    await expectation
    vi.useRealTimers()
  })
})

// S7: grants must survive a service-worker restart (they lived only in memory
// before, so a ~30s idle SW recycle re-prompted "本站点始终允许"). Persisted to
// chrome.storage.session; a fresh manager rehydrates on construction.
describe('ApprovalManager grant persistence (SW-restart survival)', () => {
  let sessionData: Record<string, any>
  beforeEach(() => {
    sessionData = {}
    ;(globalThis as any).chrome = {
      storage: {
        session: {
          get: async (key: string) => (key in sessionData ? { [key]: sessionData[key] } : {}),
          set: async (obj: Record<string, any>) => {
            for (const [k, v] of Object.entries(obj)) sessionData[k] = JSON.parse(JSON.stringify(v))
          },
        },
      },
    }
  })
  afterEach(() => { delete (globalThis as any).chrome })

  const KEY = 'piercode_browser_grants'

  it('recordGrant writes the grant to storage.session', async () => {
    const m = new ApprovalManager(vi.fn())
    m.recordGrant('example.com', 'interact')
    await tick()
    expect(sessionData[KEY]).toContain('example.com\x00interact')
  })

  it('a fresh manager rehydrates grants from storage.session', async () => {
    sessionData[KEY] = ['example.com\x00interact']
    const m = new ApprovalManager(vi.fn())
    await tick() // let the constructor's hydrate() resolve
    expect(m.hasGrant('example.com', 'interact')).toBe(true)
    expect(m.hasGrant('other.com', 'interact')).toBe(false)
  })

  it('a rehydrated grant short-circuits ask() with no prompt sent', async () => {
    sessionData[KEY] = ['example.com\x00interact']
    const send = vi.fn()
    const m = new ApprovalManager(send)
    await tick()
    await expect(
      m.ask({ host: 'example.com', actionClass: 'interact', action: 'click', callId: 'c' }),
    ).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })
})
