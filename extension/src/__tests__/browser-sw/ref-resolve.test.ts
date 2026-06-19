import { describe, it, expect, vi } from 'vitest'
import { boxModelCenter, resolvePointFromXY, boxModelBounds, resolvePoint } from '../../background/browser/ref-resolve'
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
