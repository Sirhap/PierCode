import { describe, it, expect, vi } from 'vitest'
import { findElementsExpr, find } from '../../background/browser/find'

describe('find', () => {
  it('findElementsExpr embeds the query + limit + scoring', () => {
    const e = findElementsExpr('Submit now', 10)
    expect(e).toContain(JSON.stringify('Submit now'))
    expect(e).toContain('var maxResults = 10')
    expect(e).toContain('stableSelector')   // selector synthesis present
    expect(e).toContain('walkDoc')          // iframe/shadow walk present
  })
  it('find runs the expr (string JSON) and returns ranked results', async () => {
    const results = [
      { ref: 'button#go', role: 'button', text: 'Submit', score: 9 },
      { ref: 'a#home', role: 'link', text: 'Home', score: 3 },
    ]
    const cdp = { runtimeEvaluate: vi.fn(async () => JSON.stringify(results)), sendCommand: vi.fn(), callFunctionOnObject: vi.fn() }
    const out = await find(cdp as any, { tabId: 1 }, { query: 'Submit', limit: 10 })
    expect(out[0].text).toBe('Submit')
    expect(out[0].score).toBeGreaterThan(out[1].score)
    expect(cdp.runtimeEvaluate).toHaveBeenCalledOnce()
  })
  it('find tolerates already-parsed array result', async () => {
    const cdp = { runtimeEvaluate: vi.fn(async () => [{ ref: 'x', role: 'button', text: 't', score: 5 }]),
      sendCommand: vi.fn(), callFunctionOnObject: vi.fn() }
    const out = await find(cdp as any, { tabId: 1 }, { query: 'q' })
    expect(out.length).toBe(1)
  })
})
