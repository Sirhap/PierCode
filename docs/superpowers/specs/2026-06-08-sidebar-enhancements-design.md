# Sidebar 增强功能补全 — 设计文档

日期：2026-06-08
分支：`fix/bug-audit-20260607`（或新建 feature 分支）

## 背景与定位

PierCode 的侧边栏（`extension/src/sidebar/`，Manifest V3 `side_panel`）是一个**独立 API 聊天端**：

- `background/chat-api.ts` 用浏览器 cookie 认证，直连 AI 平台 API（Qwen / ChatGPT / Claude / OpenAI 兼容），自己跑 SSE 流。
- 自带 React UI 渲染消息（`sidebar/App.tsx`），检测 `piercode-tool` 围栏块，经 Go server `/exec` 自动执行工具，结果递归回注让 AI 继续（`MAX_TOOL_DEPTH=10`）。
- 与 content-script 路线**正交**：content-script 注入 AI 网页 DOM、检测网页里的工具块、人工审批卡；sidebar 不依赖任何 AI 页面 DOM。

本设计把 content-script 的若干增强**移植进 sidebar 这套自带 UI**。因为 sidebar 是独立 Vite entry（ESM 模块，非 MV3 classic content script），可自由 `import` content 目录下的纯函数模块，无 content/index.ts 的「禁 import」限制。

### 现状盘点

| 功能 | 状态 | 文件 |
|---|---|---|
| 初始化 prompt 注入 | ✅ `handleInit` | `sidebar/App.tsx` |
| `/skills` 自动补全 | ✅ Picker | `sidebar/App.tsx` + `Picker.tsx` |
| `@文件` 补全 | ✅ Picker（`/files`） | `sidebar/App.tsx` |
| 工具调用卡片 | ✅ `ToolCard`（自动执行、含危险命令预警、流式输出） | `sidebar/App.tsx` |
| Token 面板 | ⚠️ 仅字符估算 | `sidebar/token-panel.tsx` |
| `@@` agent 补全 | ❌ | — |
| 上下文压缩 | ❌ | — |
| 多 agent（递归子会话） | ❌ | — |
| 会话持久化 / 多会话 | ❌（刷新即丢） | — |

## 四个增量

### 1. Token 面板升级

**问题**：`sidebar/token-panel.tsx` 用纯字符估算（ASCII 0.25 token/字符、非 ASCII 0.67），固定平台系数，footer 写死 `estimate`。精度低、与 content-script 的真实计数不一致。

**方案**：复用 `content/token-meter.ts`（懒加载 `js-tiktoken`，`o200k_base` 给 GPT 系、`cl100k_base` 给 Qwen，平台精度档 `exact`/`approx`/`estimate`）。sidebar 是独立 bundle，dynamic import 正常工作，不受 content classic 脚本限制。tiktoken 未就绪时回退字符估算（功能不降级，仅精度档显示 `estimate`）。

claude-hud 风格增强：
- **精度徽章**：`exact`(绿) / `approx`(黄) / `estimate`(灰)，取 `platformAccuracy(platform, tokenizerState())`，取代写死的 `estimate`。
- **分段进度条**：当前用量 / 阈值，颜色 green<80% / amber 80–99% / red≥100%（保留现有逻辑）。
- **压缩阈值标线**：进度条上标出压缩触发点（来自压缩配置阈值）；接近时小字提示「将自动压缩」（auto 模式）或「可压缩」（confirm 模式）。
- **cost 估算（可选小字）**：按平台每 1M token 粗略单价估算，仅当用量 > 0 显示。单价表内置常量，标注「估算」。

**接口边界**：`TokenPanel` props 增加 `accuracy`（或内部调用 `tokenizerState()`）。tiktoken 加载是异步的，面板需在加载完成后重算——用一个轻量 tick（订阅 token-meter 的 ready 状态，或挂载时 `ensureTiktoken()` 后轮询一次状态翻转）。

**复用 vs 改写**：`token-panel.tsx` 改为调用 `content/token-meter.ts` 的计数函数，删掉本地 `estimateTokens`。平台系数、阈值默认值改为引用 `token-meter.ts` 的 `PLATFORM_TOKEN_FACTOR` 与 `content/qwen-settings.ts` 的 `DEFAULT_PLATFORM_THRESHOLDS`，消除重复常量。

