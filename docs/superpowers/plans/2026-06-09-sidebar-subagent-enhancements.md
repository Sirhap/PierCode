# 侧边栏子 Agent 增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧边栏 API 子 agent 并行执行、可单独取消、done 后淡出、并在父对话内联一张结果汇总卡。

**Architecture:** `chat-api.ts`（background）新增 `agentAborts` map + `mergedAgentSignal` 原语（借 Claude Code `capacityWake.ts`），把串行 `for` 改 `Promise.all`，加 `CHAT_AGENT_ABORT` 消息处理，并让 `CHAT_AGENT_DONE` 携带 summary/output。侧边栏（`App.tsx`/`MessageView.tsx`/`SubAgentCard`）消费这些事件：done 淡出移除、终态后追加 `agentSummary` 汇总卡、running 卡片 ✕ 发 abort。纯逻辑提取成可单测 helper。

**Tech Stack:** TypeScript, React 18, Vite, Vitest (pool: threads), Chrome MV3 runtime messaging.

参考 spec：`docs/superpowers/specs/2026-06-09-sidebar-subagent-enhancements-design.md`

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `extension/src/background/chat-api.ts` | 子 agent 编排 | §1 `agentAborts`+`mergedAgentSignal`；§2 `Promise.all`；§4 done 带 summary；§5 `CHAT_AGENT_ABORT` |
| `extension/src/sidebar/subagent-ui.ts` (新建) | 侧边栏子 agent 纯逻辑 helper | done 淡出/移除调度、汇总卡构造、summary 截断 |
| `extension/src/sidebar/App.tsx` | 事件消费 + 状态 | §3 淡出移除；§4 追加汇总卡；§5 ✕ 发 abort |
| `extension/src/sidebar/MessageView.tsx` | 渲染 | §4 `agentSummary` 字段 + 折叠树渲染 |
| `extension/src/sidebar/WorkerRadar.tsx` | radar 胶囊 | 不改（非目标） |
| `extension/src/sidebar/index.css` | 动画 | §3 fade-out keyframe |
| `extension/src/__tests__/chat-api-subagent-abort.test.ts` (新建) | 测 §1 原语 | mergedAgentSignal 行为 |
| `extension/src/__tests__/subagent-ui.test.ts` (新建) | 测 §3/§4 helper | 截断/汇总构造 |
| `extension/src/__tests__/messageview-agent-summary.test.tsx` (新建) | 测 §4 渲染 | 折叠树 DOM |

新建 `subagent-ui.ts` 理由：App.tsx 已 1051 行，淡出调度/汇总构造是纯逻辑，抽出可单测且不让 App.tsx 继续膨胀。

---

## Task 1: §1 导出 mergedAgentSignal + agentAborts map

**Files:**
- Modify: `extension/src/background/chat-api.ts`（模块级，`currentAbort` 声明附近 + runSubAgent 区域）
- Test: `extension/src/__tests__/chat-api-subagent-abort.test.ts` (新建)

- [ ] **Step 1: 写失败测试**

新建 `extension/src/__tests__/chat-api-subagent-abort.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mergedAgentSignal, __agentAbortsForTest } from '../background/chat-api'

describe('mergedAgentSignal', () => {
  it('own abort triggers merged signal and registers in map', () => {
    const { signal, cleanup } = mergedAgentSignal('a1', undefined)
    expect(__agentAbortsForTest().has('a1')).toBe(true)
    expect(signal.aborted).toBe(false)
    __agentAbortsForTest().get('a1')!.abort()
    expect(signal.aborted).toBe(true)
    cleanup()
    expect(__agentAbortsForTest().has('a1')).toBe(false)
  })

  it('outer abort triggers merged signal', () => {
    const outer = new AbortController()
    const { signal, cleanup } = mergedAgentSignal('a2', outer.signal)
    expect(signal.aborted).toBe(false)
    outer.abort()
    expect(signal.aborted).toBe(true)
    cleanup()
  })

  it('already-aborted outer yields pre-aborted merged signal', () => {
    const outer = new AbortController()
    outer.abort()
    const { signal, cleanup } = mergedAgentSignal('a3', outer.signal)
    expect(signal.aborted).toBe(true)
    cleanup()
    expect(__agentAbortsForTest().has('a3')).toBe(false)
  })

  it('cleanup removes the map entry without aborting', () => {
    const { signal, cleanup } = mergedAgentSignal('a4', undefined)
    cleanup()
    expect(__agentAbortsForTest().has('a4')).toBe(false)
    expect(signal.aborted).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd extension && npx vitest run src/__tests__/chat-api-subagent-abort.test.ts`
