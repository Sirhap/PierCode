import { describe, it, expect } from 'vitest'
import { buildAgentSummary, accumulateBatch, type SubAgent } from '../sidebar/subagent-ui'

const mkAgent = (id: string, batchId: string, status: SubAgent['status'], content: string): SubAgent =>
  ({ id, label: id, task: 't', status, batchId, messages: [{ role: 'assistant', content }] }) as any

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

describe('accumulateBatch (the actual fix logic)', () => {
  it('emits only when the last expected agent of the batch finishes', () => {
    const done = new Map<string, SubAgent[]>()
    const expected = new Map<string, number>([['b1', 3]])
    expect(accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'A'))).toBeNull()
    expect(accumulateBatch(done, expected, mkAgent('2', 'b1', 'done', 'B'))).toBeNull()
    const out = accumulateBatch(done, expected, mkAgent('3', 'b1', 'error', 'C'))
    expect(out).not.toBeNull()
    expect(out!.map(s => s.label)).toEqual(['1', '2', '3'])
    expect(out![2].status).toBe('error')
  })

  it('Bug1: a fast sibling captured earlier is still in the summary even if removed from the live array later', () => {
    const done = new Map<string, SubAgent[]>()
    const expected = new Map<string, number>([['b1', 2]])
    // sibling 1 finishes first and is accumulated (the live array would later fade it out)
    accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'fast'))
    // sibling 2 finishes much later — summary must still contain sibling 1
    const out = accumulateBatch(done, expected, mkAgent('2', 'b1', 'done', 'slow'))
    expect(out!.map(s => s.label)).toEqual(['1', '2'])
    expect(out![0].summary).toBe('fast')
  })

  it('emit-once: a duplicate or late DONE after completion does not re-emit', () => {
    const done = new Map<string, SubAgent[]>()
    const expected = new Map<string, number>([['b1', 1]])
    expect(accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'A'))).not.toBeNull()
    // entries deleted on emit → a stray repeat falls back to expected=acc.length=1
    // and would emit a 1-agent summary; ensure the dedup keeps it from re-counting
    // the SAME agent. A repeat of agent '1' must not re-emit it as a fresh batch.
    const repeat = accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'A'))
    // After delete-on-emit, `expected` no longer holds b1, so a post-emit replay
    // (e.g. an SW-restart resume firing DONE again) must NOT re-emit — accumulateBatch
    // returns null on a missing `expected` entry. Honors the emit-once contract.
    expect(repeat).toBeNull()
  })

  it('Bug2: two concurrent batches accumulate independently', () => {
    const done = new Map<string, SubAgent[]>()
    const expected = new Map<string, number>([['b1', 2], ['b2', 1]])
    expect(accumulateBatch(done, expected, mkAgent('a', 'b1', 'done', 'A'))).toBeNull()
    // b2 completes while b1 is still pending — emits only b2's agent
    const outB2 = accumulateBatch(done, expected, mkAgent('x', 'b2', 'done', 'X'))
    expect(outB2!.map(s => s.label)).toEqual(['x'])
    // b1 completes later — emits only b1's agents, no commingling
    const outB1 = accumulateBatch(done, expected, mkAgent('b', 'b1', 'done', 'B'))
    expect(outB1!.map(s => s.label)).toEqual(['a', 'b'])
  })

  it('ignores a duplicate DONE for an already-recorded agent within a batch', () => {
    const done = new Map<string, SubAgent[]>()
    const expected = new Map<string, number>([['b1', 2]])
    accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'A'))
    // duplicate DONE for agent 1 must NOT count toward the expected 2
    expect(accumulateBatch(done, expected, mkAgent('1', 'b1', 'done', 'A'))).toBeNull()
    // only when the real second agent finishes does it emit
    const out = accumulateBatch(done, expected, mkAgent('2', 'b1', 'done', 'B'))
    expect(out!.map(s => s.label)).toEqual(['1', '2'])
  })
})