### 2. `@@` Agent 补全

**语义**（已确认）：`/` = 技能，`@` = 文件，`@@` = 子任务 / 活跃 agent 引用。配合第 4 节递归子会话。

**正则顺序坑**：`updateCompletions` 当前用 `@([^\s]*)$` 匹配 `@files`。输入 `@@review` 会先被该正则命中为 `@@review`（query=`@review`），语义错。修复：**在 `@files` 分支之前**加 `@@` 分支，正则 `@@([\w-]*)$`，命中即进 agents 模式、`return`，不落到 files。

```
@@ → Picker(mode='agents')
  items = 活跃子 agent 列表（来自 App 的 subAgents 状态）
        + 预设任务模板（内置："@@review 审查代码"、"@@test 跑测试"、"@@explore 探索代码库" 等）
  选中活跃 agent → 插入 "@<label> " 引用（让主 AI 在后续 spawn_agent 里指定 target）
  选中模板 → 插入子任务指令文本（引导主 AI 输出对应 spawn_agent 工具块）
```

数据源：
- 活跃 agent：sidebar 自己维护的 `subAgents: {id, label, status, ...}[]`（第 4 节产生）。
- 模板：内置常量数组（label + 插入文本）。

`Picker.tsx` 复用，`PickerItem` 已是 `{label, sub?, value}` 通用结构，加 `mode='agents'` 即可。

### 3. 会话持久化 / 多会话

**问题**：`messages` 仅 React state，关 sidebar / 刷新即丢；`chatId`/`lastResponseId`（服务端会话锚点）同样丢，刷新后无法续接服务端会话。

**方案**：

- **当前会话存储**：`chrome.storage.local` key `sidebarSession`，存 `{ id, messages, chatId, lastResponseId, platform, model, ts }`。写入 debounce 300ms（避免流式期间高频写）。
- **恢复**：App 挂载时读回，恢复 `messages` + `chatId` + `lastResponseId`（刷新能续接服务端会话）。
- **多会话列表**（轻量）：key `sidebarSessions` 存元数据数组 `[{ id, title, ts, platform }]`。header 加会话切换下拉（新建 / 切换 / 删除）。`title` 取首条 user 消息前 30 字，无则「新对话」。切换时把当前会话 flush 到 `sidebar_session_<id>` 分键存储，读目标会话。
- **清空按钮**（现有 🗑️）：语义改为「删除当前会话」（清 state + 移除对应 storage key + 从列表移除），删除后切到列表中下一个或新建空会话。

**存储布局**：
- `sidebarSessions` → 元数据数组（轻，常驻）。
- `sidebar_session_<id>` → 单会话全量 `{messages, chatId, lastResponseId, platform, model}`。
- `sidebarActiveSessionId` → 当前活跃会话 id。

**YAGNI**：不做云同步、不做全文搜索、不做会话重命名 UI（title 自动取首条消息即可）。

**接口边界**：抽一个 `sidebar/session-store.ts` 模块封装 load/save/list/delete/switch，App 只调它，不直接散写 storage key。

### 4. 多 agent（递归子会话）

**语义**（已确认）：sidebar 的 `spawn_agent` ≠ content-script 的「开新 AI 网页标签跑 worker」。sidebar 无页面 DOM，改为：用同一 `chat-api` 起一个**独立子会话**（新 chatId + worker prompt + 子任务），子会话结果回注主会话。纯 API，不开标签。

**流程**（`background/chat-api.ts`）：

```
主会话 AI 输出 piercode-tool: spawn_agent {task, label}
  ↓ extractToolCalls 检测（已有）
  ↓ chat-api 本地拦截 name==='spawn_agent'（不转发 server /exec）
  ↓ 起子会话：
      worker_prompt = fetch GET /prompt?profile=worker  （server 已支持 profile 查询参数，
                      见 server.go:383 resolveAIProfile 读 c.Query("profile")）
      子会话首条 message = worker_prompt + "\n\n任务：" + task
      调 handleChatRequest({ platform, message, chatId: 新, parentId: null, depth: depth+1 })
  ↓ 子会话自身也能执行工具（read/write/exec_cmd 等），递归走同一 handleChatRequest，
    depth 受 MAX_TOOL_DEPTH 限
  ↓ 子会话跑到无 piercode-tool（自然结束）→ 提取其最终文本作为结果
  ↓ 把结果作为 tool_result 回注主会话（构造 spawn_agent 的 ToolResult，output=子会话产出）
  ↓ 主会话 AI 继续
```

