import { describe, it, expect } from 'vitest'
import { truncateSummary, buildAgentSummary, type AgentSummaryItem } from '../sidebar/subagent-ui'

describe('truncateSummary', () => {
  it('returns first non-empty line', () => {
    expect(truncateSummary('\n  hello \nworld')).toBe('hello')
  })
  it('truncates long lines to 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80)
    const out = truncateSummary(long)
    expect(out.length).toBe(60)
    expect(out.endsWith('…')).toBe(true)
  })
  it('empty input yields empty string', () => {
    expect(truncateSummary('')).toBe('')
  })
})

describe('buildAgentSummary', () => {
  it('maps done sub-agents into summary items', () => {
    const items: AgentSummaryItem[] = buildAgentSummary([
      { id: 'a', label: 'scanner', task: 't', status: 'done', messages: [{ role: 'assistant', content: 'found 4 issues' }] as any },
      { id: 'b', label: 'fixer', task: 't', status: 'error', messages: [{ role: 'assistant', content: 'boom' }] as any },
    ] as any)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ label: 'scanner', status: 'done', summary: 'found 4 issues' })
    expect(items[1]).toMatchObject({ label: 'fixer', status: 'error' })
    expect(items[0].output).toContain('found 4 issues')
  })
})
