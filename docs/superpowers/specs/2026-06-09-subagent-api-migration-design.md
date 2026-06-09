# 设计：官网子 agent 转 API + 双通道债务清理

**日期**：2026-06-09
**状态**：设计已定，待用户审阅 → 进 writing-plans
**配套文档**：[api-intercept-plan.md](../../api-intercept-plan.md)、[agent-architecture-upgrade-plan.md](../../agent-architecture-upgrade-plan.md)、[dual-channel-consolidation-plan.md](../../dual-channel-consolidation-plan.md)

---

## 1. 目标与背景

PierCode 有两条 AI→工具代理通道：

- **官网增强**（`extension/src/content/`）：DOM 文本检测 + WS → Go `/exec`。强项=白嫖网页 UI；弱项=DOM 脆 + 子 agent 跨 tab 烂。
- **侧边 API**（`extension/src/sidebar/` + `background/chat-api.ts`）：直连平台 API（cookie session token，**不烧付费 key**）+ 直接 `/exec`。强项=稳；弱项=平台 UI 功能要自造。

两通道共享同一 Go `/exec` + `internal/tool/` 注册表。

**本设计聚焦一件主线 + 三件配套清理**：

1. **主线**：官网 `spawn_agent` 从跨 tab worker 改走 `runSubAgent`（内存 API 子对话），删除最大一片脆弱代码。
2. **配套 A**：双通道 parser 去重（`chat-api.ts` 整片重抄了 `parser.ts`）。
3. **配套 B**：官网 DOM 19 个脆弱点结构化收敛。
4. **配套 C**：Go 后端 capability-grouping 迁移收尾（当前分支做了一半）。

**非目标**：不把主对话从 DOM 改 API（白嫖 UI 是官网增强唯一价值）；不给无 API client 的平台新造 API client。

---

## 2. 关键事实（已核实，非假设）

| 事实 | 出处 |
|------|------|
| `runSubAgent` → `runIsolatedConversation`，`Promise.all` 并行，无 tab，现成 | `chat-api.ts:962` / `:915` |
| **不烧 key**：Qwen/ChatGPT/Claude 走 `getCookieToken` 抓登录 cookie；只 `openai` 兼容用真 key | `chat-api.ts:401-438` |
| 子 agent 取消信号路现成：`CHAT_AGENT_ABORT` → `agentAborts.get(id).abort()` | `chat-api.ts:1122` |
| 官网状态面板现成：`StatusPanel` 单例 | `content/status-panel.ts:49,246` |
| 官网回结果机制现成：`injectToolResult(text)` 填输入框+发送 | `ws-linker.ts:998` |
| `runSubAgent` 目前只被 sidebar 触发，content 无直达路径 → 新建接缝 | grep 全仓 |
| `chat-api.ts` 重抄 parser，未复用 `parser.ts` | `parser.ts:3,11` ↔ `chat-api.ts:532,537` |

---

## 3. 主线设计：官网子 agent 转 API

### 3.1 数据流

```
官网主对话 AI 输出 spawn_agent piercode-tool 块
  ↓ content 检测（scanText）
content 判断平台是否有 API client（hasApiClient(platform)）
  ├─ 有(qwen/chatgpt/claude) → chrome.runtime.sendMessage({type:'CONTENT_SPAWN_AGENT', spawns, platform})
  │     ↓ background/index.ts onMessage
  │   runSubAgentBatch(spawns, platform, model, depth=0)  // Promise.all，无 tab
  │     ↓ 每个 runSubAgent 广播 CHAT_AGENT_SPAWN / CHAT_AGENT_DONE
  │   StatusPanel 收广播 → 渲染活跃子agent行 + ✕
  │     ↓ 全 batch terminal
  │   结果回 content → injectToolResult(formatted)  // 填官网输入框+发送
  │     ↓ 主对话 AI 读结果续跑
  └─ 无(gemini/kimi/z/mimo) → 回退现有 tab worker 路（ws-linker WS 开 tab）
```

### 3.2 平台降级（R3 已定：保留 tab worker 作降级）

`hasApiClient(platform)` 判定（依据 `getAuth` 覆盖面）：
- `true`：`qwen` / `chatgpt` / `claude`（cookie session）+ `openai`（真 key）。
- `false`：`gemini` / `kimi` / `z` / `mimo` → 回退 tab worker。

**含义**：旧 worker 代码（`?piercode_agent`、`workerAgentIdByTabId`、WS `agent_result`、worker seed inject、URL 迁移回调）**不能全删**，保留为降级路。只在 `hasApiClient` 为 true 的平台**绕过**它。

### 3.3 取消 UI（R2 已定：复用现有状态面板）

- `StatusPanel`（`content/status-panel.ts`）新增「活跃子agent」区：每个子agent一行（label + 状态 + ✕）。
- 数据来源：监听 background 广播的 `CHAT_AGENT_SPAWN` / `CHAT_AGENT_DONE`（sidebar 已用同一套）。
- ✕ 点击 → `chrome.runtime.sendMessage({type:'CHAT_AGENT_ABORT', agentId})` → 复用 `chat-api.ts:1122` 现有 abort，**零新增取消逻辑**。
- 全局停按钮（停主对话）连带停所有子agent：`mergedAgentSignal` 已合并 `currentAbort?.signal`（`chat-api.ts:984`），现成。

### 3.4 结果注入（R4 截断防护）

