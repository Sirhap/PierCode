import { describe, it, expect } from 'vitest'
import { compactSnapshot } from '../../background/browser/snapshot'
import { AX_TREE } from './fixtures/ax-tree'

describe('compactSnapshot', () => {
  it('renders header + indented hierarchy with refs on actionable nodes', () => {
    const r = compactSnapshot(AX_TREE, { tabId: 1, url: 'https://x.com', title: 'Test Page' }, 'snap1', {})
    expect(r.text).toContain('snapshotId=snap1')
    expect(r.text).toContain('url="https://x.com"')
    // RootWebArea is an important role → gets a ref too (e0); button=e1, link=e2
    expect(r.text).toContain('button "Submit"')
    expect(r.text).toContain('link "Home"')
    // link carries href flag from url property
    expect(r.text).toContain('href="https://x.com/home"')
    const refVals = Object.values(r.refs)
    const submit = refVals.find(x => x.name === 'Submit')
    expect(submit?.backendId).toBe(101)
    expect(submit?.ref).toMatch(/^e\d+$/)
  })

  it('refId filter throws when ref absent', () => {
    expect(() => compactSnapshot(AX_TREE, { tabId: 1, url: 'https://x.com', title: 'T' }, 's', { refId: 'e99' }))
      .toThrow(/not found/)
  })

  it('refId filter emits only the matching subtree', () => {
    const all = compactSnapshot(AX_TREE, { tabId: 1, url: 'https://x.com', title: 'T' }, 's', {})
    const submitRef = Object.values(all.refs).find(x => x.name === 'Submit')!.ref
    const filtered = compactSnapshot(AX_TREE, { tabId: 1, url: 'https://x.com', title: 'T' }, 's', { refId: submitRef })
    expect(filtered.text).toContain('button "Submit"')
    expect(filtered.text).not.toContain('link "Home"')
  })

  it('truncates at maxNodes', () => {
    const big: typeof AX_TREE = { nodes: [{ nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'R' }, childIds: [] }] }
    for (let i = 0; i < 50; i++) {
      big.nodes[0].childIds!.push(`b${i}`)
      big.nodes.push({ nodeId: `b${i}`, parentId: 'r', role: { value: 'button' }, name: { value: `B${i}` }, childIds: [] })
    }
    const r = compactSnapshot(big, { tabId: 1, url: 'u', title: 't' }, 's', { maxNodes: 10 })
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('truncated')
  })
})
