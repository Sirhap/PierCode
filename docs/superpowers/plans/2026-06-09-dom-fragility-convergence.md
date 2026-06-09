# DOM 脆弱债结构化收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把官网增强 content 脚本里 6 类 DOM 脆弱债结构化收口——平台改版后只动配置不动逻辑，时序 hack 改事件驱动，全局状态按响应隔离，正则容错加固。

**Architecture:** 现状选择器散在 `if/hostname.includes()` 链中（`index.ts:1257-1343`），抽成 `PLATFORM_SELECTORS` 配置表 + DOM 提取选择器配置化；会话门首条丢失改"未连缓冲回放"；魔法数 setTimeout 抽常量并尽量改事件等待；batch 状态影响最小化（先抽常量，按响应隔离作可选增强）；FENCE_RE 容忍尾随空白，完整性判断用括号配平替 `endsWith('}')`。

**Tech Stack:** TypeScript, Vitest, Chrome MV3 content script。

**配套文档:** [设计 spec §5](../specs/2026-06-09-subagent-api-migration-design.md)

**实施原则:** 结构化收敛，非打补丁。每类独立 commit。A（选择器）/ C（会话门）优先（最常崩 + 用户可见）。

> **重要约束:** `extension/src/content/index.ts` 是 classic content script（无 ES module import，见 memory `content-no-settings-import`）。新增逻辑若需单测，**抽成独立 leaf 文件**（纯函数，无 chrome API），content/index.ts 内联引用其编译产物或同文件复制——优先抽 leaf 单测纯逻辑，DOM 接线手测。

---

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `extension/src/content/platform-selectors.ts` | 平台选择器配置表（新 leaf） | 创建 |
| `extension/src/content/dom-extract-config.ts` | DOM 提取选择器配置（新 leaf） | 创建 |
| `extension/src/content/timing.ts` | 时序常量集中（新 leaf） | 创建 |
| `extension/src/content/json-complete.ts` | JSON 完整性判断（括号配平，新 leaf） | 创建 |
| `extension/src/content/index.ts` | 消费上述配置/常量 | 改若干处 |
| `extension/src/parser.ts` | FENCE_RE 容错 | 改 line 3 |
| `extension/src/__tests__/dom-convergence.test.ts` | leaf 纯函数测试（新） | 创建 |

---

## Task 1: FENCE_RE 容忍尾随空白（F 类，最小）

