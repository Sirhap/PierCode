# PierCode 双通道整合 + 债务清理方案

> 状态：谋划，未动手。本文档锁定今天 3 个 investigator agent 挖出的真实债务点，
> 串起用户已定的两个决定。配套已有文档：
> [api-intercept-plan.md](api-intercept-plan.md)（SSE 结构化拦截）、
> [agent-architecture-upgrade-plan.md](agent-architecture-upgrade-plan.md)（Claude Code 移植愿景）。

## 用户已定决定

1. **子 agent 转 API**：官网 `spawn_agent` 从跨 tab worker 改走 `runSubAgent`（内存 API 子对话）。
2. **DOM 脆弱债全修**：19 个脆弱点全清 —— **但用结构化收敛修，不打补丁**（见 §3 修法原则）。

## 通道现状（一句话）

- 官网增强（`content/`）：DOM 文本检测 + WS → `/exec`。强项=白嫖网页 UI；弱项=DOM 脆 + 子 agent 跨 tab 烂。
- 侧边 API（`sidebar/` + `background/chat-api.ts`）：直连平台 API（cookie token，**不烧付费 key**）+ 直接 `/exec`。强项=稳；弱项=平台 UI 功能要自造。

两通道共享同一 Go `/exec` + `internal/tool/` 注册表（故意复用）。

---

## §1 子 agent 转 API（主线）

### 关键事实（已核实）
| 事实 | 出处 |
|------|------|
| `runSubAgent` → `runIsolatedConversation`，`Promise.all` 并行，无 tab，现成 | `chat-api.ts:962` / `:915` |
| **不烧 key**：Qwen/ChatGPT/Claude 走 `getCookieToken` 抓登录 cookie session；只 `openai` 兼容用真 key | `chat-api.ts:401-438` |
| `runSubAgent` 目前只被 sidebar 触发，content 无直达路径 → 要新建接缝 | grep 全仓 |
| 官网回结果机制已存在：`injectToolResult(text)`「填输入框+发送」 | `ws-linker.ts:998` |

### 步骤
1. `chat-api.ts` 导出 `runSubAgentBatch(spawns, platform, model, depth)`。
2. content 检测 `spawn_agent` → 不走 WS 开 tab，改 `chrome.runtime.sendMessage({type:'CONTENT_SPAWN_AGENT'})`。
3. `background/index.ts` `onMessage` 加 case → 推 platform → 调 `runSubAgentBatch` → 回 content。
4. content 收结果 → `injectToolResult(formatted)`（格式对齐旧 `<task-notification>`）。
5. **分两 commit**：先加新路双跑验证，再删旧路（`?piercode_agent`、`workerAgentIdByTabId`、WS `agent_result`、worker seed inject、URL 迁移回调）。

### 待决策
- **R2 取消 UI**：官网主 agent 在 DOM，无 sidebar ✕ 卡片。怎么取消子 agent？
- **R3 平台覆盖**：`getAuth` 只覆盖 Qwen/ChatGPT/Claude + openai。gemini/kimi/z/mimo **无 API client** → 子 agent 转 API 只在有 client 的平台可用；其余保留 tab worker 或不支持。降级策略？
- **R4 结果体积**：`injectToolResult` 填官网输入框，过长触发 Monaco 截断（旧痛点）→ 注入前截断/摘要。
- 试点：Qwen 已有 SSE 基建，首发。

### 为何不走裸文本 SSE（推翻"DOM→SSE 求稳"）
历史 commit `0c6273d` 已从 SSE 退回 DOM。旧 SSE 版（`0c6273d~1:injected/index.ts`）patch `window.fetch`
正则抓 `<tool>`，致命伤：无脑读所有流、全局单 buffer 并发污染、`JSON.parse` 4 重兜底、
**SSE 文本=模型生成中半成品（增量/转义/截断），比 DOM 渲染完成的文本更脏**。
结论：换通道不解决文本检测脆弱。真正稳的是**结构化 function_call**（见 api-intercept-plan.md），
官网主对话保持 DOM，只在平台开 function calling 时拦结构化字段。

---

## §2 双通道重复实现（去重，低风险高收益）

`chat-api.ts` 整片重抄了 `parser.ts`，没复用：

