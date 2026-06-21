import { describe, it, expect } from 'vitest'
import { TabRegistry } from '../../background/browser/registry'
import type { RefTarget } from '../../background/browser/types'

function ref(r: string): RefTarget {
  return { ref: r, nodeId: '', backendId: 1, role: 'button', name: r, bounds: null, sessionId: '', frameOffset: null }
}

describe('TabRegistry', () => {
  it('storeSnapshot + resolveRef round-trips', () => {
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 's1', { e1: ref('e1') })
    expect(reg.resolveRef(1, 'e1')?.ref).toBe('e1')
    expect(reg.resolveRef(1, 'nope')).toBeNull()
  })
  it('markStale invalidates refs (THE invariant)', () => {
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 's1', { e1: ref('e1') })
    reg.markStale(1)
    expect(reg.resolveRef(1, 'e1')).toBeNull()   // stale → unresolvable
  })
  it('caps snapshots at 3, keeps newest', () => {
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 's1', { a: ref('a') })
    reg.storeSnapshot(1, 's2', { b: ref('b') })
    reg.storeSnapshot(1, 's3', { c: ref('c') })
    reg.storeSnapshot(1, 's4', { d: ref('d') })
    expect(reg.resolveRef(1, 'a')).toBeNull()    // evicted
    expect(reg.resolveRef(1, 'd')?.ref).toBe('d')
  })
  it('setDefault / default / clearDefault', () => {
    const reg = new TabRegistry()
    reg.setDefault({ tabId: 7, url: 'https://x.com', title: 'X' })
    expect(reg.default()).toBe(7)
    reg.clearDefault(7)
    expect(reg.default()).toBeNull()
  })
  it('markApproved / isApproved', () => {
    const reg = new TabRegistry()
    expect(reg.isApproved(3)).toBe(false)
    reg.markApproved(3)
    expect(reg.isApproved(3)).toBe(true)
  })

  it('clearDefault wipes ALL per-tab state (security: a recycled tab id must not stay approved)', () => {
    const reg = new TabRegistry()
    reg.setDefault({ tabId: 9, url: 'https://x.com', title: 'X' })
    reg.markApproved(9)
    reg.storeSnapshot(9, 's', { e0: ref('e0') })
    reg.setMarks(9, [{ index: 1, x: 0, y: 0, w: 1, h: 1, cx: 0, cy: 0, role: 'button', text: 'go', ref: '#go' }])
    reg.setLastPointer(9, { x: 5, y: 5 })
    reg.clearDefault(9)
    // Chrome reuses tab ids; if approved/snapshots leaked, a NEW AI tab reusing id 9 would
    // be silently pre-approved (AI-page gate bypassed) and resolve stale refs.
    expect(reg.isApproved(9)).toBe(false)
    expect(reg.resolveRef(9, 'e0')).toBeNull()
    expect(reg.marks(9)).toBeNull()
    expect(reg.lastPointerOf(9)).toBeNull()
  })
})