**Files:**
- Modify: `extension/src/parser.ts:3`
- Test: `extension/src/__tests__/dom-convergence.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/__tests__/dom-convergence.test.ts
import { describe, it, expect } from 'vitest'
import { FENCE_RE } from '../parser'

describe('FENCE_RE tolerates trailing whitespace before closing fence', () => {
  it('matches a fence with spaces/newline before ```', () => {
    const content = '```piercode-tool\n{"name":"a","args":{}}  \n  ```'
    FENCE_RE.lastIndex = 0
    const m = FENCE_RE.exec(content)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('"name":"a"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "trailing whitespace"`
Expected: 视当前正则，可能已部分匹配；若失败则确认需放宽。

> 现状 `parser.ts:3`：`/```(?:piercode-tool|tool)\b[ \t]*\r?\n?([\s\S]*?)```/gi`。`[\s\S]*?` 已能吃尾随空白进 body。本 task 重点是**body 捕获后 trim**已由调用方 `match[1].trim()` 处理——若测试已 PASS，记录为"已满足"并跳到 Step 5 提交注释强化；否则按需放宽闭合前的 `[ \t]*\r?\n?`。

- [ ] **Step 3: (若需) 放宽闭合 fence 前空白**

```typescript
export const FENCE_RE = /```(?:piercode-tool|tool)\b[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?```/gi;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "trailing whitespace"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/parser.ts extension/src/__tests__/dom-convergence.test.ts
git commit -m "fix(parser): FENCE_RE tolerates trailing whitespace before closing fence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: JSON 完整性判断改括号配平（F 类）

**Files:**
- Create: `extension/src/content/json-complete.ts`
- Modify: `extension/src/content/index.ts:2585`, `:2637`（两处 `endsWith('}')`）
- Test: `extension/src/__tests__/dom-convergence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 dom-convergence.test.ts
import { isBalancedJson } from '../content/json-complete'

describe('isBalancedJson', () => {
  it('true for complete object', () => {
    expect(isBalancedJson('{"name":"a","args":{"x":1}}')).toBe(true)
  })
  it('false for truncated object', () => {
    expect(isBalancedJson('{"name":"a","args":{"x":1}')).toBe(false)
  })
  it('ignores braces inside strings', () => {
    expect(isBalancedJson('{"text":"a}b{c"}')).toBe(true)
  })
  it('false for trailing-brace-in-string only', () => {
    expect(isBalancedJson('{"text":"value}')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "isBalancedJson"`
Expected: FAIL — module not found

- [ ] **Step 3: Create json-complete.ts**

```typescript
// extension/src/content/json-complete.ts
// isBalancedJson reports whether a JSON-ish string has balanced top-level braces
// (string-aware). Replaces the over-eager endsWith('}') streaming-completeness
// check, which false-negatives on trailing whitespace and false-positives on a
// `}` that sits inside a string value.
export function isBalancedJson(s: string): boolean {
  const t = s.trim()
  if (!t.startsWith('{')) return false
  let depth = 0, inStr = false, esc = false, sawClose = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) sawClose = true }
  }
  return depth === 0 && sawClose && !inStr
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "isBalancedJson"`
Expected: PASS (4 tests)

- [ ] **Step 5: Replace endsWith checks in index.ts**

content/index.ts 顶部加引用（leaf 编译产物，按现有 leaf 引用方式）。把 `:2585` 和 `:2637` 两处：

```typescript
        if (!codeText.trim().endsWith('}')) {
          if (sourceEl) scheduleSettleRetry(sourceEl);
          continue;
        }
```

替换为：

```typescript
        if (!isBalancedJson(codeText)) {
          if (sourceEl) scheduleSettleRetry(sourceEl);
          continue;
        }
```

- [ ] **Step 6: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no errors, build succeeds

- [ ] **Step 7: Commit**

```bash
git add extension/src/content/json-complete.ts extension/src/content/index.ts extension/src/__tests__/dom-convergence.test.ts
git commit -m "fix(content): balanced-brace JSON completeness over endsWith('}')

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 平台选择器配置表（A 类，最大收益）

**Files:**
- Create: `extension/src/content/platform-selectors.ts`
- Modify: `extension/src/content/index.ts:1257-1343`（散链改读表）
- Test: `extension/src/__tests__/dom-convergence.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 dom-convergence.test.ts
import { PLATFORM_SELECTORS, selectorsForHost } from '../content/platform-selectors'

describe('platform selectors config', () => {
  it('has entries for every supported platform', () => {
    for (const key of ['kimi', 'chatz', 'claude', 'chatgpt', 'gemini', 'qwen', 'mimo', 'aistudio']) {
      expect(PLATFORM_SELECTORS[key]).toBeDefined()
      expect(PLATFORM_SELECTORS[key].editor).toBeTruthy()
    }
  })
  it('resolves host to the right platform config', () => {
    expect(selectorsForHost('chat.qwen.ai')).toBe(PLATFORM_SELECTORS.qwen)
    expect(selectorsForHost('gemini.google.com')).toBe(PLATFORM_SELECTORS.gemini)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "platform selectors"`
Expected: FAIL — module not found

- [ ] **Step 3: Create platform-selectors.ts (从 index.ts:1257-1343 抽真实值)**

```typescript
// extension/src/content/platform-selectors.ts
// PLATFORM_SELECTORS centralizes every per-platform DOM selector that used to be
// scattered across the if/hostname.includes() chain in index.ts. Platform UI
// changes now touch only this table, not detection logic. Each entry mirrors the
// shape index.ts already consumes (editor/sendBtn/stopBtn/fillMethod/responseSelector).
export interface PlatformSelectors {
  editor: string
  sendBtn: string
  stopBtn: string | null
  fillMethod: 'execCommand' | 'value'
  responseSelector: string
}

export const PLATFORM_SELECTORS: Record<string, PlatformSelectors> = {
  kimi: {
    editor: 'div.chat-input-editor[contenteditable="true"]',
    sendBtn: 'div.send-button-container',
    stopBtn: '.send-button-container.stop, .send-button-container[class*="stop"]',
    fillMethod: 'execCommand',
    responseSelector: '.segment-assistant',
  },
  chatz: {
    editor: 'textarea#chat-input',
    sendBtn: 'button#send-message-button',
    stopBtn: 'div[aria-label="停止"] button, div[aria-label="Stop"] button',
    fillMethod: 'value',
    responseSelector: '#response-content-container',
  },
  claude: {
    editor: 'div[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"][aria-label*="Claude"], div.ProseMirror[contenteditable="true"]',
    sendBtn: 'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="发送"]:not([disabled])',
    stopBtn: 'button[aria-label="Stop response"], button[aria-label*="Stop response"]',
    fillMethod: 'execCommand',
    responseSelector: '.font-claude-response',
  },
  chatgpt: {
    editor: 'div#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"][aria-label*="ChatGPT"], textarea[name="prompt-textarea"]',
    sendBtn: 'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="发送"]:not([disabled]), button[aria-label*="提交"]:not([disabled])',
    stopBtn: 'button[data-testid="stop-button"]',
    fillMethod: 'execCommand',
    responseSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]',
  },
  gemini: {
    editor: 'div.ql-editor[contenteditable="true"]',
    sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]',
    stopBtn: 'button[aria-label="停止回答"], button[aria-label*="停止回答"], button[aria-label*="Stop response"], button[aria-label*="Stop generating"]',
    fillMethod: 'execCommand',
    responseSelector: 'model-response, .model-response-text, message-content',
  },
  qwen: {
    editor: [
      'textarea[class*="MessageInput__TextArea"]',
      'textarea.message-input-textarea',
      'textarea[placeholder*="Qwen"]',
      'textarea[placeholder*="Send"]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"]',
    ].join(','),
    sendBtn: [
      'div[class*="MessageInput__Submit"]:not([aria-disabled="true"])',
      'button.send-button:not([disabled])',
      'button[aria-label*="发送"]:not([disabled])',
      'button[aria-label*="Send"]:not([disabled])',
    ].join(','),
    stopBtn: 'button.stop-button:not([disabled]):not(.disabled)',
    fillMethod: 'value',
    responseSelector: '.qwen-chat-message-assistant',
  },
  mimo: {
    editor: 'textarea',
    sendBtn: 'button[data-track-id="home_send_btn"]',
    stopBtn: 'button[data-track-id="home_send_btn"]:has(svg[viewBox="0 0 24 24"])',
    fillMethod: 'value',
    responseSelector: '.markdown-prose',
  },
  aistudio: {
    editor: 'textarea[placeholder*="Start typing a prompt"]',
    sendBtn: 'ms-run-button button.ctrl-enter-submits, button.ctrl-enter-submits.ms-button-primary, button[aria-label*="Run"]',
    stopBtn: null, // AI Studio uses a text-content match handled in index.ts (stopBtnMatch)
    fillMethod: 'value',
    responseSelector: 'ms-chat-turn',
  },
}

// selectorsForHost maps a hostname to its platform config. Mirrors the
// hostname.includes() order index.ts used. Returns aistudio config as default.
export function selectorsForHost(host: string): PlatformSelectors {
  if (host.includes('kimi')) return PLATFORM_SELECTORS.kimi
  if (host.includes('chat.z.ai')) return PLATFORM_SELECTORS.chatz
  if (host.includes('claude.ai')) return PLATFORM_SELECTORS.claude
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return PLATFORM_SELECTORS.chatgpt
  if (host.includes('gemini.google.com')) return PLATFORM_SELECTORS.gemini
  if (host.includes('qwen')) return PLATFORM_SELECTORS.qwen
  if (host.includes('xiaomimimo')) return PLATFORM_SELECTORS.mimo
  return PLATFORM_SELECTORS.aistudio
}
```

> 注：`responseSelector` 原代码有 `adapterSelector || <default>` 逻辑 + AI Studio 的 `stopBtnMatch` 回调。配置表存默认值，`adapterSelector` 覆盖 + `stopBtnMatch` 特例仍由 index.ts 处理（配置表存 `stopBtn:null` 标记走特例）。host 匹配顺序**必须对齐** index.ts 原 `hostname.includes()` 链顺序，避免误匹配。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/dom-convergence.test.ts -t "platform selectors"`
Expected: PASS (2 tests)

- [ ] **Step 5: index.ts 散链改读表**

把 `index.ts:1257-1343` 的 if/hostname 链改为：

```typescript
  const base = selectorsForHost(location.hostname)
  return {
    editor: base.editor,
    sendBtn: base.sendBtn,
    stopBtn: base.stopBtn,
    stopBtnMatch: base.stopBtn === null ? aiStudioStopBtnMatch : undefined, // 保留 AI Studio 特例
    fillMethod: base.fillMethod,
    useObserver: true,
    responseSelector: adapterSelector || base.responseSelector,
  }
```

`aiStudioStopBtnMatch` = 原 `index.ts:1334-1340` 的回调，抽成具名函数。

- [ ] **Step 6: Type-check + build + 手测**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no errors。手测：每平台打开页面，确认输入框/发送/停止仍被正确定位（至少 qwen + claude + gemini）。

- [ ] **Step 7: Commit**

```bash
git add extension/src/content/platform-selectors.ts extension/src/content/index.ts extension/src/__tests__/dom-convergence.test.ts
git commit -m "refactor(content): centralize platform selectors into config table

Selectors that were scattered across the hostname.includes() chain now live in
PLATFORM_SELECTORS; platform UI changes touch only the table.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 会话门首条丢失改缓冲回放（C 类，用户可见）

**Files:**
- Modify: `extension/src/content/index.ts:2258-2279`

> 现状：backend 未连（`!preInitMarked`）时首条响应被 `activateIfFreshResponse` 返回 false 丢弃，靠 `PIERCODE_BACKEND_CONNECTED` 后续补救但有竞速窗口（memory `session-gating-tool-detection`）。收敛：未连时把候选响应容器**缓冲**，连上后回放扫描，而非直接丢。

- [ ] **Step 1: Add a buffer for pre-connection response containers**

`index.ts` 会话门附近加模块级缓冲：

```typescript
// 未与 backend 连接时出现的响应容器，连上后回放扫描，避免首条被当历史丢弃。
const preConnectionBuffer = new Set<Element>()
```

`activateIfFreshResponse`（2258）的 `if (!preInitMarked) return false;` 改为：

```typescript
    if (!preInitMarked) {
      preConnectionBuffer.add(container) // 缓冲，待连接后回放
      return false
    }
```

- [ ] **Step 2: Replay on BACKEND_CONNECTED**

`PIERCODE_BACKEND_CONNECTED` 监听（2275）内，激活会话后回放缓冲：

```typescript
  window.addEventListener('PIERCODE_BACKEND_CONNECTED', () => {
    if (!isResponseSessionActive()) {
      activateResponseSession()
    }
    // 回放连接前缓冲的响应容器，补扫首条可能被丢的工具。
    for (const el of preConnectionBuffer) scheduleScan(el)
    preConnectionBuffer.clear()
  })
```

> `scheduleScan` 为现有扫描入口（确认名：`grep -n "scheduleScan\|function scanNode" src/content/index.ts | head`）。

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: 手测首条不丢**

刷新 qwen 页面后立即发一条会触发工具的 prompt（抢在 backend 连接完成前）。
Expected: 首条响应里的工具仍被检测执行（不再静默丢）。

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/index.ts
git commit -m "fix(content): buffer + replay pre-connection responses, stop dropping first

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 时序常量集中（D 类）

**Files:**
- Create: `extension/src/content/timing.ts`
- Modify: `extension/src/content/index.ts:505, :516, :2563`

> 这三个 setTimeout（800/500/300ms）能改事件驱动的优先改；难改的至少抽成具名常量集中，去掉散落魔法数。本 task 取保守路：抽常量 + 加上限注释；事件驱动改造作后续可选。

- [ ] **Step 1: Create timing.ts**

```typescript
// extension/src/content/timing.ts
// Centralized timing constants. Previously scattered as magic numbers in
// setTimeout calls. Documented so the trade-off (why this delay) is explicit.
export const TIMING = {
  // Wait for the chat editor to hydrate before injecting a large handoff payload.
  HANDOFF_EDITOR_SETTLE_MS: 800,
  // Poll interval while waiting for the Qwen editor element to appear.
  EDITOR_POLL_MS: 500,
  // Re-scan delay after expanding a Qwen Monaco overflow placeholder.
  MONACO_OVERFLOW_RESCAN_MS: 300,
} as const
```

- [ ] **Step 2: Replace magic numbers in index.ts**

- `:505` `setTimeout(resolve, 800)` → `setTimeout(resolve, TIMING.HANDOFF_EDITOR_SETTLE_MS)`
- `:516` `setTimeout(resolve, 500)` → `setTimeout(resolve, TIMING.EDITOR_POLL_MS)`
- `:2563` `setTimeout(() => scheduleScan(sourceEl), 300)` → `setTimeout(() => scheduleScan(sourceEl), TIMING.MONACO_OVERFLOW_RESCAN_MS)`

content/index.ts 顶部引用 `TIMING`（按 leaf 引用方式）。

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/timing.ts extension/src/content/index.ts
git commit -m "refactor(content): centralize timing constants, drop magic numbers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: DOM 提取选择器配置化（A 类延伸）

**Files:**
- Create: `extension/src/content/dom-extract-config.ts`
- Modify: `extension/src/content/index.ts:2546, :2624, :2627`

- [ ] **Step 1: Create dom-extract-config.ts**

```typescript
// extension/src/content/dom-extract-config.ts
// Per-platform DOM selectors for extracting tool-call code blocks from rendered
// messages (Monaco / CodeMirror). Centralized so a platform class rename touches
// only this file.
export const DOM_EXTRACT = {
  qwenToolBlock: 'pre.qwen-markdown-code',
  chatzToolContainer: '.language-piercode-tool, .language-tool',
  codeMirrorContent: '.cm-content',
} as const
```

- [ ] **Step 2: Replace hardcoded selectors in index.ts**

- `:2546` `'pre.qwen-markdown-code'` → `DOM_EXTRACT.qwenToolBlock`
- `:2624` `'.language-piercode-tool, .language-tool'` → `DOM_EXTRACT.chatzToolContainer`
- `:2627` `'.cm-content'` → `DOM_EXTRACT.codeMirrorContent`

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add extension/src/content/dom-extract-config.ts extension/src/content/index.ts
git commit -m "refactor(content): centralize DOM extraction selectors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 全量回归 + 手测

- [ ] **Step 1: Run all tests + type-check + build**

Run: `cd extension && npm test && npx tsc --noEmit && npm run build`
Expected: 全 PASS，无类型错误，build 成功。

- [ ] **Step 2: 多平台手测工具检测**

reload 扩展，在 qwen / claude / gemini / chatgpt 各发一条触发工具的 prompt。
Expected: 工具卡正常渲染 + 执行，选择器配置表/提取配置生效。

- [ ] **Step 3: 首条 + Monaco 溢出回归**

qwen 刷新后立即发工具 prompt（首条不丢）；让 qwen 输出超长工具 JSON 触发 Monaco 溢出（提取仍成功）。

---

## Self-Review 记录

- **Spec 覆盖**：§5 表 A 硬编码选择器→Task 3+6；B 双执行 race→**未含**（见下方说明）；C 会话门→Task 4；D 魔法数→Task 5；E batch 隔离→**未含**（见说明）；F 正则→Task 1+2。
- **未含项说明**：B（双执行 race 跨路径 dedup）和 E（batch 状态按响应隔离）改动深、回归风险高，需先在运行时复现确认竞态，**单独拆 plan**（带复现步骤 + 更重的回归测试），不塞进本批结构化收敛。本 plan 先收口低风险高收益的 A/C/D/F + 提取配置。
- **占位**：Task 3/4 含"grep 确认 scheduleScan/adapterSelector 名"——因 index.ts 大文件具名需实读，但每步给具体代码 + grep 命令，非占位。
- **类型一致**：`isBalancedJson` / `PLATFORM_SELECTORS` / `selectorsForHost` / `TIMING` / `DOM_EXTRACT` 跨 task 名称一致。
- **约束遵守**：所有新逻辑抽 leaf 文件单测，content/index.ts 接线手测（classic script 无法 import，memory `content-no-settings-import`）。