Expected: FAIL — `mergedAgentSignal is not a function` / `__agentAbortsForTest is not a function`

- [ ] **Step 3: 实现**

在 `chat-api.ts` 模块级（`let currentAbort: AbortController | null = null` 附近）加：

```ts
// Per-sub-agent abort controllers, keyed by agentId. Lets a single worker be
// cancelled without touching the global currentAbort or sibling workers.
const agentAborts = new Map<string, AbortController>()

// mergedAgentSignal returns a signal that aborts when EITHER this agent's own
// controller fires (single-worker cancel) OR the outer signal fires (global
// stop). Borrowed from Claude Code's capacityWake.ts signal-merge primitive.
// cleanup() removes listeners and the map entry — call in finally.
export function mergedAgentSignal(
  agentId: string,
  outer: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const own = new AbortController()
  agentAborts.set(agentId, own)
  const merged = new AbortController()
  const onAbort = () => merged.abort()
  if (own.signal.aborted || outer?.aborted) {
    merged.abort()
  } else {
    own.signal.addEventListener('abort', onAbort, { once: true })
    outer?.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: merged.signal,
    cleanup: () => {
      own.signal.removeEventListener('abort', onAbort)
      outer?.removeEventListener('abort', onAbort)
      agentAborts.delete(agentId)
    },
  }
}

// Test-only accessor for the abort map.
export function __agentAbortsForTest(): Map<string, AbortController> {
  return agentAborts
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd extension && npx vitest run src/__tests__/chat-api-subagent-abort.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/chat-api.ts extension/src/__tests__/chat-api-subagent-abort.test.ts
git commit -m "feat(sidebar): mergedAgentSignal for per-sub-agent abort

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: §1+§4 runSubAgent 用 merged signal + done 带 summary/output

**Files:**
- Modify: `extension/src/background/chat-api.ts:918-960`（runSubAgent）

无独立单测（涉及 fetch/SSE，靠集成 + 后续 UI 测）。改完跑全量确认不回归。

- [ ] **Step 1: 改 runSubAgent 用 mergedAgentSignal**

将 `chat-api.ts` runSubAgent 现有实现（约 918-960 行）替换为：

```ts
async function runSubAgent(
  call: ToolCall,
  platform: string,
  model: string | undefined,
  parentDepth: number,
): Promise<ToolResult> {
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const label = String(call.args.label || 'agent')
  const task = String(call.args.task || call.args.prompt || '')

  if (parentDepth >= MAX_AGENT_DEPTH) {
    return shapeSubAgentResult(call, `(子 agent 嵌套超过上限 ${MAX_AGENT_DEPTH}，已拒绝)`)
  }
  if (!task) {
    return shapeSubAgentResult(call, '(spawn_agent 缺少 task 参数)')
  }

  broadcast({ type: 'CHAT_AGENT_SPAWN', agentId, label, task })

  const workerPrompt = await fetchWorkerPrompt()
  const message = buildSubAgentMessage(workerPrompt, task)
  const { signal, cleanup } = mergedAgentSignal(agentId, currentAbort?.signal)

  try {
    const finalText = await runIsolatedConversation({
      platform,
      message,
      model,
      depth: parentDepth + 1,
      agentId,
      abortSignal: signal,
    })
    const cancelled = signal.aborted
    const output = cancelled ? `${finalText}\n\n(已取消)`.trim() : finalText
    broadcast({
      type: 'CHAT_AGENT_DONE',
      agentId,
      status: cancelled ? 'error' : 'done',
      label,
      summary: firstLine(output),
      output,
    })
    return cancelled
      ? { call_id: call.call_id, name: call.name, output: output || '(已取消)', success: false }
      : shapeSubAgentResult(call, finalText)
  } catch (err) {
    const cancelled = signal.aborted
    const msg = cancelled ? '(已取消)' : `子 agent 失败: ${err instanceof Error ? err.message : String(err)}`
    broadcast({ type: 'CHAT_AGENT_DONE', agentId, status: 'error', label, summary: msg, output: msg })
    return { call_id: call.call_id, name: call.name, output: msg, success: false }
  } finally {
    cleanup()
  }
}
```

- [ ] **Step 2: 加 firstLine helper**

在 `chat-api.ts` `shapeSubAgentResult` 附近加（若已有同名则跳过）：

```ts
// firstLine returns the first non-empty line of a string, trimmed to ~60 chars,
// for the sub-agent summary card.
export function firstLine(text: string): string {
  const line = (text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return line.length > 60 ? line.slice(0, 57) + '…' : line
}
```

- [ ] **Step 3: 跑全量子 agent + tool-extract 测试确认不回归**

Run: `cd extension && npx vitest run src/__tests__/sidebar-subagent.test.ts src/__tests__/chat-api-tool-extract.test.ts src/__tests__/chat-api-subagent-abort.test.ts`
Expected: PASS（既有 + 新增全绿）

- [ ] **Step 4: 类型检查**

Run: `cd extension && npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/chat-api.ts
git commit -m "feat(sidebar): runSubAgent uses merged signal, done carries summary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: §2 spawn_agent 并行执行 + §5 CHAT_AGENT_ABORT 处理

**Files:**
- Modify: `extension/src/background/chat-api.ts:871-877`（spawn 串行循环）
- Modify: `extension/src/background/chat-api.ts`（registerChatApiHandler 消息处理）

- [ ] **Step 1: 改并行**

将 `chat-api.ts` 现有 spawn 串行循环：

```ts
      // spawn_agent → recursive sub-conversation (no tabs).
      for (const tc of spawns) {
        if (currentAbort.signal.aborted) break
        const result = await runSubAgent(tc, platform, modelOverride, depth)
        results.push(result)
        broadcast({ type: 'CHAT_TOOL_DONE', result })
      }
```

替换为：

```ts
      // spawn_agent → parallel sub-conversations (no tabs). Each runSubAgent
      // catches its own failures into a failed ToolResult, so Promise.all never
      // rejects on a single worker error. Order preserved → summary card stable.
      if (spawns.length > 0 && !currentAbort.signal.aborted) {
        const spawnResults = await Promise.all(
          spawns.map(tc => runSubAgent(tc, platform, modelOverride, depth)),
        )
        for (const r of spawnResults) {
          results.push(r)
          broadcast({ type: 'CHAT_TOOL_DONE', result: r })
        }
      }
```

- [ ] **Step 2: 加 CHAT_AGENT_ABORT 处理**

找到 `registerChatApiHandler` 里的 `chrome.runtime.onMessage.addListener`（处理 `CHAT_*` 消息的地方）。在其消息分支中加一条（与现有 `STOP_CHAT`/abort 风格一致）：

```ts
    if (msg.type === 'CHAT_AGENT_ABORT') {
      const id = String(msg.agentId || '')
      agentAborts.get(id)?.abort()
      sendResponse?.({ ok: true })
      return true
    }
```

（注：若现有 handler 用 `if/else if` 链或 `switch`，按其结构插入对应分支；保持 `return true` 以支持异步 sendResponse 约定。实现者读 `registerChatApiHandler` 现有结构后对齐。）

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd extension && npx tsc --noEmit && npx vitest run`
Expected: tsc 无输出；vitest 全绿（无回归）

- [ ] **Step 4: 提交**

```bash
git add extension/src/background/chat-api.ts
git commit -m "feat(sidebar): parallel spawn_agent + CHAT_AGENT_ABORT handler

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: §3/§4 subagent-ui.ts 纯逻辑 helper

**Files:**
- Create: `extension/src/sidebar/subagent-ui.ts`
- Test: `extension/src/__tests__/subagent-ui.test.ts` (新建)

- [ ] **Step 1: 写失败测试**

新建 `extension/src/__tests__/subagent-ui.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { truncateSummary, buildAgentSummary, type AgentSummaryItem } from '../sidebar/subagent-ui'

describe('truncateSummary', () => {
  it('returns first non-empty line', () => {
    expect(truncateSummary('\n  hello \nworld')).toBe('hello')
  })
  it('truncates long lines to 60 chars with ellipsis', () => {
    const long = 'x'.repeat(80)
    const out = truncateSummary(long)
    expect(out.length).toBe(60)
    expect(out.endsWith('…')).toBe(true)
  })
  it('empty input yields empty string', () => {
    expect(truncateSummary('')).toBe('')
  })
})

describe('buildAgentSummary', () => {
  it('maps done sub-agents into summary items', () => {
    const items: AgentSummaryItem[] = buildAgentSummary([
      { id: 'a', label: 'scanner', task: 't', status: 'done', messages: [{ role: 'assistant', content: 'found 4 issues' }] as any },
      { id: 'b', label: 'fixer', task: 't', status: 'error', messages: [{ role: 'assistant', content: 'boom' }] as any },
    ] as any)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ label: 'scanner', status: 'done', summary: 'found 4 issues' })
    expect(items[1]).toMatchObject({ label: 'fixer', status: 'error' })
    expect(items[0].output).toContain('found 4 issues')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd extension && npx vitest run src/__tests__/subagent-ui.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 subagent-ui.ts**

新建 `extension/src/sidebar/subagent-ui.ts`：

```ts
import type { SubAgent } from './WorkerRadar'

export interface AgentSummaryItem {
  label: string
  status: 'done' | 'error'
  summary: string
  output: string
}

// truncateSummary returns the first non-empty trimmed line, capped at 60 chars.
// Mirrors chat-api's firstLine so card summary matches the broadcast summary.
export function truncateSummary(text: string): string {
  const line = (text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return line.length > 60 ? line.slice(0, 59) + '…' : line
}

// buildAgentSummary maps a batch of terminal sub-agents into summary-card items.
// output = concatenated transcript; summary = its first line.
export function buildAgentSummary(agents: SubAgent[]): AgentSummaryItem[] {
  return agents.map(a => {
    const output = a.messages.map(m => m.content).join('')
    return {
      label: a.label,
      status: a.status === 'error' ? 'error' : 'done',
      summary: truncateSummary(output),
      output,
    }
  })
}

// Delay (ms) before a done sub-agent card fades out and is removed.
export const AGENT_FADE_DELAY_MS = 2500
// Fade-out animation duration (ms) — must match index.css .agent-fading.
export const AGENT_FADE_DURATION_MS = 400
```

注：`truncateSummary` 用 59+… = 60 字符，与测试一致；chat-api `firstLine` 用 57+… = 60，两边都 ≤60，summary 文本可能差几字符但都是首行截断，不影响功能（汇总卡用本地 transcript 重算）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd extension && npx vitest run src/__tests__/subagent-ui.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 提交**

```bash
git add extension/src/sidebar/subagent-ui.ts extension/src/__tests__/subagent-ui.test.ts
git commit -m "feat(sidebar): subagent-ui helpers (summary + fade timing)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: §4 MessageView agentSummary 字段 + 渲染

**Files:**
- Modify: `extension/src/sidebar/MessageView.tsx`（ChatMessage interface + 渲染分支）
- Test: `extension/src/__tests__/messageview-agent-summary.test.tsx` (新建)

- [ ] **Step 1: 写失败测试**

新建 `extension/src/__tests__/messageview-agent-summary.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MessageView, { type ChatMessage } from '../sidebar/MessageView'

describe('MessageView agentSummary card', () => {
  const msg: ChatMessage = {
    role: 'assistant',
    content: '',
    agentSummary: [
      { label: 'scanner', status: 'done', summary: 'found 4 issues', output: 'FULL scanner output' },
      { label: 'fixer', status: 'error', summary: 'boom', output: 'FULL fixer output' },
    ],
  }

  it('renders one row per sub-agent with label + summary', () => {
    render(<MessageView msg={msg} />)
    expect(screen.getByText(/@scanner/)).toBeTruthy()
    expect(screen.getByText(/found 4 issues/)).toBeTruthy()
    expect(screen.getByText(/@fixer/)).toBeTruthy()
  })

  it('expands a row to show full output on click', () => {
    render(<MessageView msg={msg} />)
    expect(screen.queryByText('FULL scanner output')).toBeNull()
    fireEvent.click(screen.getByText(/@scanner/))
    expect(screen.getByText('FULL scanner output')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd extension && npx vitest run src/__tests__/messageview-agent-summary.test.tsx`
Expected: FAIL — `agentSummary` 非 ChatMessage 字段 / 无渲染

- [ ] **Step 3: 加字段 + 渲染**

在 `MessageView.tsx` 顶部加导入：

```ts
import type { AgentSummaryItem } from './subagent-ui'
```

`ChatMessage` interface 加字段（在 `pinned?: boolean` 后）：

```ts
  agentSummary?: AgentSummaryItem[]
```

加汇总行组件（在 `MessageView` 默认导出函数之前）：

```tsx
function AgentSummaryRow({ item }: { item: AgentSummaryItem }) {
  const [open, setOpen] = useState(false)
  const mark = item.status === 'error' ? '✗' : '✓'
  const markColor = item.status === 'error' ? 'var(--red, #e06c75)' : 'var(--glow)'
  return (
    <div className="cc-result-row text-[11px]">
      <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿  </span>
      <div className="flex-1 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--glow)' }}>@{item.label}</span>{' '}
        <span style={{ color: markColor }}>{mark}</span>{' '}
        <span style={{ color: 'var(--dim)' }}>{item.summary || '(无输出)'}</span>
        {open && (
          <pre className="whitespace-pre-wrap break-all mt-1" style={{ color: 'var(--txt)', lineHeight: 1.35, margin: 0 }}>
            {item.output || '(无输出)'}
          </pre>
        )}
      </div>
    </div>
  )
}
```

在 `MessageView` 默认导出函数体内，`isTool` 早返回之后、assistant 渲染分支之前，加 `agentSummary` 早返回分支：

```tsx
  if (msg.agentSummary && msg.agentSummary.length > 0) {
    return (
      <div className="msg-row px-4 py-2">
        <div className="cc-tool text-[12px]">
          <div className="flex items-baseline gap-1">
            <span style={{ color: 'var(--dim)', fontSize: '0.85em', lineHeight: 1 }}>⏺</span>
            <span className="font-medium" style={{ color: 'var(--txt)' }}>spawn_agent</span>
            <span style={{ color: 'var(--dim)' }}>×{msg.agentSummary.length}</span>
          </div>
          <div className="cc-result-tree">
            {msg.agentSummary.map((it, i) => <AgentSummaryRow key={i} item={it} />)}
          </div>
        </div>
      </div>
    )
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd extension && npx vitest run src/__tests__/messageview-agent-summary.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: 跑既有 MessageView 测试确认不回归**

Run: `cd extension && npx vitest run src/__tests__/messageview-tool-render.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add extension/src/sidebar/MessageView.tsx extension/src/__tests__/messageview-agent-summary.test.tsx
git commit -m "feat(sidebar): agentSummary card in MessageView

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: §3 App.tsx done 淡出移除 + §4 追加汇总卡 + §5 ✕ abort

**Files:**
- Modify: `extension/src/sidebar/App.tsx`（CHAT_AGENT_DONE 分支 ~465；SubAgentCard ~167；imports）
- Modify: `extension/src/sidebar/index.css`（fade keyframe）

无新单测（React 集成 + setTimeout 调度，靠 helper 已测 + 手动验证）。改完类型检查 + 全量不回归 + 构建。

- [ ] **Step 1: index.css 加 fade-out 动画**

在 `extension/src/sidebar/index.css` 末尾加：

```css
/* Sub-agent card fade-out before removal (App.tsx schedules removal after delay). */
@keyframes agent-fade-out { to { opacity: 0; transform: translateY(-4px); } }
.agent-fading { animation: agent-fade-out .4s ease forwards; }
```

- [ ] **Step 2: App.tsx imports**

在 `App.tsx` 顶部 import 区加：

```ts
import { buildAgentSummary, AGENT_FADE_DELAY_MS, AGENT_FADE_DURATION_MS } from './subagent-ui'
```

确认 `SubAgent` 类型已含 `fading?: boolean`：若无，在 `WorkerRadar.tsx` 的 `SubAgent` interface 加 `fading?: boolean`。

- [ ] **Step 3: SubAgent 类型加 fading 字段**

在 `extension/src/sidebar/WorkerRadar.tsx` 的 `SubAgent` interface（`messages: ChatMessage[]` 后）加：

```ts
  fading?: boolean
```

- [ ] **Step 4: 改 CHAT_AGENT_DONE 分支 — 状态置位 + 调度淡出 + 追加汇总卡**

将 `App.tsx` 现有：

```ts
      } else if (msg.type === 'CHAT_AGENT_DONE') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId ? { ...a, status: msg.status === 'error' ? 'error' : 'done' } : a))
```

替换为：

```ts
      } else if (msg.type === 'CHAT_AGENT_DONE') {
        const agentId = msg.agentId
        const isErr = msg.status === 'error'
        setSubAgents(prev => prev.map(a => a.id === agentId ? { ...a, status: isErr ? 'error' : 'done' } : a))
        // done (not error) cards fade out then get removed; errors stay for review.
        if (!isErr) {
          const fadeAt = window.setTimeout(() => {
            setSubAgents(prev => prev.map(a => a.id === agentId ? { ...a, fading: true } : a))
            const rmAt = window.setTimeout(() => {
              setSubAgents(prev => prev.filter(a => a.id !== agentId))
              agentTimers.current.delete(rmAt)
            }, AGENT_FADE_DURATION_MS)
            agentTimers.current.add(rmAt)
            agentTimers.current.delete(fadeAt)
          }, AGENT_FADE_DELAY_MS)
          agentTimers.current.add(fadeAt)
        }
```

- [ ] **Step 5: 加 agentTimers ref + 清理 + 批次终态追加汇总卡**

在 `App` 组件状态区（`const [subAgents, setSubAgents] = ...` 附近）加：

```ts
  const agentTimers = useRef<Set<number>>(new Set())
```

在卸载/会话切换的清理 effect 中（或新增一个 effect）加定时器清理：

```ts
  useEffect(() => () => {
    agentTimers.current.forEach(id => window.clearTimeout(id))
    agentTimers.current.clear()
  }, [])
```

汇总卡追加：在 `CHAT_AGENT_DONE` 分支末尾（状态置位后）加批次终态检测——当本批所有子 agent 都非 running 时，向 messages 追加一条 agentSummary 消息。用 setSubAgents 回调拿最新快照判断：

```ts
        setSubAgents(prev => {
          const allTerminal = prev.length > 0 && prev.every(a => a.status !== 'running')
          if (allTerminal && !agentSummaryEmitted.current) {
            agentSummaryEmitted.current = true
            const summary = buildAgentSummary(prev)
            setMessages(m => [...m, { role: 'assistant', content: '', agentSummary: summary, ts: Date.now() }])
          }
          return prev
        })
```

加 `agentSummaryEmitted` ref（状态区）：

```ts
  const agentSummaryEmitted = useRef(false)
```

并在 `CHAT_AGENT_SPAWN` 分支重置（新批次开始）：将现有

```ts
      } else if (msg.type === 'CHAT_AGENT_SPAWN') {
        setSubAgents(prev => [...prev, { id: msg.agentId, label: msg.label, task: msg.task, status: 'running', messages: [] }])
```

改为：

```ts
      } else if (msg.type === 'CHAT_AGENT_SPAWN') {
        agentSummaryEmitted.current = false
        setSubAgents(prev => [...prev, { id: msg.agentId, label: msg.label, task: msg.task, status: 'running', messages: [] }])
```

- [ ] **Step 6: SubAgentCard 加 ✕ 取消按钮 + fading class**

将 `App.tsx` `SubAgentCard`（~167）的容器与头部行改为支持 ✕（running 时）+ fading：

```tsx
function SubAgentCard({ agent }: { agent: SubAgent }) {
  const [open, setOpen] = useState(false)
  const mark = agent.status === 'running' ? '▸▸' : agent.status === 'error' ? '✗' : '✓'
  const markCls = agent.status === 'running' ? 'text-amber-400 animate-pulse-dot' : agent.status === 'error' ? 'text-red-400' : 'glow-text'
  const transcript = agent.messages.map(m => m.content).join('')
  const abortAgent = (e: React.MouseEvent) => {
    e.stopPropagation()
    chrome.runtime.sendMessage({ type: 'CHAT_AGENT_ABORT', agentId: agent.id })
  }
  return (
    <div className={`rounded-sm border text-xs${agent.fading ? ' agent-fading' : ''}`} style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-2 px-2 py-1 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span className={markCls}>{mark}</span>
        <span className="glow-text text-[11px]">@{agent.label}</span>
        <span className="truncate flex-1" style={{ color: 'var(--dim)' }}>{agent.task.slice(0, 40)}</span>
        {agent.status === 'running' && (
          <button onClick={abortAgent} title="停止此子 agent" className="px-1 cursor-pointer" style={{ color: 'var(--dim)' }}>✕</button>
        )}
        <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <pre className="px-2 pb-2 text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-y-auto" style={{ color: 'var(--dim)' }}>
          {transcript || '(暂无输出)'}
        </pre>
      )}
    </div>
  )
}
```

确认 `App.tsx` 已 import `React`（用到 `React.MouseEvent`）；若用的是命名 hook 导入，改类型为 `import { ..., type MouseEvent }` 并用 `MouseEvent`。

- [ ] **Step 7: 类型检查**

Run: `cd extension && npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 8: 全量测试不回归**

Run: `cd extension && npx vitest run`
Expected: 全绿

- [ ] **Step 9: 构建**

Run: `cd extension && npm run build`
Expected: 构建成功，无 TS/Vite 错误

- [ ] **Step 10: 提交**

```bash
git add extension/src/sidebar/App.tsx extension/src/sidebar/WorkerRadar.tsx extension/src/sidebar/index.css
git commit -m "feat(sidebar): done fade-out, summary card append, per-worker abort UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 全量验证 + CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md`（侧边栏架构段补一句并行子 agent）

- [ ] **Step 1: 全量测试 + 类型 + 构建**

Run: `cd extension && npx tsc --noEmit && npx vitest run && npm run build`
Expected: 全通过

- [ ] **Step 2: CLAUDE.md 补充**

在 `CLAUDE.md` 提及侧边栏/子 agent 的位置补一句（若有「侧边栏」架构段则就近，否则在扩展架构表后）：

> 侧边栏子 agent（`background/chat-api.ts` `runSubAgent`）是纯 API 内存子对话，`spawn_agent` 并行执行（`Promise.all`），每个 worker 经 `mergedAgentSignal` 可单独取消（`CHAT_AGENT_ABORT`），done 卡片淡出移除，批次终态后父对话内联一张 `agentSummary` 汇总卡。与网页 worker 路线（`AgentRegistry`/WS）是两套独立系统。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: note parallel sidebar sub-agent in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review 结果

**Spec 覆盖：**
- §1 abort 重构 → Task 1（原语）+ Task 2（接入）✓
- §2 并行 → Task 3 ✓
- §3 done 淡出 → Task 4（timing 常量）+ Task 6（调度）✓
- §4 汇总卡 → Task 2（done 带 summary）+ Task 4（构造）+ Task 5（渲染）+ Task 6（追加）✓
- §5 单 worker 取消 → Task 2（cancelled 处理）+ Task 3（handler）+ Task 6（✕ UI）✓
- 测试 → Task 1/4/5 新测 + 各 Task 不回归门 ✓

**类型一致性：**
- `mergedAgentSignal(agentId, outer)` 签名 Task 1 定义、Task 2 调用一致 ✓
- `AgentSummaryItem {label,status,summary,output}` Task 4 定义、Task 5 渲染、Task 6 构造一致 ✓
- `SubAgent.fading` Task 3 加字段、Task 6 用 ✓
- `firstLine`(chat-api) 与 `truncateSummary`(subagent-ui) 都首行截≤60，已在 Task 4 step3 注明差异无害 ✓
- 事件 `CHAT_AGENT_DONE` 新增 `label/summary/output` Task 2 广播、Task 6 消费一致 ✓

**Placeholder 扫描：** 无 TBD/TODO；每个代码 step 给完整代码。Task 3 step2 的「按现有结构对齐」非占位——给了确切分支代码 + 结构适配说明，实现者读一次 handler 即可对齐。

**非目标：** 不动网页 worker、不加并发配置、不做独立面板、不加 radar 取消——计划无相关 task ✓
