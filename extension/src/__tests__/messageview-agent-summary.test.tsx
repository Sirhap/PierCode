import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import MessageView, { type ChatMessage } from '../sidebar/MessageView'

let dom: JSDOM
let root: Root | null
let host: HTMLElement

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  ;(globalThis as any).window = dom.window as any
  ;(globalThis as any).document = dom.window.document
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
})

const msg: ChatMessage = {
  role: 'assistant',
  content: '',
  agentSummary: [
    { label: 'scanner', status: 'done', summary: 'found 4 issues', output: 'FULL scanner output' },
    { label: 'fixer', status: 'error', summary: 'boom', output: 'FULL fixer output' },
  ],
}

describe('MessageView agentSummary card', () => {
  it('renders one row per sub-agent with label + summary', () => {
    act(() => { root!.render(<MessageView msg={msg} />) })
    const text = host.textContent || ''
    expect(text).toContain('@scanner')
    expect(text).toContain('found 4 issues')
    expect(text).toContain('@fixer')
    expect(text).toContain('×2')
  })

  it('expands a row to show full output on click', () => {
    act(() => { root!.render(<MessageView msg={msg} />) })
    expect(host.textContent).not.toContain('FULL scanner output')
    // Click the first summary row (the clickable element containing @scanner).
    const rows = Array.from(host.querySelectorAll('div')).filter(d =>
      (d.textContent || '').includes('@scanner') && d.className.includes('cursor-pointer'))
    const clickable = rows[0] as HTMLElement
    act(() => { clickable.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('FULL scanner output')
  })
})
