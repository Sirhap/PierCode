import { describe, it, expect } from 'vitest'
import { extractToolCalls } from '../background/chat-api'

describe('extractToolCalls (sidebar tool detection)', () => {
  it('parses a single well-formed fenced tool call', () => {
    const c = '```piercode-tool\n{"name":"read_file","call_id":"a1","args":{"path":"X.md"}}\n```'
    const calls = extractToolCalls(c)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'read_file', call_id: 'a1', args: { path: 'X.md' } })
  })

  it('parses MULTIPLE concatenated objects in one fence (the reported bug)', () => {
    // Model packed 4 tool objects into one fence with no separators + no newline
    // after the tag — a single JSON.parse rejects this; brace-split must recover all.
    const c = '```piercode-tool{"name":"read_file","call_id":"bR7","args":{"path":"BUG_REPORT.md"}}{"name":"list_dir","call_id":"nT4","args":{"path":"internal"}}{"name":"list_dir","call_id":"jY6","args":{"path":"cmd"}}{"name":"grep","call_id":"mX9","args":{"path":".","pattern":"TODO|FIXME"}}```'
    const calls = extractToolCalls(c)
    expect(calls).toHaveLength(4)
    expect(calls.map(t => t.name)).toEqual(['read_file', 'list_dir', 'list_dir', 'grep'])
    expect(calls[3].args).toMatchObject({ path: '.', pattern: 'TODO|FIXME' })
  })

  it('tolerates a missing newline after the piercode-tool tag', () => {
    const c = '```piercode-tool{"name":"glob","call_id":"g1","args":{"pattern":"*.go"}}```'
    const calls = extractToolCalls(c)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('glob')
  })

  it('does not treat a nested-brace string value as an object boundary', () => {
    const c = '```piercode-tool\n{"name":"exec_cmd","call_id":"e1","args":{"command":"echo {hi}"}}\n```'
    const calls = extractToolCalls(c)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toMatchObject({ command: 'echo {hi}' })
  })

  it('returns empty for prose with no fence', () => {
    expect(extractToolCalls('just some analysis text, no tools here')).toEqual([])
  })

  it('skips an invalid JSON segment but keeps valid siblings', () => {
    const c = '```piercode-tool{"name":"read_file","call_id":"ok","args":{}}{not valid}```'
    const calls = extractToolCalls(c)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
  })
})
