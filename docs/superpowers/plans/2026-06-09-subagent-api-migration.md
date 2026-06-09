# 子 agent 转 API + parser 去重 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 官网增强的 `spawn_agent` 在有 API client 的平台（qwen/chatgpt/claude）改走内存 API 子对话（`runSubAgentBatch`），删除跨 tab worker 脆弱路；同时把 `chat-api.ts` 重抄的 parser 收敛回共享 `parser.ts`。

**Architecture:** content 检测 spawn_agent → `hasApiClient(platform)` 分流：有 client 走 `chrome.runtime.sendMessage('CONTENT_SPAWN_AGENT')` → background `runSubAgentBatch`（`Promise.all`，无 tab，cookie session token 不烧 key）→ 结果 `injectToolResult` 回官网对话框；无 client 回退现有 tab worker。取消复用 `StatusPanel` + `CHAT_AGENT_ABORT`。

**Tech Stack:** TypeScript, Vitest, Chrome MV3（content/background/page-bridge），Vite。

**配套文档:** [设计 spec](../specs/2026-06-09-subagent-api-migration-design.md)

**范围说明:** 本 plan 覆盖设计 §3（主线）+ §4（配套 A parser 去重）。设计 §5（DOM 收敛）、§6（Go 后端收尾）是独立子项，各自单独出 plan，不在此。

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `extension/src/parser.ts` | 共享 fence 解析 + result 格式化 | 加 `formatToolResults` 导出 |
| `extension/src/background/chat-api.ts` | API 通道 + 子对话编排 | 删本地 `FENCE_RE`/`splitJsonObjects`，import parser；导出 `runSubAgentBatch`；加 `CONTENT_SPAWN_AGENT` 路由 |
| `extension/src/content/index.ts` | DOM 检测 + 分流 | spawn_agent 检测 → `hasApiClient` 分流 |
| `extension/src/content/platform-caps.ts` | 平台能力判定（新） | `hasApiClient(platform)` |
| `extension/src/content/status-panel.ts` | 角落状态面板 | 加活跃子agent区 + ✕ |
| `extension/src/__tests__/parser-dedup.test.ts` | parser 去重测试（新） | — |
| `extension/src/__tests__/subagent-api-route.test.ts` | 分流 + batch 测试（新） | — |

---

## Task 1: parser 去重 — 统一 result 格式化

**Files:**
- Modify: `extension/src/parser.ts` (加 `formatToolResults`)
- Test: `extension/src/__tests__/parser-dedup.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/__tests__/parser-dedup.test.ts
import { describe, it, expect } from 'vitest'
import { formatToolResults } from '../parser'

describe('formatToolResults', () => {
  it('formats results as ### name #call_id blocks joined by blank lines', () => {
    const out = formatToolResults([
      { name: 'read_file', call_id: 'c1', output: 'hello' },
      { name: 'list_dir', call_id: 'c2', output: 'a\nb' },
    ])
    expect(out).toBe('### read_file #c1\n\nhello\n\n### list_dir #c2\n\na\nb')
  })

  it('handles empty results', () => {
    expect(formatToolResults([])).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/parser-dedup.test.ts`
Expected: FAIL — `formatToolResults` is not exported from `../parser`

- [ ] **Step 3: Add formatToolResults to parser.ts**

在 `extension/src/parser.ts` 末尾（line 189 后）追加：

