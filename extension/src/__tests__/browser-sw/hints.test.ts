import { describe, it, expect } from 'vitest'
import { HintEngine, DEFAULT_RULES, type HintCtx } from '../../background/browser/hints'

// Item #4: the deterministic hint rule chain. Each rule fires on its trigger pattern and
// is one-shot per session (fireCounts dedup); rules run priority-desc.

// Build a ctx without fireCounts (the engine owns that Map).
const ctx = (over: Partial<Omit<HintCtx, 'fireCounts'>> = {}) => ({
  toolName: 'browser_click', resultText: '', isError: false, ...over,
})

describe('hint rules — each fires on its trigger', () => {
  it('blocking-page fires on overlay/modal/cookie/intercepted', () => {
    const e = new HintEngine()
    expect(e.apply(ctx({ resultText: 'click intercepted by an overlay' }))).toMatch(/overlay\/modal\/cookie banner/i)
    const e2 = new HintEngine()
    expect(e2.apply(ctx({ resultText: 'a cookie consent banner is showing' }))).toMatch(/cookie/i)
  })

  it('error-recovery fires when isError is true', () => {
    const e = new HintEngine()
    const out = e.apply(ctx({ resultText: 'boom', isError: true }))
    expect(out).toMatch(/fresh browser_snapshot/i)
  })

  it('snapshot-stale fires on "ref ... stale" / "not found" / "no element"', () => {
    const e = new HintEngine()
    expect(e.apply(ctx({ resultText: 'ref e3 is stale or unknown; take a fresh browser_snapshot' }))).toMatch(/stale/i)
    const e2 = new HintEngine()
    expect(e2.apply(ctx({ resultText: 'no element matched' }))).toMatch(/stale|snapshot/i)
  })

  it('pagination-detection fires on next/load more', () => {
    const e = new HintEngine()
    expect(e.apply(ctx({ resultText: 'found a "Load more" button' }))).toMatch(/paginated|next|load more/i)
  })

  it('repetition-detection fires after the same tool runs 5+ times', () => {
    const e = new HintEngine()
    let out = ''
    for (let i = 0; i < 5; i++) out = e.apply(ctx({ toolName: 'browser_scroll', resultText: 'scrolled' }))
    expect(out).toMatch(/has run 5\+ times|change strategy/i)
  })

  it('console-buffer-pressure fires on 5+ console error/warn lines', () => {
    const e = new HintEngine()
    const log = ['[error] a', '[error] b', '[warn] c', '[error] d', '[warning] e'].join('\n')
    expect(e.apply(ctx({ toolName: 'browser_console', resultText: log }))).toMatch(/console errors|browser_reload/i)
  })

  it('success-hints fires on SILENT_CLICK / WRONG_ELEMENT outcome', () => {
    const e = new HintEngine()
    expect(e.apply(ctx({ resultText: 'clicked at 5,5\n[⚠ outcome=SILENT_CLICK] (no observable change)' }))).toMatch(/no observable effect|wrong element/i)
    const e2 = new HintEngine()
    expect(e2.apply(ctx({ resultText: '[✗ outcome=WRONG_ELEMENT] (only a tooltip)' }))).toMatch(/verify the target|wrong element/i)
  })
})

describe('one-shot dedup (fireCounts)', () => {
  it('a rule fires its hint at most once per session', () => {
    const e = new HintEngine()
    const first = e.apply(ctx({ resultText: 'click intercepted by overlay' }))
    expect(first).toMatch(/overlay/i)
    const second = e.apply(ctx({ resultText: 'click intercepted by overlay' }))   // same trigger again
    expect(second).not.toMatch(/overlay/i)                                          // already fired → suppressed
  })

  it('independent rules each fire once even when triggered together', () => {
    const e = new HintEngine()
    // isError (error-recovery) + stale text (snapshot-stale) both trigger on call 1.
    const out = e.apply(ctx({ resultText: 'ref e1 is stale', isError: true }))
    expect(out).toMatch(/fresh browser_snapshot/i)
    expect(out).toMatch(/stale/i)
    // call 2 with both triggers again → both suppressed → empty.
    expect(e.apply(ctx({ resultText: 'ref e1 is stale', isError: true }))).toBe('')
  })
})

describe('engine wiring', () => {
  it('returns "" when nothing matches', () => {
    const e = new HintEngine()
    expect(e.apply(ctx({ resultText: 'snapshotId=snap1 url="https://x.com"' }))).toBe('')
  })

  it('rules are sorted by priority (blocking-page before success-hints in output order)', () => {
    const e = new HintEngine()
    // A text that trips BOTH blocking-page (100) and success-hints (50): blocking line first.
    const out = e.apply(ctx({ resultText: 'click intercepted by overlay\n[⚠ outcome=SILENT_CLICK]' }))
    const overlayIdx = out.indexOf('overlay/modal')
    const verifyIdx = out.indexOf('no observable effect')
    expect(overlayIdx).toBeGreaterThanOrEqual(0)
    expect(verifyIdx).toBeGreaterThanOrEqual(0)
    expect(overlayIdx).toBeLessThan(verifyIdx)
  })

  it('a rule that throws does not break the chain', () => {
    const boom = { name: 'boom', priority: 999, match: () => { throw new Error('x') } }
    const e = new HintEngine([boom, ...DEFAULT_RULES])
    // error-recovery still fires despite the throwing rule ahead of it.
    expect(e.apply(ctx({ resultText: 'x', isError: true }))).toMatch(/fresh browser_snapshot/i)
  })
})
