import { describe, it, expect, beforeEach, vi } from 'vitest'
import { JSDOM } from 'jsdom'

// JSDOM globals must exist before importing tool-card (its transitive import
// visual-indicator.ts touches window at module load).
const dom = new JSDOM('<!doctype html><html><body></body></html>')
const { window } = dom
globalThis.window = window as any
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.CSS = window.CSS || ({ escape: (s: string) => s } as any)
;(globalThis as any).chrome = {
  storage: { local: { get: (_k: any, cb: any) => cb?.({}), set: () => {} } },
  runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } },
}

const { renderToolCard, isToolCardLive, initToolCardDeps } = await import('../content/tool-card')

// Reproduces the live-streaming orphan: a card is anchored next to the AI's
// <pre> tool block; the SPA rebuilds that <pre> mid-stream, removing the card
// with it. renderToolCard must report failure (so the caller doesn't burn the
// dedup key) and a re-render must succeed once the block is back.

function makeMessage(toolJson: string) {
  const msg = document.createElement('div')
  msg.className = 'prose'
  const pre = document.createElement('pre')
  pre.textContent = toolJson
  msg.appendChild(pre)
  document.body.appendChild(msg)
  return msg
}

const DATA = { name: 'read_file', call_id: 'abc123', args: { path: '/tmp/x' } }
const JSON_TEXT = JSON.stringify(DATA)
const KEY = 'conv1:read_file:abc123'

describe('tool card self-heal on SPA node rebuild', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    initToolCardDeps({
      executeToolCallRaw: vi.fn().mockResolvedValue(''),
      markExecuted: vi.fn(),
      fillAndSend: vi.fn().mockReturnValue(true),
      ensureStreamDispatchers: vi.fn(),
    })
  })

  it('renders, reports success, and a duplicate render is a no-op', () => {
    const msg = makeMessage(JSON_TEXT)
    expect(renderToolCard(DATA, '', msg, KEY, new Set())).toBe(true)
    expect(isToolCardLive(KEY)).toBe(true)
    // Second call while the card is live → still true, no second card.
    expect(renderToolCard(DATA, '', msg, KEY, new Set())).toBe(true)
    expect(document.querySelectorAll('[data-piercode-key]').length).toBe(1)
  })

  it('re-renders after the card is orphaned by a node rebuild', () => {
    const msg = makeMessage(JSON_TEXT)
    expect(renderToolCard(DATA, '', msg, KEY, new Set())).toBe(true)
    expect(isToolCardLive(KEY)).toBe(true)

    // Simulate the SPA rebuilding the message subtree mid-stream: wipe it and
    // re-insert a fresh <pre> with the same tool JSON. The old card is gone.
    msg.innerHTML = ''
    const fresh = document.createElement('pre')
    fresh.textContent = JSON_TEXT
    msg.appendChild(fresh)
    expect(isToolCardLive(KEY)).toBe(false)

    // A rescan must succeed again (not bail because the block was decorated).
    expect(renderToolCard(DATA, '', msg, KEY, new Set())).toBe(true)
    expect(isToolCardLive(KEY)).toBe(true)
  })
})