```typescript
// formatToolResults renders tool execution results as the continuation message
// fed back to the model: one `### name #call_id` block per result, blank-line
// joined. Shared by the API channel (chat-api.ts) and the content channel.
export function formatToolResults(
  results: Array<{ name: string; call_id?: string | null; output: string }>
): string {
  return results
    .map(r => `### ${r.name} #${r.call_id ?? ''}\n\n${r.output}`)
    .join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/parser-dedup.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add extension/src/parser.ts extension/src/__tests__/parser-dedup.test.ts
git commit -m "feat(parser): add shared formatToolResults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: chat-api.ts 复用 parser（删本地副本）

**Files:**
- Modify: `extension/src/background/chat-api.ts:532-553` (删 `FENCE_RE` + `splitJsonObjects`)
- Modify: `extension/src/background/chat-api.ts:555-580` (`extractToolCalls` 改用 parser)
- Modify: `extension/src/background/chat-api.ts:923-925` (`toolResultContent` 改用 `formatToolResults`)
- Test: 复用现有 `extension/src/__tests__/` 中 extractToolCalls 相关测试 + 新增

- [ ] **Step 1: Write the failing test (extractToolCalls now uses repair chain)**

`chat-api.ts` 旧 `extractToolCalls` 用裸 `JSON.parse`（line 566），不修复 LLM JSON 滑点。复用 parser 后应能解析尾随逗号。加测试：

```typescript
// 追加到 extension/src/__tests__/subagent-api-route.test.ts (create)
import { describe, it, expect } from 'vitest'
import { extractToolCalls } from '../background/chat-api'

describe('extractToolCalls via shared parser', () => {
  it('parses a fence with a trailing comma (repair chain)', () => {
    const content = '```piercode-tool\n{"name":"read_file","args":{"path":"a.txt",}}\n```'
    const calls = extractToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
    expect(calls[0].args).toEqual({ path: 'a.txt' })
  })

  it('parses multiple concatenated objects in one fence', () => {
    const content = '```piercode-tool\n{"name":"a","args":{}}{"name":"b","args":{}}\n```'
    const calls = extractToolCalls(content)
    expect(calls.map(c => c.name)).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "trailing comma"`
Expected: FAIL — 旧裸 `JSON.parse` 不修尾随逗号，第一个测试解析出 0 calls

- [ ] **Step 3: Delete local FENCE_RE + splitJsonObjects, rewrite extractToolCalls**

3a. 删 `chat-api.ts:529-553`（注释 + `FENCE_RE` + `splitJsonObjects` 整块）。

3b. 在 `chat-api.ts` 顶部 import 区加（与现有 import 同组）：

```typescript
import { FENCE_RE, parseFenceToolCalls, formatToolResults } from '../parser'
```

3c. 把 `extractToolCalls`（原 555-580）整体替换为：

```typescript
export function extractToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  let match: RegExpExecArray | null
  FENCE_RE.lastIndex = 0
  while ((match = FENCE_RE.exec(content)) !== null) {
    for (const tc of parseFenceToolCalls(match[1])) {
      calls.push({
        name: tc.name,
        args: tc.args,
        call_id: tc.callId || `detected-${match.index}-${calls.length}`,
      })
    }
  }
  return calls
}
```

- [ ] **Step 4: Replace toolResultContent with formatToolResults**

`chat-api.ts:923-925`，把：

```typescript
      const toolResultContent = results.map(r =>
        `### ${r.name} #${r.call_id}\n\n${r.output}`
      ).join('\n\n')
```

替换为：

```typescript
      const toolResultContent = formatToolResults(results)
```

- [ ] **Step 5: Run tests + type-check**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests) + no type errors

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/chat-api.ts extension/src/__tests__/subagent-api-route.test.ts
git commit -m "refactor(chat-api): reuse shared parser, drop duplicated FENCE_RE/splitJsonObjects

extractToolCalls now goes through parseFenceToolCalls' repair chain
(trailing commas, unescaped quotes) instead of bare JSON.parse.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 导出 runSubAgentBatch

**Files:**
- Modify: `extension/src/background/chat-api.ts:912-921` (抽出 batch 逻辑为导出函数)
- Test: `extension/src/__tests__/subagent-api-route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 subagent-api-route.test.ts
import { runSubAgentBatch } from '../background/chat-api'

