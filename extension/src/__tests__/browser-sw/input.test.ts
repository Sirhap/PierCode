import { describe, it, expect, vi } from 'vitest'
import { Input, parseKeyChord, lerpPoints, DEFAULT_FIDELITY } from '../../background/browser/input'

const noSleep = async () => {}
function mockCdp() {
  const calls: Array<{ method: string; params: any }> = []
  const cdp = {
    sendCommand: vi.fn(async (_t: any, domain: string, method: string, params: any) => { calls.push({ method: `${domain}.${method}`, params }); return {} }),
    runtimeEvaluate: vi.fn(), callFunctionOnObject: vi.fn(),
  }
  return { cdp, calls }
}

describe('input dispatch', () => {
  it('lerpPoints: N interpolated points ending at target', () => {
    const pts = lerpPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)
    expect(pts.length).toBe(5)
    expect(pts[4]).toEqual({ x: 100, y: 0 })
  })

  it('dispatchClick: move(s) → mousePressed → mouseReleased', async () => {
    const { cdp, calls } = mockCdp()
    const input = new Input(cdp as any, { sleep: noSleep })
    await input.dispatchClick({ tabId: 1 }, 1, 10, 20, 'left')
    const types = calls.map(c => c.params.type)
    expect(types.filter(t => t === 'mouseMoved').length).toBe(DEFAULT_FIDELITY.moveSteps)
    expect(types).toContain('mousePressed')
    expect(types[types.length - 1]).toBe('mouseReleased')
    // left button → buttons bit 1 on press
    const press = calls.find(c => c.params.type === 'mousePressed')!
    expect(press.params.buttons).toBe(1)
  })

  it('dispatchTypedKeys: ASCII keyDown(text) + keyUp; CJK insertText', async () => {
    const { cdp, calls } = mockCdp()
    const input = new Input(cdp as any, { sleep: noSleep })
    await input.dispatchTypedKeys({ tabId: 1 }, 'a你')
    const downA = calls.find(c => c.params.type === 'keyDown' && c.params.text === 'a')
    expect(downA?.params.unmodifiedText).toBe('a')
    const insert = calls.find(c => c.method === 'Input.insertText')
    expect(insert?.params.text).toBe('你')
  })

  it('newline → Enter named key', async () => {
    const { cdp, calls } = mockCdp()
    const input = new Input(cdp as any, { sleep: noSleep })
    await input.dispatchTypedKeys({ tabId: 1 }, '\n')
    expect(calls.find(c => c.params.type === 'keyDown')?.params.key).toBe('Enter')
  })

  it('parseKeyChord: canonicalizes modifiers + key', () => {
    expect(parseKeyChord('Ctrl+a')).toEqual({ mods: ['Ctrl'], key: 'a' })
    expect(parseKeyChord('cmd+shift+k')).toEqual({ mods: ['Meta', 'Shift'], key: 'k' })
  })

  it('sendKeyChordMods: mods down → key down/up → mods up (reverse) with mask', async () => {
    const { cdp, calls } = mockCdp()
    const input = new Input(cdp as any, { sleep: noSleep })
    await input.sendKeyChordMods({ tabId: 1 }, ['Ctrl'], 'a')
    // Ctrl=2 mask present on all events
    expect(calls.every(c => c.params.modifiers === 2)).toBe(true)
    const seq = calls.map(c => `${c.params.type}:${c.params.key}`)
    expect(seq).toEqual(['keyDown:Ctrl', 'keyDown:a', 'keyUp:a', 'keyUp:Ctrl'])
  })
})
