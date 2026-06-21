/**
 * #18 web_task split + viewport-first guidance.
 *
 * The sub-agent's first message embeds short routing/viewport guidance:
 *  - web_task split: a non-web task is answered directly without driving the
 *    browser (saves a whole round).
 *  - viewport-first: prefer the visible viewport, scroll is a last resort, one
 *    page at a time.
 * This is prompt text woven into buildSubAgentMessage; keep it minimal.
 */
import { describe, it, expect } from 'vitest'
import { buildSubAgentMessage, SUBAGENT_WEB_GUIDANCE } from '../background/chat-api'

describe('#18 web_task / viewport-first sub-agent guidance', () => {
  it('exposes a non-empty guidance block', () => {
    expect(SUBAGENT_WEB_GUIDANCE.length).toBeGreaterThan(0)
  })

  it('mentions web_task routing (answer non-web tasks directly)', () => {
    expect(SUBAGENT_WEB_GUIDANCE).toContain('web_task')
  })

  it('mentions viewport-first + scroll-last + one page at a time', () => {
    const g = SUBAGENT_WEB_GUIDANCE
    expect(g).toMatch(/视口|viewport/)
    expect(g).toMatch(/滚动|scroll/)
    expect(g).toMatch(/一次|一页|one page/)
  })

  it('buildSubAgentMessage includes the guidance, the worker prompt, and the task', () => {
    const msg = buildSubAgentMessage('WORKER PROMPT', 'do the thing')
    expect(msg).toContain('WORKER PROMPT')
    expect(msg).toContain('do the thing')
    expect(msg).toContain(SUBAGENT_WEB_GUIDANCE)
  })
})
