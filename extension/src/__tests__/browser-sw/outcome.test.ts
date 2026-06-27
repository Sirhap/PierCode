import { describe, it, expect } from 'vitest'
import {
  classifyOutcome, outcomeSnapshotExpr, formatOutcome, type PageSig, type Outcome,
} from '../../background/browser/outcome'

// Build a baseline page signature; spread overrides for the "after" state.
function sig(over: Partial<PageSig> = {}): PageSig {
  return {
    url: 'https://x.com/a', activeTag: 'BODY', activeText: '', dialogCount: 0,
    openMenuCount: 0, domSize: 100, ariaState: '', targetVisible: true,
    newOverlayText: '', ...over,
  }
}

describe('classifyOutcome', () => {
  it('URL change → SUCCESS', () => {
    const r = classifyOutcome(sig(), sig({ url: 'https://x.com/b' }), 'click')
    expect(r.outcome).toBe<Outcome>('SUCCESS')
  })
  it('new dialog → SUCCESS', () => {
    expect(classifyOutcome(sig(), sig({ dialogCount: 1 }), 'click').outcome).toBe('SUCCESS')
  })
  it('new open menu → SUCCESS', () => {
    expect(classifyOutcome(sig(), sig({ openMenuCount: 2 }), 'click').outcome).toBe('SUCCESS')
  })
  it('aria-state change (aria-checked) → SUCCESS', () => {
    const r = classifyOutcome(sig({ ariaState: 'checked=false' }), sig({ ariaState: 'checked=true' }), 'click')
    expect(r.outcome).toBe('SUCCESS')
  })
  it('aria-expanded change → SUCCESS', () => {
    const r = classifyOutcome(sig({ ariaState: 'expanded=false' }), sig({ ariaState: 'expanded=true' }), 'click')
    expect(r.outcome).toBe('SUCCESS')
  })
  it('focus moved into the element → SUCCESS', () => {
    const r = classifyOutcome(sig({ activeTag: 'BODY' }), sig({ activeTag: 'INPUT' }), 'click')
    expect(r.outcome).toBe('SUCCESS')
  })
  it('meaningful DOM-size delta → SUCCESS', () => {
    const r = classifyOutcome(sig({ domSize: 100 }), sig({ domSize: 140 }), 'click')
    expect(r.outcome).toBe('SUCCESS')
  })
  it('nothing changed → SILENT_CLICK', () => {
    const r = classifyOutcome(sig(), sig(), 'click')
    expect(r.outcome).toBe('SILENT_CLICK')
  })
  it('only a tooltip/popover overlay appeared → WRONG_ELEMENT', () => {
    // a small overlay whose only role is tooltip/popover (hover affordance, not a click target)
    const r = classifyOutcome(sig(), sig({ newOverlayText: 'role=tooltip' }), 'click')
    expect(r.outcome).toBe('WRONG_ELEMENT')
  })
  it('cdk-overlay tooltip → WRONG_ELEMENT', () => {
    const r = classifyOutcome(sig(), sig({ newOverlayText: 'cdk-overlay-container mat-tooltip' }), 'click')
    expect(r.outcome).toBe('WRONG_ELEMENT')
  })
  it('a PRE-EXISTING tooltip (unchanged) is NOT WRONG_ELEMENT (audit #13)', () => {
    // The same tooltip overlay is present before AND after — a normal click on a
    // page that already shows a tooltip must not be misjudged as a wrong element
    // (which would otherwise trigger the click waterfall's extra activations).
    const r = classifyOutcome(
      sig({ newOverlayText: 'role=tooltip' }),
      sig({ newOverlayText: 'role=tooltip' }),
      'click',
    )
    expect(r.outcome).toBe('SILENT_CLICK')
  })
  it('a tooltip that CHANGES between before/after is still WRONG_ELEMENT', () => {
    const r = classifyOutcome(
      sig({ newOverlayText: 'role=tooltip old' }),
      sig({ newOverlayText: 'role=tooltip new' }),
      'click',
    )
    expect(r.outcome).toBe('WRONG_ELEMENT')
  })
  it('type that lands text in the focused field → SUCCESS', () => {
    const r = classifyOutcome(sig({ activeTag: 'INPUT', activeText: '' }), sig({ activeTag: 'INPUT', activeText: 'hello' }), 'type')
    expect(r.outcome).toBe('SUCCESS')
  })
  it('type with no value change but focus present → UNKNOWN (not a hard fail)', () => {
    const r = classifyOutcome(sig({ activeTag: 'INPUT' }), sig({ activeTag: 'INPUT' }), 'type')
    expect(r.outcome).toBe('UNKNOWN')
  })
  it('missing before/after signatures → UNKNOWN', () => {
    expect(classifyOutcome(null, sig(), 'click').outcome).toBe('UNKNOWN')
    expect(classifyOutcome(sig(), null, 'click').outcome).toBe('UNKNOWN')
  })
})

describe('formatOutcome', () => {
  it('annotates SUCCESS with a check glyph + reason', () => {
    const s = formatOutcome({ outcome: 'SUCCESS', reason: 'url changed' })
    expect(s).toMatch(/outcome=SUCCESS/)
    expect(s).toContain('url changed')
  })
  it('SILENT_CLICK is flagged so the model can self-correct', () => {
    const s = formatOutcome({ outcome: 'SILENT_CLICK', reason: 'no observable change' })
    expect(s).toMatch(/SILENT_CLICK/)
  })
  it('UNKNOWN renders without a reason tail when reason empty', () => {
    expect(formatOutcome({ outcome: 'UNKNOWN', reason: '' })).toMatch(/outcome=UNKNOWN/)
  })
})

describe('outcomeSnapshotExpr', () => {
  it('builds an IIFE that reads url/activeElement/dialogs/overlays', () => {
    const e = outcomeSnapshotExpr()
    expect(e).toContain('location.href')
    expect(e).toContain('activeElement')
    expect(e).toContain('aria-checked')
    // counts dialog/menu affordances + serializes a compact JSON
    expect(e).toMatch(/dialog|role=/)
    expect(e).toContain('JSON.stringify')
  })
  it('scopes aria-state + targetVisible to a point when x/y given', () => {
    const e = outcomeSnapshotExpr({ x: 12, y: 34 })
    expect(e).toContain('elementFromPoint')
    expect(e).toContain('12')
    expect(e).toContain('34')
  })
})
