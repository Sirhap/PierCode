import { describe, it, expect } from 'vitest'
import { markCollectorExpr, buildMarkOverlayExpr, buildClearOverlayExpr, parseMarks } from '../../background/browser/marks'

describe('marks', () => {
  it('collector enumerates interactive elements with index/bbox/center', () => {
    const e = markCollectorExpr()
    expect(e).toContain('getBoundingClientRect')
    expect(e).toContain('stableSelector')
    expect(e).toContain('walkDoc')   // iframe/shadow walk
    expect(e).toContain('cx:')       // center emitted
  })
  it('overlay builder injects a closed-shadow SVG host with the marks', () => {
    const e = buildMarkOverlayExpr([{ index: 1, x: 1, y: 2, w: 3, h: 4, cx: 2, cy: 4, role: 'button', text: 'Go', ref: '#go' }])
    expect(e).toContain('__piercode_som__')
    expect(e).toContain('attachShadow')
    expect(e).toContain('"index":1')
  })
  it('clear removes the overlay host', () => {
    expect(buildClearOverlayExpr()).toContain('__piercode_som__')
  })
  it('parseMarks decodes the JSON-string result', () => {
    const m = parseMarks(JSON.stringify([{ index: 1, x: 0, y: 0, w: 1, h: 1, cx: 0, cy: 0, role: 'a', text: 't', ref: '#x' }]))
    expect(m[0].index).toBe(1)
    expect(m[0].cx).toBe(0)
  })
})
