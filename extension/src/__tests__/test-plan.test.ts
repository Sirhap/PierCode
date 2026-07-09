// test-plan.ts — 时间线 → browser_test 回放计划导出（录制→回放）。
import { describe, it, expect } from 'vitest'
import { timelineToSteps, exportTestPlan } from '../sidebar/test-plan'
import type { TimelineEntry } from '../sidebar/browser-agent-store'

const entry = (name: string, args: Record<string, unknown>, status: TimelineEntry['status'] = 'done', success = true): TimelineEntry =>
  ({ callId: `${name}-${Math.random().toString(36).slice(2, 6)}`, name, args, status, success })

describe('timelineToSteps', () => {
  it('keeps successful actions, drops observers/tab-management/failed/question', () => {
    const { steps } = timelineToSteps([
      entry('browser_use_tab', { tabId: 5 }),
      entry('browser_snapshot', {}),
      entry('browser_navigate', { url: 'https://x.com', tabId: 5 }),
      entry('browser_click', { selector: '#go' }),
      entry('browser_click', { selector: '#broken' }, 'error', false),
      entry('question', { question: 'ok?' }),
      entry('browser_screenshot', {}),
      entry('browser_assert', { kind: 'url', expect: 'x.com' }),
    ])
    expect(steps.map(s => s.name)).toEqual(['browser_navigate', 'browser_click', 'browser_assert'])
    // tabId / internal stamps stripped — replay targets the current controlled tab
    expect(steps[0].input).toEqual({ url: 'https://x.com' })
  })

  it('flattens browser_batch children and counts ref-bound steps', () => {
    const { steps, refWarnings } = timelineToSteps([
      entry('browser_batch', {
        actions: [
          { name: 'browser_click', input: { ref: 'e3', snapshotId: 'snap1' } },
          { name: 'browser_type', input: { selector: '#q', text: 'hi' } },
          { name: 'browser_snapshot', input: {} },
        ],
      }),
    ])
    expect(steps.map(s => s.name)).toEqual(['browser_click', 'browser_type'])
    expect(refWarnings).toBe(1)
  })
})

describe('exportTestPlan', () => {
  it('emits a pasteable piercode-tool fenced block with a browser_test call', () => {
    const plan = exportTestPlan([entry('browser_click', { selector: '#a' })], 'case A')
    expect(plan).not.toBeNull()
    expect(plan!.stepCount).toBe(1)
    expect(plan!.fencedBlock.startsWith('```piercode-tool\n')).toBe(true)
    const json = JSON.parse(plan!.fencedBlock.replace(/^```piercode-tool\n/, '').replace(/\n```$/, ''))
    expect(json.name).toBe('browser_test')
    expect(json.call_id.length).toBeGreaterThanOrEqual(5)
    expect(json.args).toEqual({ name: 'case A', steps: [{ name: 'browser_click', input: { selector: '#a' } }] })
  })

  it('returns null when nothing is replayable', () => {
    expect(exportTestPlan([entry('browser_snapshot', {})], 'x')).toBeNull()
  })
})
