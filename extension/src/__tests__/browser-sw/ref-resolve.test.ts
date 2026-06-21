import { describe, it, expect, vi } from 'vitest'
import { boxModelCenter, resolvePointFromXY, boxModelBounds, resolvePoint, parseSimpleSelector, resolveClosedShadow } from '../../background/browser/ref-resolve'
import { TabRegistry } from '../../background/browser/registry'

describe('ref-resolve', () => {
  it('boxModelCenter: averages the content quad', () => {
    const center = boxModelCenter({ content: [10, 20, 30, 20, 30, 40, 10, 40] })
    expect(center).toEqual({ x: 20, y: 30 })
  })
  it('resolvePointFromXY: passes through explicit coords', async () => {
    const p = await resolvePointFromXY({ x: 5, y: 7 })
    expect(p).toEqual({ x: 5, y: 7 })
  })
  it('boxModelBounds: min/extent from quad', async () => {
    const cdp = { sendCommand: vi.fn(async () => ({ model: { content: [0, 0, 10, 0, 10, 20, 0, 20] } })),
      runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    const b = await boxModelBounds(cdp as any, { tabId: 1 }, 99)
    expect(b).toEqual({ x: 0, y: 0, width: 10, height: 20 })
  })
  it('resolvePoint xy fast-path skips CDP', async () => {
    const cdp = { sendCommand: vi.fn(), runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    const r = await resolvePoint(cdp as any, new TabRegistry(), { tabId: 1 }, { tabId: 1, x: 3, y: 4 })
    expect(r.point).toEqual({ x: 3, y: 4 })
    expect(cdp.sendCommand).not.toHaveBeenCalled()
  })
  it('resolvePoint resolves a ref THROUGH its stable backendId, not the ref name (#7 part 1)', async () => {
    // The SAME backend node (101) appears under different ref NAMES across two snapshots
    // (e0 then e5 — names drift, backendId is stable). Both must box-model the same node
    // → identical point. Asserts addressing is keyed on backendNodeId.
    const reg = new TabRegistry()
    const sent: number[] = []
    const cdp = {
      sendCommand: vi.fn(async (_t: any, _d: string, _m: string, p: any) => { sent.push(p.backendNodeId); return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } }),
      runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn(),
    }
    reg.storeSnapshot(1, 's1', { e0: { ref: 'e0', nodeId: 'ax-9', backendId: 101, role: 'button', name: 'Go', bounds: null, sessionId: '', frameOffset: null } })
    const a = await resolvePoint(cdp as any, reg, { tabId: 1 }, { tabId: 1, ref: 'e0' })
    reg.markStale(1)   // a fresh snapshot supersedes — same node, new name
    reg.storeSnapshot(1, 's2', { e5: { ref: 'e5', nodeId: 'ax-77', backendId: 101, role: 'button', name: 'Go', bounds: null, sessionId: '', frameOffset: null } })
    const b = await resolvePoint(cdp as any, reg, { tabId: 1 }, { tabId: 1, ref: 'e5' })
    expect(a.point).toEqual(b.point)             // same element, same address
    expect(sent).toEqual([101, 101])             // both resolved through backendNodeId 101
  })
  it('resolvePoint ref → boxModelBounds center (+ frameOffset)', async () => {
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 's', { e1: { ref: 'e1', nodeId: '', backendId: 50, role: 'button', name: 'x',
      bounds: null, sessionId: '', frameOffset: { x: 100, y: 0, width: 0, height: 0 } } })
    const cdp = { sendCommand: vi.fn(async () => ({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } })),
      runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    const r = await resolvePoint(cdp as any, reg, { tabId: 1 }, { tabId: 1, ref: 'e1' })
    // center of 10x10 box = (5,5), plus frameOffset.x=100 → (105,5)
    expect(r.point).toEqual({ x: 105, y: 5 })
  })
  it('resolvePoint throws on stale ref', async () => {
    const reg = new TabRegistry()
    reg.storeSnapshot(1, 's', { e1: { ref: 'e1', nodeId: '', backendId: 1, role: 'b', name: 'x',
      bounds: null, sessionId: '', frameOffset: null } })
    reg.markStale(1)
    const cdp = { sendCommand: vi.fn(), runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    await expect(resolvePoint(cdp as any, reg, { tabId: 1 }, { tabId: 1, ref: 'e1' })).rejects.toThrow(/stale/)
  })
})

// Item #6: closed shadow root piercing via CDP DOM.getDocument({pierce:true}).
describe('parseSimpleSelector', () => {
  it('parses tag, #id, tag#id, [attr=value], and tag[attr]', () => {
    expect(parseSimpleSelector('button')).toEqual({ tag: 'button' })
    expect(parseSimpleSelector('#go')).toEqual({ attrs: { id: 'go' } })
    expect(parseSimpleSelector('input#name')).toEqual({ tag: 'input', attrs: { id: 'name' } })
    expect(parseSimpleSelector('[data-x=1]')).toEqual({ attrs: { 'data-x': '1' } })
    expect(parseSimpleSelector('button[aria-label="Save"]')).toEqual({ tag: 'button', attrs: { 'aria-label': 'Save' } })
    expect(parseSimpleSelector('a[href][rel=next]')).toEqual({ tag: 'a', attrs: { href: '', rel: 'next' } })
  })
  it('rejects selectors needing a real CSS engine (combinators / class / pseudo)', () => {
    expect(parseSimpleSelector('.btn')).toBeNull()
    expect(parseSimpleSelector('div > button')).toBeNull()
    expect(parseSimpleSelector('a:hover')).toBeNull()
    expect(parseSimpleSelector('div span')).toBeNull()
    expect(parseSimpleSelector('')).toBeNull()
  })
})

describe('resolveClosedShadow', () => {
  // A pierced document: host element with a CLOSED shadowRoot containing the target button.
  const PIERCED_DOC = {
    root: {
      nodeType: 9, nodeName: '#document', backendNodeId: 1,
      children: [{
        nodeType: 1, nodeName: 'HTML', backendNodeId: 2,
        children: [{
          nodeType: 1, nodeName: 'BODY', backendNodeId: 3,
          children: [{
            nodeType: 1, nodeName: 'MY-WIDGET', backendNodeId: 10,
            // closed shadow root — invisible to page-context querySelector
            shadowRoots: [{
              nodeType: 11, nodeName: '#document-fragment', backendNodeId: 11,
              children: [{ nodeType: 1, nodeName: 'BUTTON', backendNodeId: 42, attributes: ['class', 'go', 'data-id', 'submit'] }],
            }],
          }],
        }],
      }],
    },
  }

  it('walks the pierced tree (incl. closed shadowRoots) and returns the backendNodeId', async () => {
    const cdp = { sendCommand: vi.fn(async () => PIERCED_DOC), runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    const id = await resolveClosedShadow(cdp as any, { tabId: 1 }, { tag: 'button', attrs: { 'data-id': 'submit' } })
    expect(id).toBe(42)
    expect(cdp.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'DOM', 'getDocument', { depth: -1, pierce: true })
  })

  it('returns null when nothing in the pierced tree matches', async () => {
    const cdp = { sendCommand: vi.fn(async () => PIERCED_DOC), runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn() }
    const id = await resolveClosedShadow(cdp as any, { tabId: 1 }, { tag: 'input' })
    expect(id).toBeNull()
  })

  it('resolvePoint falls back to the pierce path when querySelector misses a closed-shadow selector', async () => {
    // runtimeEvaluate (querySelector) returns null → selector "not found" in light DOM;
    // pierce then locates the BUTTON inside the closed root → box-model → center point.
    const cdp = {
      runtimeEvaluate: vi.fn(async () => null),                     // querySelector miss
      sendCommand: vi.fn(async (_t: any, domain: string, method: string) => {
        if (domain === 'DOM' && method === 'getDocument') return PIERCED_DOC
        if (domain === 'DOM' && method === 'getBoxModel') return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } }
        return {}
      }),
      callFunctionOnObject: vi.fn(),
    }
    const r = await resolvePoint(cdp as any, new TabRegistry(), { tabId: 1 }, { tabId: 1, selector: 'button[data-id=submit]' })
    expect(r.point).toEqual({ x: 10, y: 5 })   // center of the 20x10 box
  })

  it('resolvePoint still throws when the pierce path also finds nothing', async () => {
    const cdp = {
      runtimeEvaluate: vi.fn(async () => null),
      sendCommand: vi.fn(async () => PIERCED_DOC),     // getDocument returns the tree, no <input> in it
      callFunctionOnObject: vi.fn(),
    }
    await expect(resolvePoint(cdp as any, new TabRegistry(), { tabId: 1 }, { tabId: 1, selector: 'input#missing' }))
      .rejects.toThrow(/not found/)
  })
})
