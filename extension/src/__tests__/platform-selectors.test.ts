import { describe, it, expect } from 'vitest'
import { PLATFORM_SELECTORS, selectorsForHost } from '../content/platform-selectors'

describe('platform selectors config', () => {
  it('has entries for every supported platform', () => {
    for (const key of ['kimi', 'chatz', 'claude', 'chatgpt', 'gemini', 'qwen', 'mimo', 'aistudio']) {
      expect(PLATFORM_SELECTORS[key]).toBeDefined()
      expect(PLATFORM_SELECTORS[key].editor).toBeTruthy()
    }
  })
  it('resolves host to the right platform config', () => {
    expect(selectorsForHost('chat.qwen.ai')).toBe(PLATFORM_SELECTORS.qwen)
    expect(selectorsForHost('gemini.google.com')).toBe(PLATFORM_SELECTORS.gemini)
    expect(selectorsForHost('claude.ai')).toBe(PLATFORM_SELECTORS.claude)
    expect(selectorsForHost('chatgpt.com')).toBe(PLATFORM_SELECTORS.chatgpt)
  })
})
