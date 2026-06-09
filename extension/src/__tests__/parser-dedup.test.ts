import { describe, it, expect } from 'vitest'
import { formatToolResults } from '../parser'

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
