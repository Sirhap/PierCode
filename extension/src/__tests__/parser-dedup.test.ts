import { describe, it, expect } from 'vitest'
import { formatToolResults, toolDedupHash, stableStringify, parseJsonFenceToolCall } from '../parser'

describe('toolDedupHash', () => {
  it('is stable across object key insertion order (render-independent)', () => {
    const a = { name: 'write_file', args: { path: 'a.txt', content: 'x' } }
    const b = { name: 'write_file', args: { content: 'x', path: 'a.txt' } }
    expect(toolDedupHash(a)).toBe(toolDedupHash(b))
  })

  it('survives the Qwen Monaco re-render: parsed semantics ignore whitespace/format drift', () => {
    // Same tool call, but the rendered fence text differs after refresh (Monaco
    // virtualization changes whitespace / line wrapping). Parsing normalizes it,
    // so the dedup hash must NOT drift between the two extractions.
    const liveText = '{"name":"exec_cmd","args":{"command":"go test ./..."}}'
    const refreshedText = '{\n  "name": "exec_cmd",\n  "args": { "command": "go test ./..." }\n}'
    const live = parseJsonFenceToolCall(liveText)
    const refreshed = parseJsonFenceToolCall(refreshedText)
    expect(toolDedupHash(live)).toBe(toolDedupHash(refreshed))
  })

  it('differs when name or args differ', () => {
    const base = { name: 'read_file', args: { path: 'a.txt' } }
    expect(toolDedupHash(base)).not.toBe(toolDedupHash({ name: 'read_file', args: { path: 'b.txt' } }))
    expect(toolDedupHash(base)).not.toBe(toolDedupHash({ name: 'list_dir', args: { path: 'a.txt' } }))
  })

  it('falls back to `arguments` when `args` is absent', () => {
    expect(toolDedupHash({ name: 'x', arguments: { a: 1 } }))
      .toBe(toolDedupHash({ name: 'x', args: { a: 1 } }))
  })

  it('treats missing args as empty object', () => {
    expect(toolDedupHash({ name: 'x' })).toBe(toolDedupHash({ name: 'x', args: {} }))
  })
})

describe('stableStringify', () => {
  it('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles primitives and null', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify('x')).toBe('"x"')
    expect(stableStringify(42)).toBe('42')
  })
})

describe('formatToolResults', () => {
  it('formats results as ### name #call_id blocks joined by blank lines', () => {
    const out = formatToolResults([
      { name: 'read_file', call_id: 'c1', output: 'hello' },
      { name: 'list_dir', call_id: 'c2', output: 'a\nb' },
    ])
    expect(out).toBe('### read_file #c1\n\nhello\n\n### list_dir #c2\n\na\nb')
  })

  it('handles empty results', () => {
    expect(formatToolResults([])).toBe('')
  })
})
