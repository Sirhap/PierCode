import { describe, it, expect } from 'vitest'
import {
  REASONING_LEVELS,
  DEFAULT_REASONING,
  levelsForPlatform,
  defaultReasoning,
  isReasoning,
  normalizeReasoning,
  REASONING_STORAGE_KEY,
  type Platform,
} from '../sidebar/reasoning'

describe('reasoning levels', () => {
  it('exposes per-platform level keys', () => {
    expect(REASONING_LEVELS.qwen.map(l => l.key)).toEqual(['off', 'fast', 'think', 'auto'])
    expect(REASONING_LEVELS.openai.map(l => l.key)).toEqual(['off', 'low', 'medium', 'high'])
    expect(REASONING_LEVELS.claude.map(l => l.key)).toEqual(['off', 'think'])
    expect(REASONING_LEVELS.chatgpt.map(l => l.key)).toEqual(['auto', 'think'])
  })

  it('defaults to the first level of each platform', () => {
    for (const p of Object.keys(REASONING_LEVELS) as Platform[]) {
      expect(DEFAULT_REASONING[p]).toBe(REASONING_LEVELS[p][0].key)
    }
  })

  it('qwen defaults to off (keeps no-thinking behaviour); chatgpt to auto', () => {
    expect(DEFAULT_REASONING.qwen).toBe('off')
    expect(DEFAULT_REASONING.chatgpt).toBe('auto')
  })

  it('levelsForPlatform returns [] for unknown platforms', () => {
    expect(levelsForPlatform('nope')).toEqual([])
    expect(defaultReasoning('nope')).toBe('off')
  })

  it('isReasoning is scoped per platform', () => {
    expect(isReasoning('openai', 'high')).toBe(true)
    expect(isReasoning('qwen', 'high')).toBe(false)   // 'high' only exists for openai
    expect(isReasoning('claude', 'think')).toBe(true)
    expect(isReasoning('qwen', 42)).toBe(false)
    expect(isReasoning('qwen', undefined)).toBe(false)
  })

  it('normalizeReasoning falls back to the platform default', () => {
    expect(normalizeReasoning('qwen', 'think')).toBe('think')
    expect(normalizeReasoning('qwen', 'high')).toBe('off')      // invalid for qwen → default
    expect(normalizeReasoning('openai', null)).toBe('off')
    expect(normalizeReasoning('chatgpt', 'bogus')).toBe('auto')
  })

  it('storage key is per platform', () => {
    expect(REASONING_STORAGE_KEY('qwen')).toBe('qwenReasoning')
    expect(REASONING_STORAGE_KEY('openai')).toBe('openaiReasoning')
  })
})
