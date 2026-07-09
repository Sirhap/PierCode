// test-plan.ts — 把一次浏览器 Agent 任务的动作时间线导出为可回放的 browser_test
// 计划（录制→回放）。纯函数，vitest 可测；剪贴板/DOM 交互留在组件层。
//
// 回放语义：导出的 steps 直接作为 browser_test 的 args.steps 重跑（同一受控 tab，
// 不含 tabId —— 回放时以当时的受控页为准）。ref/snapshotId 绑定当轮快照，重放时
// 大概率已失效 —— 保留原样并计数 refWarnings，提示用户/AI 替换为 selector。

import type { TimelineEntry } from './browser-agent-store'

// 不进回放计划的工具：观察类（重放无意义）、快照/截图类（ref 制造者）、tab 管理
// （回放固定在当前受控 tab）、以及元工具自身。question 不是 browser_* 但一并防御。
const EXCLUDED_TOOLS = new Set([
  'browser_snapshot', 'browser_screenshot', 'browser_zoom', 'browser_mark', 'browser_record',
  'browser_pdf', 'browser_tabs', 'browser_use_tab', 'browser_new_tab', 'browser_finalize_tabs',
  'browser_test', 'question', 'browser_console', 'browser_network', 'browser_downloads',
])

// 回放计划里剔除的 args 键：内部路由戳 + tab 绑定 + 调用 id。
const STRIPPED_ARG_KEYS = new Set(['__originTabId', '__skipApproval', '__currentOrigin', 'tabId', 'call_id'])

export interface TestPlanStep { name: string; input: Record<string, unknown> }

export interface TestPlanExport {
  /** 可直接粘贴进 AI 输入框的完整 piercode-tool fenced block。 */
  fencedBlock: string
  /** 计划步数（含从 browser_batch 展开的子步）。 */
  stepCount: number
  /** 含 ref/snapshotId 的步数 —— 回放前需人工/AI 换成 selector。 */
  refWarnings: number
}

function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (STRIPPED_ARG_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

function hasRefBinding(input: Record<string, unknown>): boolean {
  return input.ref !== undefined || input.snapshotId !== undefined ||
    input.fromRef !== undefined || input.toRef !== undefined || input.mark !== undefined
}

/** 时间线 → 回放步骤。只收成功完成的 browser_* 动作；browser_batch 展开为子步。 */
export function timelineToSteps(entries: TimelineEntry[]): { steps: TestPlanStep[]; refWarnings: number } {
  const steps: TestPlanStep[] = []
  let refWarnings = 0
  const push = (name: string, input: Record<string, unknown>) => {
    if (!name.startsWith('browser_') || EXCLUDED_TOOLS.has(name)) return
    const cleaned = cleanArgs(input)
    if (hasRefBinding(cleaned)) refWarnings++
    steps.push({ name, input: cleaned })
  }
  for (const e of entries) {
    if (e.status !== 'done' || e.success === false) continue
    if (e.name === 'browser_batch') {
      const actions = Array.isArray((e.args as { actions?: unknown }).actions)
        ? ((e.args as { actions: unknown[] }).actions)
        : []
      for (const raw of actions) {
        if (!raw || typeof raw !== 'object') continue
        const a = raw as { name?: unknown; input?: unknown }
        push(String(a.name || ''), (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>)
      }
      continue
    }
    push(e.name, e.args || {})
  }
  return { steps, refWarnings }
}

/** 生成随机 call_id（≥5 位非顺序，符合 piercode-tool 契约）。 */
function randomCallId(): string {
  return `browser_test-${Math.random().toString(36).slice(2, 8)}`
}

/** 时间线 → 可粘贴的 browser_test piercode-tool block。steps 为空时返回 null。 */
export function exportTestPlan(entries: TimelineEntry[], name: string): TestPlanExport | null {
  const { steps, refWarnings } = timelineToSteps(entries)
  if (steps.length === 0) return null
  const call = {
    name: 'browser_test',
    call_id: randomCallId(),
    args: { name, steps },
  }
  const fencedBlock = '```piercode-tool\n' + JSON.stringify(call, null, 2) + '\n```'
  return { fencedBlock, stepCount: steps.length, refWarnings }
}
