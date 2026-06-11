import { describe, it, expect, beforeEach, vi } from 'vitest'

// continueListenTurn calls broadcast() → chrome.runtime.sendMessage. Stub it
// before importing chat-api so module-eval and the call don't blow up.
const sent: Array<Record<string, unknown>> = []
;(globalThis as any).chrome = {
  runtime: { sendMessage: vi.fn(async (m: Record<string, unknown>) => { sent.push(m); }) },
}

const { isListenPlatform, continueListenTurn } = await import('../background/chat-api')

describe('isListenPlatform', () => {
  it('routes qwen + chatgpt through the listen channel', () => {
    expect(isListenPlatform('qwen')).toBe(true)
    expect(isListenPlatform('chatgpt')).toBe(true)
  })
  it('leaves direct-fetch platforms alone', () => {
    expect(isListenPlatform('claude')).toBe(false)
    expect(isListenPlatform('openai')).toBe(false)
    expect(isListenPlatform('nope')).toBe(false)
  })
})

describe('continueListenTurn', () => {
  beforeEach(() => { sent.length = 0 })

  it('ends the turn with CHAT_DONE when the assistant emitted no tool calls', async () => {
    await continueListenTurn('qwen', 'just prose, no piercode-tool fence here')
    expect(sent.some(m => m.type === 'CHAT_DONE')).toBe(true)
    expect(sent.some(m => m.type === 'CHAT_TOOLS')).toBe(false)
  })
})
