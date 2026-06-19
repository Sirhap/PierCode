import { describe, it, expect, vi } from 'vitest'
import { actionClassFor, runGates, APPROVAL_TOOLS } from '../../background/browser/gates'

describe('gates', () => {
  it('actionClassFor coarsens tool name → class', () => {
    expect(actionClassFor('browser_evaluate')).toBe('evaluate')
    expect(actionClassFor('browser_set_cookie')).toBe('cookie')
    expect(actionClassFor('browser_cookies')).toBe('cookie')
    expect(actionClassFor('browser_clipboard')).toBe('clipboard')
    expect(actionClassFor('browser_upload')).toBe('upload')
    expect(actionClassFor('browser_handle_dialog')).toBe('dialog')
    expect(actionClassFor('browser_click')).toBe('interact')
  })

  it('sensitive page hard-refuses (no approval prompt)', async () => {
    const approval = { ask: vi.fn(async () => {}) } as any
    const security = { isSensitive: () => true } as any
    await expect(runGates({ name: 'browser_click', tab: { tabId: 1, url: 'https://bank.com', title: '' },
      callId: 'c', approval, security })).rejects.toThrow(/sensitive/)
    expect(approval.ask).not.toHaveBeenCalled()
  })

  it('non-sensitive interactive asks approval with the right class', async () => {
    const approval = { ask: vi.fn(async () => {}) } as any
    const security = { isSensitive: () => false } as any
    await runGates({ name: 'browser_evaluate', tab: { tabId: 1, url: 'https://x.com', title: '' },
      callId: 'c', approval, security })
    expect(approval.ask).toHaveBeenCalledOnce()
    expect(approval.ask.mock.calls[0][0].actionClass).toBe('evaluate')
    expect(approval.ask.mock.calls[0][0].host).toBe('x.com')
  })

  it('read tools are not in APPROVAL_TOOLS', () => {
    expect(APPROVAL_TOOLS.has('browser_snapshot')).toBe(false)
    expect(APPROVAL_TOOLS.has('browser_click')).toBe(true)
  })

  it('non-approval interactive (hover handled? no) — scroll not gated, click gated', () => {
    expect(APPROVAL_TOOLS.has('browser_click')).toBe(true)
    // scroll is interactive but the Go side does NOT ask for it → not gated
    expect(APPROVAL_TOOLS.has('browser_scroll')).toBe(false)
  })
})