| 重复 | 位置 |
|------|------|
| `FENCE_RE` 正则 | `parser.ts:3` ↔ `chat-api.ts:532` |
| JSON 切分 | `parser.ts:11 splitFenceObjects` ↔ `chat-api.ts:537 splitJsonObjects`（同逻辑改名） |
| tool result 格式化 | `chat-api.ts:923` ↔ `chat-api.ts:1076`（自我重复） |

**修**：统一到 `parser.ts` 单一导出，`chat-api.ts` 复用。`/exec` 调用两边各 fetch
（`chat-api.ts:451` 直连 / `ws-linker.ts:262` 经 background）—— 通道不同，**不强行统一**，但格式化层可共享。

---

## §3 DOM 脆弱债全修（19 点 → 结构化收敛）

> **修法原则**：不给每个硬编码选择器打补丁（无底洞），而是结构化收口 —— 一次改完，
> 后续平台改版只动配置不动逻辑。

### A. 硬编码选择器（13 处）→ 集中配置化
`index.ts:1257-1343` 每平台输入框/停止键写死 class/id；`index.ts:2546/2624/2627` Monaco/CodeMirror
提取写死类名。`Mimo :has(svg[viewBox])` 老 Chrome 不支持。
**收敛**：抽 `PLATFORM_SELECTORS` 配置表（每平台一组带 fallback 链），逻辑读表。平台改版=改表项。

### B. 双执行 race → 跨路径 dedup
`index.ts:2544-2662` Phase 0 DOM 提取 + Phase 1 fence 解析对同一 fence 可双触发；
`processed` set 局部于单次 scan，无跨 scan/跨路径去重（`index.ts:2605-2610`、`3015-3030`）。
**收敛**：processed key 提升到响应级稳定 key（复用 `getConversationKey`），DOM observer + 任何检测路径共享同一 set。

### C. 会话门丢首条 → 事件驱动
`index.ts:2258-2273` `activateIfFreshResponse` 靠 `PIERCODE_BACKEND_CONNECTED` 异步竞速，
首条响应可能被当历史丢（memory `session-gating-tool-detection` 记过，**还在**）。
**收敛**：backend 未连时缓冲首条响应容器，连上后回放，而非硬 gate 丢弃。

### D. 魔法数 setTimeout（6+ 处）→ 事件等待
`index.ts:2516`(600ms)、`2563`(300ms)、`505`(800ms)、`516`(500ms 轮询)靠等固定时间。
**收敛**：能等 DOM 事件/MutationObserver 的改事件驱动；必须等的设上限 + 退避，不写死单值。

### E. 全局 batch 状态串响应 → 按响应隔离
`index.ts:2328-2341` `pendingBatch/batchTimer/batchExecuting` 跨响应共享，并发完成互串。
**收敛**：batch 状态按响应容器 key 隔离。

### F. 脆弱正则
`parser.ts:3 FENCE_RE` 闭合 fence 前多空白即不匹配；`index.ts:2585` `!endsWith('}')` 判断
streaming JSON，尾部注释/空白误判。**收敛**：FENCE_RE 容忍尾随空白；完整性判断用括号配平计数而非 endsWith。

---

## 优先级建议（ROI 排序）

1. **§2 parser 去重** — 最低风险，立即做，bug 只修一处。
2. **§1 子 agent 转 API** — 主线，删最多烂代码，需先答 R2/R3。
3. **§3 DOM 全修** — 按 A→F 收敛，每项独立 commit + 测试。
4. （配套）§3 与 agent-architecture-upgrade-plan §3.2「并行只读工具」、Go 后端「只读工具加 Metadata」可并行推进。

## 配套：Go 后端债（来自 investigator，归入当前 refactor 分支收尾）
- 9 处工具仍用 legacy `ctx.BroadcastToClient`（`question.go`/`agent_tools.go`/`browser_tools.go`）未切 `ctx.Client.*` —— 当前 `refactor/tool-context-capability-grouping` 分支迁移做了一半。
- ~40 browser + 9 只读工具无 `Metadata()`，靠 `isReadOnlyToolName` 字符串名单兜底，漏标=丢并发优化。
- `executor.go:109-177` 68 工具手工注册，可表驱动。