**并发与防爆**：
- 子会话有独立 `AbortController`（主会话 cancel 时级联 abort 子会话）。
- 复用 `MAX_TOOL_DEPTH` 限制递归层数；额外加 `MAX_AGENT_DEPTH`（子 agent 嵌套层数，建议 2–3）和最大并发子 agent 数，防递归爆炸。
- 子 agent 的 worker prompt 只 fetch 一次并缓存（避免每次 spawn 重打 `/prompt`）。

**UI**（`sidebar/App.tsx`）：
- App 维护 `subAgents: { id, label, task, status: 'running'|'done'|'error', messages: ChatMessage[] }[]`。
- 主消息流里 spawn_agent 工具卡折叠展示子 agent（label + 状态徽章 + 可展开看子对话 messages）。
- 子 agent 完成后状态更新；`@@` 补全（第 2 节）从 `subAgents` 读活跃列表。

**消息通道**：chat-api 新增 broadcast 类型 `CHAT_AGENT_SPAWN` / `CHAT_AGENT_STREAM` / `CHAT_AGENT_DONE`（带 agentId），App 的 streaming listener 增加对应分支，更新 `subAgents`。

**接口边界**：spawn 拦截与子会话编排逻辑放在 chat-api.ts 内一个 `runSubAgent()` 函数，与 `handleChatRequest` 共用底层但状态隔离（独立 chatId/abort/depth）。

## 测试策略

- **Token 面板**：单测 `token-panel` 计数与 content/token-meter 一致；tiktoken 未就绪回退 estimate；精度徽章随状态切换。
- **@@ 补全**：单测 `updateCompletions` 对 `@@`/`@`/`/` 三种前缀分流正确，`@@review` 不误入 files 模式。
- **持久化**：单测 `session-store` load/save/list/delete/switch；mock `chrome.storage.local`。
- **递归子会话**：单测 spawn_agent 拦截 → 子会话编排 → 结果回注；depth/并发上限触发；abort 级联。复用现有 chat-api 测试的 fetch/SSE mock 模式。
- 全量 `npm test`（vitest，注意 vite.config 已钉 `pool:'threads'`，勿改回 forks——会破坏 `js-tiktoken` lazy import 的 vi.mock）。

## 不做（YAGNI）

- 会话云同步 / 跨设备。
- 会话全文搜索、重命名 UI。
- 把 content-script 的「人工审批卡」搬进 sidebar（sidebar 设计是自动执行 + 危险命令预警，已足够；审批是 content 路线特性）。
- 复用 content-script 的标签页 spawn_agent（与 sidebar 自带 API 模型冲突，状态两套）。

## 文件影响清单

| 文件 | 动作 |
|---|---|
| `sidebar/token-panel.tsx` | 改写：调 content/token-meter，删本地估算，加精度徽章/阈值标线/cost |
| `sidebar/App.tsx` | 改：`updateCompletions` 加 `@@` 分支；接 session-store 持久化 + 多会话下拉；subAgents 状态 + 子 agent 工具卡；新增 CHAT_AGENT_* listener 分支 |
| `sidebar/Picker.tsx` | 改：支持 `mode='agents'`（小改，结构已通用） |
| `sidebar/session-store.ts` | 新建：会话持久化封装 |
| `background/chat-api.ts` | 改：spawn_agent 本地拦截 + runSubAgent 递归编排 + CHAT_AGENT_* broadcast；fetch worker prompt 缓存 |
| `sidebar/*.test.ts(x)` | 新建/改：四块的单测 |

## 实现前需确认（实现时核对，非阻塞设计）

- `GET /prompt?profile=worker` 渲染出的 worker prompt 是否适合「无标签 / 纯 API 子会话」语境（worker_append.txt 原本面向标签 worker，可能含 `piercode-agent-result` 回包契约——子会话不需要走那套，结果直接取最终文本即可；必要时 sidebar 用内置精简 worker 指令而非 server 版）。
