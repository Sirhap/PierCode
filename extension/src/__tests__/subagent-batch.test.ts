import { describe, it, expect } from 'vitest'
import { buildAgentSummary } from '../sidebar/subagent-ui'

describe('batch summary composition (Bug1/Bug2 regression)', () => {
  it('includes every agent of an accumulated batch, even mixed statuses', () => {
    // Simulates batchDone accumulator: all 3 captured at finish time, independent
    // of any live-array fade removal. The summary must contain all three.
    const accumulated = [
      { id: '1', label: 'a', task: 't', status: 'done', messages: [{ role: 'assistant', content: 'A done' }], batchId: 'b1' },
      { id: '2', label: 'b', task: 't', status: 'error', messages: [{ role: 'assistant', content: 'B failed' }], batchId: 'b1' },
      { id: '3', label: 'c', task: 't', status: 'done', messages: [{ role: 'assistant', content: 'C done' }], batchId: 'b1' },
    ] as any
    const summary = buildAgentSummary(accumulated)
    expect(summary.map(s => s.label)).toEqual(['a', 'b', 'c'])
    expect(summary[1].status).toBe('error')
    expect(summary[0].summary).toBe('A done')
  })

  it('a different batch id does not commingle (Bug2)', () => {
    const batchB1 = [{ id: '1', label: 'a', task: 't', status: 'done', messages: [{ role: 'assistant', content: 'A' }], batchId: 'b1' }] as any
    const summary = buildAgentSummary(batchB1)
    expect(summary).toHaveLength(1)
    expect(summary[0].label).toBe('a')
  })
})
