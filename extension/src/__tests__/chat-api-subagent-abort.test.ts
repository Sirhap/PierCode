import { describe, it, expect } from 'vitest'
import { mergedAgentSignal, __agentAbortsForTest } from '../background/chat-api'

describe('mergedAgentSignal', () => {
  it('own abort triggers merged signal and registers in map', () => {
    const { signal, cleanup } = mergedAgentSignal('a1', undefined)
    expect(__agentAbortsForTest().has('a1')).toBe(true)
    expect(signal.aborted).toBe(false)
    __agentAbortsForTest().get('a1')!.abort()
    expect(signal.aborted).toBe(true)
    cleanup()
    expect(__agentAbortsForTest().has('a1')).toBe(false)
  })

  it('outer abort triggers merged signal', () => {
    const outer = new AbortController()
    const { signal, cleanup } = mergedAgentSignal('a2', outer.signal)
    expect(signal.aborted).toBe(false)
    outer.abort()
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('already-aborted outer yields pre-aborted merged signal', () => {
    const outer = new AbortController()
    outer.abort()
    const { signal, cleanup } = mergedAgentSignal('a3', outer.signal)
    expect(signal.aborted).toBe(true)
    cleanup()
    expect(__agentAbortsForTest().has('a3')).toBe(false)
  })

  it('cleanup removes the map entry without aborting', () => {
    const { signal, cleanup } = mergedAgentSignal('a4', undefined)
    cleanup()
    expect(__agentAbortsForTest().has('a4')).toBe(false)
    expect(signal.aborted).toBe(false)
  })
})