- 子agent 最终文本经 `injectToolResult` 填官网输入框。
- **过长触发 Monaco 截断**（旧痛点）→ 注入前若 `len > THRESHOLD`（如 8000 字符）做摘要/截断 + "（结果已截断，完整见…）"提示。
- 格式对齐旧 `<task-notification>` 包，主 agent 习惯不变。

### 3.5 实施分步（每步独立 commit + 验证）

1. **导出 batch 入口**：`chat-api.ts` 加 `export runSubAgentBatch(spawns, platform, model, depth)`，内部即现有 `Promise.all(spawns.map(runSubAgent...))`。验证：单测调用返回结果数组。
2. **content 接缝**：`scanText` 检测 spawn_agent → `hasApiClient` 分流。验证：qwen 页面 spawn 走新路（无新 tab），gemini 走旧路（开 tab）。
3. **background 路由**：`index.ts` onMessage 加 `CONTENT_SPAWN_AGENT` case → `runSubAgentBatch` → 回 content。验证：结果正确回传。
4. **状态面板**：`StatusPanel` 加子agent区 + ✕ → `CHAT_AGENT_ABORT`。验证：跑 2 子agent，✕ 停一个，另一个继续。
5. **结果注入 + 截断**：`injectToolResult` 前加长度防护。验证：超长结果不崩 Monaco。
6. **双跑期**：新旧路并存，qwen 灰度验证稳后，再标记 worker 路为"仅降级"（不删，§3.2）。

---

## 4. 配套 A：双通道 parser 去重

`chat-api.ts` 重抄 `parser.ts`：
- `FENCE_RE`（`parser.ts:3` ↔ `chat-api.ts:532`）
- 切分逻辑（`parser.ts:11 splitFenceObjects` ↔ `chat-api.ts:537 splitJsonObjects`，同逻辑改名）
- tool result 格式化（`chat-api.ts:923` ↔ `:1076` 自我重复）

**修**：`parser.ts` 导出统一 `FENCE_RE` + `splitFenceObjects` + `formatToolResult`，`chat-api.ts` import 复用，删本地副本。`/exec` 调用两边通道不同（直连 vs 经 background），**不强行统一**，仅共享解析/格式化层。

**风险**：低。两套逻辑本就该同源；统一后 bug 只修一处。先做（最低风险）。

---

## 5. 配套 B：DOM 脆弱债结构化收敛（19 点）

**原则**：不给每个硬编码选择器打补丁，结构化收口 —— 平台改版只动配置不动逻辑。

| 类 | 点 | 收敛法 |
|----|----|--------|
| A 硬编码选择器(13) | `index.ts:1257-1343`,`2546/2624/2627` | 抽 `PLATFORM_SELECTORS` 配置表（每平台 fallback 链），逻辑读表 |
| B 双执行 race | `index.ts:2544-2662`,`2605-2610`,`3015-3030` | processed key 升到响应级稳定 key（复用 `getConversationKey`），DOM observer + 检测路径共享 set |
| C 会话门丢首条 | `index.ts:2258-2273` | backend 未连时缓冲首条响应容器，连上回放，不硬 gate 丢弃 |
| D 魔法数 setTimeout(6+) | `index.ts:2516/2563/505/516` | 能等 DOM 事件改事件驱动；必须等的设上限+退避 |
| E 全局 batch 串响应 | `index.ts:2328-2341` | batch 状态按响应容器 key 隔离 |
| F 脆弱正则 | `parser.ts:3`,`index.ts:2585` | FENCE_RE 容忍尾随空白；完整性判断用括号配平计数替 endsWith |

每类独立 commit + 测试。A/C 优先（最常崩 + 用户可见）。

---

## 6. 配套 C：Go 后端迁移收尾

当前分支 `refactor/tool-context-capability-grouping` 做了一半：
- 9 处工具仍用 legacy `ctx.BroadcastToClient`（`question.go:79,88,142`、`agent_tools.go:191,198,235,266`、`browser_tools.go:329,378`）→ 切 `ctx.Client.BroadcastToClient`。
- ~40 browser + 9 只读工具无 `Metadata()`，靠 `isReadOnlyToolName` 字符串名单兜底 → 加 `Metadata()` 标 read-only，启用并发。
- `executor.go:109-177` 68 工具手工注册 → 可表驱动（YAGNI，可选，不阻塞）。

与 agent-architecture-upgrade-plan §3.2「并行只读工具」同源，一并推进。

---

## 7. 优先级（ROI）

1. **配套 A**（parser 去重）— 最低风险，立即。
2. **主线**（子agent 转 API）— 删最多烂代码，§3.5 分 6 步。
3. **配套 B**（DOM 收敛）— A/C 类优先。
4. **配套 C**（Go 收尾）— 当前分支顺手收。

---

## 8. 测试策略

- **单测**：`runSubAgentBatch` 返回结果数组；`hasApiClient` 分流判定；`formatToolResult` 统一格式；FENCE_RE 容忍尾随空白。
- **集成**：qwen 页面 spawn → 无新 tab + 结果注入；gemini 页面 spawn → 开 tab（降级路完好）；✕ 取消单个子agent。
- **回归**：旧 tab worker 路在降级平台仍工作（不被新路破坏）。
- **手测**：超长子agent结果不崩 Monaco；DOM 收敛后各平台工具检测正常。
