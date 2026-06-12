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

describe('claude buildBody → claude.ai web /completion shape', () => {
  it('posts prompt + root parent uuid on the first turn', () => {
    const b = body('claude', {})
    expect(b.prompt).toBe('hi')
    expect(b.parent_message_uuid).toBe('00000000-0000-4000-8000-000000000000')
    expect(b.rendering_mode).toBe('messages')
    expect(b.attachments).toEqual([])
    // The web endpoint has no public-API fields — sending them 400s.
    expect(b).not.toHaveProperty('messages')
    expect(b).not.toHaveProperty('model')
    expect(b).not.toHaveProperty('thinking')
  })
  it('threads parentId as parent_message_uuid', () => {
    const b = JSON.parse(PLATFORMS.claude.buildBody('hi', 'uuid-123'))
    expect(b.parent_message_uuid).toBe('uuid-123')
  })
})

describe('chatgpt buildBody reasoning → model slug (via chatgpt-proxy, OpenAI shape)', () => {
  it('default uses gpt-5', () => {
    expect(body('chatgpt', {}).model).toBe('gpt-5')
  })
  it('think picks a thinking slug', () => {
    expect(body('chatgpt', { reasoning: 'think' }).model).toBe('gpt-5-thinking')
  })
  it('emits OpenAI-shaped messages, not the legacy parts envelope', () => {
    const b = body('chatgpt', {})
    expect(Array.isArray(b.messages)).toBe(true)
    expect(b.messages[b.messages.length - 1]).toMatchObject({ role: 'user', content: 'hi' })
    expect(b).not.toHaveProperty('action')
  })
})
