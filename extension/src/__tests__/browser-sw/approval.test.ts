import { describe, it, expect, vi } from 'vitest'
import { ApprovalManager } from '../../background/browser/approval'

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
