import { describe, it, expect } from 'vitest'
import { extractToolCalls, runSubAgentBatch } from '../background/chat-api'
import { hasApiClient } from '../content/platform-caps'
import { maybeTruncate } from '../content/result-truncate'

describe('extractToolCalls via shared parser', () => {
  it('parses a fence with a trailing comma (repair chain)', () => {
    const content = '```piercode-tool\n{"name":"read_file","args":{"path":"a.txt",}}\n```'
    const calls = extractToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
    expect(calls[0].args).toEqual({ path: 'a.txt' })
  })

  it('parses multiple concatenated objects in one fence', () => {
    const content = '```piercode-tool\n{"name":"a","args":{}}{"name":"b","args":{}}\n```'
    const calls = extractToolCalls(content)
    expect(calls.map(c => c.name)).toEqual(['a', 'b'])
  })
})

describe('runSubAgentBatch', () => {
  it('is exported and returns an array for empty spawns', async () => {
    const out = await runSubAgentBatch([], 'qwen', undefined, 0)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(0)
  })
})

describe('hasApiClient', () => {
  it('true for cookie-session platforms', () => {
    for (const p of ['qwen', 'claude']) expect(hasApiClient(p)).toBe(true)
  })
  it('true for chatgpt (routes through local chatgpt-proxy)', () => {
    // chatgpt: turnstile solved server-side by chatgpt-proxy, exposed as an
    // OpenAI-compatible endpoint; getAuth probes /health and errors if down.
    expect(hasApiClient('chatgpt')).toBe(true)
  })
  it('false for platforms without a usable API client', () => {
    for (const p of ['gemini', 'kimi', 'z', 'mimo']) expect(hasApiClient(p)).toBe(false)
  })
  it('false for unknown platform', () => {
    expect(hasApiClient('unknown')).toBe(false)
  })
})

describe('maybeTruncate', () => {
  it('passes short text through unchanged', () => {
    expect(maybeTruncate('hello')).toBe('hello')
  })
  it('truncates over threshold and appends marker', () => {
    const long = 'x'.repeat(9000)
    const out = maybeTruncate(long)
    expect(out.length).toBeLessThan(9000)
    expect(out).toContain('结果已截断')
  })
})
