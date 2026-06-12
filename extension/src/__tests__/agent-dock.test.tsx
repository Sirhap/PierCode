/**
 * AgentDock（右上角浮标 + 抽屉 + 工具调用树）与 subagent-ui 的工具调用解析。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import AgentDock from '../sidebar/AgentDock'
import {
  parseAgentToolCalls,
  summarizeToolArgs,
  type SubAgent,
} from '../sidebar/subagent-ui'

// ── parse helpers ───────────────────────────────────────────────────────────

describe('parseAgentToolCalls', () => {
  it('extracts tool calls in order from a streamed transcript', () => {
    const transcript =
      '先看文件。\n```piercode-tool\n{"name":"read_file","call_id":"1","args":{"path":"src/a.ts"}}\n```\n' +
      '再跑命令。\n```piercode-tool\n{"name":"exec_cmd","call_id":"2","args":{"command":"go test ./..."}}\n```'
    const calls = parseAgentToolCalls(transcript)
    expect(calls.map(c => c.name)).toEqual(['read_file', 'exec_cmd'])
    expect(calls[0].preview).toBe('src/a.ts')
    expect(calls[1].preview).toBe('go test ./...')
  })

  it('an unclosed fence (still streaming) parses to nothing yet', () => {
    const partial = '看文件。\n```piercode-tool\n{"name":"read_file","args":{"path":"x'
    expect(parseAgentToolCalls(partial)).toEqual([])
  })
})

describe('summarizeToolArgs', () => {
  it('prefers path-like keys and clips long values', () => {
    expect(summarizeToolArgs({ recursive: true, path: 'a/b.txt' })).toBe('a/b.txt')
    expect(summarizeToolArgs({ command: 'x'.repeat(60) })).toHaveLength(40)
  })
  it('falls back to the first string value, empty when none', () => {
    expect(summarizeToolArgs({ foo: 'bar' })).toBe('bar')
    expect(summarizeToolArgs({ n: 3 })).toBe('')
  })
})

// ── component ───────────────────────────────────────────────────────────────

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

const READ_FENCE = '```piercode-tool\n{"name":"read_file","call_id":"1","args":{"path":"src/a.ts"}}\n```'

const agents: SubAgent[] = [
  {
    id: 'a1', label: 'scanner', task: '扫描代码', status: 'running',
    messages: [{ role: 'assistant', content: `开始。\n${READ_FENCE}\n继续…` }],
  },
  {
    id: 'a2', label: 'fixer', task: '修复 bug', status: 'done',
    messages: [{ role: 'assistant', content: '修好了' }],
  },
]

function click(el: Element) {
  act(() => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}

describe('AgentDock', () => {
  it('renders nothing without agents', () => {
    act(() => { root!.render(<AgentDock agents={[]} onAbort={() => {}} />) })
    expect(host.textContent).toBe('')
  })

  it('badge shows the running count; drawer opens with one row per agent', () => {
    act(() => { root!.render(<AgentDock agents={agents} onAbort={() => {}} />) })
    expect(host.textContent).toContain('1 agent 运行中')
    expect(host.textContent).not.toContain('@scanner')

    click(host.querySelector('button')!)
    expect(host.textContent).toContain('@scanner')
    expect(host.textContent).toContain('@fixer')
    // running row previews its CURRENT (last parsed) tool call
    expect(host.textContent).toContain('read_file src/a.ts')
    // done row shows the call count
    expect(host.textContent).toContain('完成 · 0 工具调用')
  })

  it('clicking a row expands the full tool-call tree', () => {
    act(() => { root!.render(<AgentDock agents={agents} onAbort={() => {}} />) })
    click(host.querySelector('button')!)
    const row = Array.from(host.querySelectorAll('div')).find(d =>
      (d.textContent || '').includes('@scanner') && d.className.includes('cursor-pointer'))!
    click(row)
    expect(host.textContent).toContain('扫描代码')   // ⏺ task header
    expect(host.textContent).toContain('src/a.ts')  // ⎿ call entry
  })

  it('✕ on a running row calls onAbort with the agent id', () => {
    const onAbort = vi.fn()
    act(() => { root!.render(<AgentDock agents={agents} onAbort={onAbort} />) })
    click(host.querySelector('button')!)
    const abortBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '✕')!
    click(abortBtn)
    expect(onAbort).toHaveBeenCalledWith('a1')
  })

  it('badge switches to error state when a worker failed and none run', () => {
    const errAgents: SubAgent[] = [{
      id: 'a3', label: 'x', task: 't', status: 'error',
      messages: [{ role: 'assistant', content: '炸了' }],
    }]
    act(() => { root!.render(<AgentDock agents={errAgents} onAbort={() => {}} />) })
    expect(host.textContent).toContain('1 agent 出错')
  })
})
