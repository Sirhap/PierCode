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

// localStorage shim (jsdom's may be absent depending on config) so the result
// cache used by renderExecutedCard works in tests.
if (!globalThis.localStorage) {
  const m = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => { m.clear() },
  } as any
}

const { renderToolCard, renderExecutedCard, isToolCardLive, initToolCardDeps } = await import('../content/tool-card')
const { saveToolResult } = await import('../content/tool-result-store')

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

// renderExecutedCard: the read-only "done" card re-rendered for an already-
// executed tool whose interactive card was orphaned by an SPA DOM rebuild
// (ChatGPT finalizes the message and rebuilds the <pre>). It must show the
// cached result, carry NO execution buttons, and never call executeToolCallRaw.
describe('renderExecutedCard (read-only done card)', () => {
  const EXEC_RAW = vi.fn().mockResolvedValue('')
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(globalThis.localStorage as any).clear?.()
    EXEC_RAW.mockClear()
    initToolCardDeps({
      executeToolCallRaw: EXEC_RAW,
      markExecuted: vi.fn(),
      fillAndSend: vi.fn().mockReturnValue(true),
      ensureStreamDispatchers: vi.fn(),
    })
  })

  it('renders a read-only card with the cached output and no exec buttons', () => {
    saveToolResult(KEY, { name: 'read_file', argsPreview: '/tmp/x', output: 'cached line one\ncached line two', status: 'done', durationMs: 250, ts: Date.now() })
    const msg = makeMessage(JSON_TEXT)
    expect(renderExecutedCard(DATA, msg, KEY)).toBe(true)
    const card = document.querySelector(`[data-piercode-key="${KEY}"]`)!
    expect(card).toBeTruthy()
    // No buttons at all → cannot re-trigger execution.
    expect(card.querySelectorAll('button').length).toBe(0)
    // Cached output surfaced.
    expect(card.textContent).toContain('cached line one')
    expect(card.textContent).toContain('已执行')
  })

  it('does not call executeToolCallRaw (no double-exec)', () => {
    saveToolResult(KEY, { name: 'read_file', argsPreview: '/tmp/x', output: 'out', status: 'done', durationMs: 1, ts: Date.now() })
    const msg = makeMessage(JSON_TEXT)
    renderExecutedCard(DATA, msg, KEY)
    expect(EXEC_RAW).not.toHaveBeenCalled()
  })

  it('degrades to a no-output placeholder on a cache miss', () => {
    const msg = makeMessage(JSON_TEXT)
    expect(renderExecutedCard(DATA, msg, KEY)).toBe(true)
    const card = document.querySelector(`[data-piercode-key="${KEY}"]`)!
    expect(card.querySelectorAll('button').length).toBe(0)
    expect(card.textContent).toContain('无缓存输出')
  })

  it('re-renders after the executed card is orphaned by a node rebuild', () => {
    saveToolResult(KEY, { name: 'read_file', argsPreview: '/tmp/x', output: 'out', status: 'done', durationMs: 1, ts: Date.now() })
    const msg = makeMessage(JSON_TEXT)
    expect(renderExecutedCard(DATA, msg, KEY)).toBe(true)
    expect(isToolCardLive(KEY)).toBe(true)

    // SPA rebuilds the subtree: card gone, fresh <pre> back.
    msg.innerHTML = ''
    const fresh = document.createElement('pre')
    fresh.textContent = JSON_TEXT
    msg.appendChild(fresh)
    expect(isToolCardLive(KEY)).toBe(false)

    expect(renderExecutedCard(DATA, msg, KEY)).toBe(true)
    expect(isToolCardLive(KEY)).toBe(true)
  })

  it('shows error status when the cached record is an error', () => {
    saveToolResult(KEY, { name: 'read_file', argsPreview: '/tmp/x', output: 'boom', status: 'error', durationMs: 5, ts: Date.now() })
    const msg = makeMessage(JSON_TEXT)
    renderExecutedCard(DATA, msg, KEY)
    const card = document.querySelector(`[data-piercode-key="${KEY}"]`)!
    expect(card.textContent).toContain('error')
  })
})