describe('runSubAgentBatch', () => {
  it('is exported and returns an array for empty spawns', async () => {
    const out = await runSubAgentBatch([], 'qwen', undefined, 0)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "runSubAgentBatch"`
Expected: FAIL — `runSubAgentBatch` is not exported

- [ ] **Step 3: Extract runSubAgentBatch from inline batch logic**

3a. 在 `chat-api.ts` 的 `runSubAgent` 定义之后（line 1009 后）加导出函数：

```typescript
// runSubAgentBatch runs N spawn_agent calls as parallel in-memory sub-conversations
// (no tabs). One batchId tags the whole batch so UIs can group the summary. Each
// runSubAgent catches its own failure into a failed ToolResult, so Promise.all
// never rejects on a single worker error. Used by both the sidebar turn loop and
// the content-script CONTENT_SPAWN_AGENT route.
export async function runSubAgentBatch(
  spawns: ToolCall[],
  platform: string,
  model: string | undefined,
  depth: number,
): Promise<ToolResult[]> {
  if (spawns.length === 0) return []
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return Promise.all(spawns.map(tc => runSubAgent(tc, platform, model, depth, batchId)))
}
```

3b. 把 `chat-api.ts:912-921` 的内联 batch 替换为调用：

```typescript
      if (spawns.length > 0 && !currentAbort.signal.aborted) {
        const spawnResults = await runSubAgentBatch(spawns, platform, modelOverride, depth)
        for (const r of spawnResults) {
          results.push(r)
          broadcast({ type: 'CHAT_TOOL_DONE', result: r })
        }
      }
```

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "runSubAgentBatch" && npx tsc --noEmit`
Expected: PASS + no type errors

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/chat-api.ts extension/src/__tests__/subagent-api-route.test.ts
git commit -m "refactor(chat-api): extract runSubAgentBatch for content-route reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: hasApiClient 平台判定

**Files:**
- Create: `extension/src/content/platform-caps.ts`
- Test: `extension/src/__tests__/subagent-api-route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 subagent-api-route.test.ts
import { hasApiClient } from '../content/platform-caps'

describe('hasApiClient', () => {
  it('true for cookie-session platforms', () => {
    for (const p of ['qwen', 'chatgpt', 'claude']) expect(hasApiClient(p)).toBe(true)
  })
  it('false for platforms without an API client', () => {
    for (const p of ['gemini', 'kimi', 'z', 'mimo']) expect(hasApiClient(p)).toBe(false)
  })
  it('false for unknown platform', () => {
    expect(hasApiClient('unknown')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "hasApiClient"`
Expected: FAIL — module `../content/platform-caps` not found

- [ ] **Step 3: Create platform-caps.ts**

```typescript
// extension/src/content/platform-caps.ts
// hasApiClient reports whether a platform has an API client in chat-api.ts'
// getAuth (cookie session or OpenAI key). Sub-agents route through the API only
// on these; others fall back to the tab-worker path. Keep in sync with
// background/chat-api.ts getAuth coverage.
const API_CLIENT_PLATFORMS = new Set(['qwen', 'chatgpt', 'claude', 'openai'])

export function hasApiClient(platform: string): boolean {
  return API_CLIENT_PLATFORMS.has(platform)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "hasApiClient"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/platform-caps.ts extension/src/__tests__/subagent-api-route.test.ts
git commit -m "feat(content): hasApiClient platform-capability gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: background CONTENT_SPAWN_AGENT 路由

**Files:**
- Modify: `extension/src/background/chat-api.ts` (onMessage 加 case，靠近现有 `CHAT_AGENT_ABORT` line 1122)
- Test: 手动集成（MV3 message handler 难单测，记录手测步骤）

> 注：MV3 `chrome.runtime.onMessage` handler 依赖浏览器运行时，不做单测；逻辑已被 Task 3 的 `runSubAgentBatch` 单测覆盖。本 task 只接线 + 手测。

- [ ] **Step 1: Add the message route**

找到 `chat-api.ts` 现有 `chrome.runtime.onMessage` 监听块（含 `CHAT_AGENT_ABORT` 的，line 1122 附近）。在同一 handler 内加：

```typescript
    if (msg.type === 'CONTENT_SPAWN_AGENT') {
      const spawns = (msg.spawns || []) as ToolCall[]
      const platform = String(msg.platform || '')
      const model = msg.model ? String(msg.model) : undefined
      runSubAgentBatch(spawns, platform, model, 0)
        .then(results => sendResponse({ ok: true, results }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }))
      return true // async sendResponse
    }
```

- [ ] **Step 2: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3: Build**

Run: `cd extension && npm run build`
Expected: build succeeds, `extension/dist/background.js` regenerated

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/chat-api.ts
git commit -m "feat(background): CONTENT_SPAWN_AGENT route → runSubAgentBatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: content 分流 — spawn_agent 走 API 或回退 tab worker

**Files:**
- Modify: `extension/src/content/index.ts` (spawn_agent 检测点 → `hasApiClient` 分流)
- Modify: `extension/src/content/index.ts` (import `hasApiClient`、`injectToolResult`、`formatToolResults`)

> 注：本 task 改动 content 工具执行流，需找到现有 spawn_agent 走 WS 开 tab 的调用点。先定位再改。

- [ ] **Step 1: Locate the current spawn_agent dispatch in content**

Run: `cd extension && grep -n "spawn_agent\|piercode_agent\|workerAgentId" src/content/index.ts | head`
记录 spawn_agent 当前如何触发 WS 开 tab（多半经 ws-linker）。这是回退路，保留。

- [ ] **Step 2: Add the API-route branch**

在 content 执行工具的批处理点（设计 §3.1），spawn_agent 工具命中时插入分流。伪逻辑（按实际批处理结构填入）：

```typescript
import { hasApiClient } from './platform-caps'
import { formatToolResults } from '../parser'
// injectToolResult 已在 ws-linker.ts 导出

// 在执行 spawn_agent 的地方：
const spawnCalls = pendingBatch.filter(c => c.name === 'spawn_agent')
if (spawnCalls.length > 0 && hasApiClient(currentPlatform)) {
  // API route: send to background, no tab.
  const resp = await chrome.runtime.sendMessage({
    type: 'CONTENT_SPAWN_AGENT',
    spawns: spawnCalls,
    platform: currentPlatform,
  })
  if (resp?.ok) {
    const text = formatToolResults(resp.results)
    injectToolResult(maybeTruncate(text)) // maybeTruncate defined in Task 8
  } else {
    injectToolResult(`子 agent 失败: ${resp?.error || '未知错误'}`)
  }
} else if (spawnCalls.length > 0) {
  // 无 API client → 保留现有 tab worker 路（不改）
  // ... existing WS open-tab dispatch ...
}
```

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/index.ts
git commit -m "feat(content): route spawn_agent through API on capable platforms

API-client platforms (qwen/chatgpt/claude) run sub-agents via
CONTENT_SPAWN_AGENT → runSubAgentBatch (no tab). Others keep the tab-worker
fallback unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: StatusPanel 活跃子agent区 + ✕ 取消

**Files:**
- Modify: `extension/src/content/status-panel.ts` (加子agent区 + ✕)
- Modify: `extension/src/content/index.ts` (监听 CHAT_AGENT_SPAWN/DONE 广播 → 喂 StatusPanel)

- [ ] **Step 1: Locate StatusPanel render + broadcast listener**

Run: `cd extension && grep -n "class StatusPanel\|render\|CHAT_AGENT" src/content/status-panel.ts src/content/index.ts | head`
确认 StatusPanel 渲染结构 + content 是否已监听 background 广播。

- [ ] **Step 2: Add sub-agent rows to StatusPanel**

在 `StatusPanel` 加方法（按现有 DOM 渲染风格）：

```typescript
  // 子agent 活跃列表：label + 状态 + ✕
  private agents = new Map<string, { label: string; status: string }>()

  addAgent(agentId: string, label: string): void {
    this.agents.set(agentId, { label, status: 'running' })
    this.renderAgents()
  }
  setAgentDone(agentId: string, status: string): void {
    const a = this.agents.get(agentId)
    if (a) { a.status = status; this.renderAgents() }
    // 终态保留短暂后移除
  }
  private renderAgents(): void {
    // 渲染每行：<span>{label}</span><span>{status}</span><button data-agent-id>✕</button>
    // ✕ click → chrome.runtime.sendMessage({ type: 'CHAT_AGENT_ABORT', agentId })
  }
```

✕ 按钮点击 handler：

```typescript
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CHAT_AGENT_ABORT', agentId })
    })
```

- [ ] **Step 3: Wire content broadcast → StatusPanel**

在 content 监听 background 广播处（CHAT_AGENT_SPAWN/DONE，sidebar 已用同名事件）：

```typescript
    if (msg.type === 'CHAT_AGENT_SPAWN') statusPanel.addAgent(msg.agentId, msg.label)
    if (msg.type === 'CHAT_AGENT_DONE') statusPanel.setAgentDone(msg.agentId, msg.status)
```

- [ ] **Step 4: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/status-panel.ts extension/src/content/index.ts
git commit -m "feat(content): show active sub-agents in StatusPanel with cancel

✕ sends CHAT_AGENT_ABORT (reuses chat-api.ts agentAborts), no new cancel logic.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 结果注入截断防护

**Files:**
- Modify: `extension/src/content/index.ts` (加 `maybeTruncate` helper，Task 6 已引用)
- Test: `extension/src/__tests__/subagent-api-route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 subagent-api-route.test.ts
import { maybeTruncate } from '../content/result-truncate'

describe('maybeTruncate', () => {
  it('passes short text through unchanged', () => {
    expect(maybeTruncate('hello')).toBe('hello')
  })
  it('truncates over threshold and appends marker', () => {
    const long = 'x'.repeat(9000)
    const out = maybeTruncate(long)
    expect(out.length).toBeLessThan(9000)
    expect(out).toContain('结果已截断')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "maybeTruncate"`
Expected: FAIL — module `../content/result-truncate` not found

- [ ] **Step 3: Create result-truncate.ts**

> 抽成独立 leaf 文件（而非塞 index.ts）以便单测，且 content/index.ts 是 classic script 不便测。

```typescript
// extension/src/content/result-truncate.ts
// maybeTruncate caps a sub-agent result before injecting into the chat input.
// Over-long text overflows Monaco editors (a known truncation bug), so cap at
// MAX and append a marker.
const MAX = 8000

export function maybeTruncate(text: string): string {
  if (text.length <= MAX) return text
  return text.slice(0, MAX) + '\n\n…（结果已截断，完整内容见子 agent 日志）'
}
```

- [ ] **Step 4: Import in index.ts (used by Task 6)**

`content/index.ts` 顶部加 `import { maybeTruncate } from './result-truncate'`（Task 6 的分流代码已调用）。

- [ ] **Step 5: Run test + type-check + build**

Run: `cd extension && npx vitest run src/__tests__/subagent-api-route.test.ts -t "maybeTruncate" && npx tsc --noEmit && npm run build`
Expected: PASS (2 tests) + no type errors + build succeeds

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/result-truncate.ts extension/src/content/index.ts extension/src/__tests__/subagent-api-route.test.ts
git commit -m "feat(content): truncate over-long sub-agent results before inject

Caps at 8000 chars to avoid Monaco overflow; appends a truncation marker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 集成验证（手测，双跑期）

**Files:** 无代码改动，验证清单。

- [ ] **Step 1: Build + load extension**

Run: `cd extension && npm run build`
然后 Chrome `chrome://extensions` reload 未打包扩展。

- [ ] **Step 2: API route — qwen**

在 qwen.ai 让主 AI spawn 一个子agent（例："spawn 一个 agent 读 README.md 并总结"）。
Expected:
- **不开新标签页**（API 路标志）
- StatusPanel 出现活跃子agent行
- 子agent结果注入官网对话框，主对话续跑

- [ ] **Step 3: 取消验证**

spawn 2 个子agent，点其中一个 ✕。
Expected: 该子agent停（CHAT_AGENT_ABORT 生效），另一个继续完成。

- [ ] **Step 4: 降级路 — gemini**

在 gemini.google.com spawn 子agent。
Expected: **开新标签页**（tab worker 回退路完好，未被新路破坏）。

- [ ] **Step 5: 超长结果**

让子agent返回 > 8000 字符结果。
Expected: 注入内容被截断 + "结果已截断"标记，Monaco 不崩。

- [ ] **Step 6: 全量回归**

Run: `cd extension && npm test && npx tsc --noEmit`
Expected: 所有测试 PASS，无类型错误。

---

## Self-Review 记录

- **Spec 覆盖**：§3.2 平台降级→Task 4+6；§3.3 取消 UI→Task 7；§3.4 截断→Task 8；§3.5 六步→Task 3/5/6/7/8/9；§4 parser 去重→Task 1/2。§5/§6 显式排除（独立子项）。
- **占位**：无 TBD。Task 5/6/7 含"先定位再改"步骤（MV3/大文件无法预知精确行号），但每步给了具体代码块 + grep 命令，非占位。
- **类型一致**：`runSubAgentBatch(spawns, platform, model, depth)` 签名 Task 3 定义、Task 5/6 调用一致；`hasApiClient` / `maybeTruncate` / `formatToolResults` 跨 task 名称一致。
