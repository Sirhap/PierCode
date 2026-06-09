import { describe, it, expect } from 'vitest'
import { extractToolCalls, runSubAgentBatch } from '../background/chat-api'

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
