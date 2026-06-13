import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window as any
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.CSS = (dom.window as any).CSS || ({ escape: (s: string) => s } as any)
;(globalThis as any).chrome = {
  storage: { local: { get: (_k: any, cb: any) => cb?.({}), set: () => {} } },
  runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } },
}

const { findToolBlockElement } = await import('../content/tool-card')

function addPre(text: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.textContent = text
  document.body.appendChild(pre)
  return pre
}

describe('findToolBlockElement: consecutive same-tool blocks', () => {
  it('a call_id prefix does not steal another block\'s element', () => {
    document.body.innerHTML = ''
    // Two browser_screenshot blocks whose call_ids share a prefix.
    const block1 = addPre('{"name":"browser_screenshot","call_id":"screenshot-1","args":{}}')
    const block2 = addPre('{"name":"browser_screenshot","call_id":"screenshot-12","args":{}}')

    // Locating block2 (call_id "screenshot-12") must return block2, NOT block1
    // (whose text "screenshot-1" is a substring of "screenshot-12").
    const found2 = findToolBlockElement(document.body, { name: 'browser_screenshot', call_id: 'screenshot-12', args: {} })
    expect(found2).toBe(block2)

    // And locating block1 returns block1 (its exact quoted call_id).
    const found1 = findToolBlockElement(document.body, { name: 'browser_screenshot', call_id: 'screenshot-1', args: {} })
    expect(found1).toBe(block1)
  })

  it('once block1 is decorated, block2 still locates its own element', () => {
    document.body.innerHTML = ''
    const block1 = addPre('{"name":"browser_screenshot","call_id":"shot-a","args":{}}')
    const block2 = addPre('{"name":"browser_screenshot","call_id":"shot-b","args":{}}')
    // Simulate block1 already rendered → marked with data-piercode-key.
    block1.setAttribute('data-piercode-key', 'conv:browser_screenshot:shot-a')

    const found2 = findToolBlockElement(document.body, { name: 'browser_screenshot', call_id: 'shot-b', args: {} })
    expect(found2).toBe(block2)
  })
})
