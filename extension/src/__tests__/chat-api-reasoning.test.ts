import { describe, it, expect } from 'vitest'
import { PLATFORMS } from '../background/chat-api'

// buildBody returns a JSON string; parse it to assert on the request shape.
function body(platform: string, ctx?: Record<string, unknown>) {
  return JSON.parse(PLATFORMS[platform].buildBody('hi', null, ctx as never))
}

describe('qwen buildBody reasoning → feature_config', () => {
  const fc = (reasoning?: string) => body('qwen', { reasoning }).messages[0].feature_config

  it('off (and default) disables thinking', () => {
    for (const r of [undefined, 'off']) {
      expect(fc(r)).toMatchObject({ thinking_enabled: false, auto_thinking: false, thinking_mode: 'Fast' })
    }
  })

  it('fast enables thinking in Fast mode', () => {
    expect(fc('fast')).toMatchObject({ thinking_enabled: true, auto_thinking: false, thinking_mode: 'Fast' })
  })

  it('think enables Thinking mode', () => {
    expect(fc('think')).toMatchObject({ thinking_enabled: true, auto_thinking: false, thinking_mode: 'Thinking' })
  })

  it('auto enables auto_thinking', () => {
    expect(fc('auto')).toMatchObject({ thinking_enabled: true, auto_thinking: true })
  })
})

describe('openai buildBody reasoning → reasoning_effort', () => {
  it('omits reasoning_effort when off/undefined', () => {
    expect(body('openai', {})).not.toHaveProperty('reasoning_effort')
    expect(body('openai', { reasoning: 'off' })).not.toHaveProperty('reasoning_effort')
  })

  it('sends low/medium/high verbatim', () => {
    expect(body('openai', { reasoning: 'low' }).reasoning_effort).toBe('low')
    expect(body('openai', { reasoning: 'medium' }).reasoning_effort).toBe('medium')
    expect(body('openai', { reasoning: 'high' }).reasoning_effort).toBe('high')
  })
})

describe('claude buildBody reasoning → thinking (unverified web protocol)', () => {
  it('omits thinking when off', () => {
    expect(body('claude', { reasoning: 'off' })).not.toHaveProperty('thinking')
  })
  it('enables extended thinking when think', () => {
    expect(body('claude', { reasoning: 'think' }).thinking).toMatchObject({ type: 'enabled' })
  })
})

describe('chatgpt buildBody reasoning → model slug (send path unverified)', () => {
  it('auto/default uses the auto-routing model', () => {
    expect(body('chatgpt', {}).model).toBe('auto')
    expect(body('chatgpt', { reasoning: 'auto' }).model).toBe('auto')
  })
  it('think picks a thinking slug', () => {
    expect(body('chatgpt', { reasoning: 'think' }).model).toBe('gpt-5-5-thinking')
  })
})
