# PierCode 浏览器操作 Agent 侧边栏（复刻 Claude for Chrome）

**日期**: 2026-06-16
**状态**: 设计草案（待用户评审）
**目标**: 复刻 Anthropic 官方「Claude for Chrome」(扩展 id `fcoeoabgfenejglbffodgkkbkcdhcgfn`) 的核心能力 —— 侧边栏 AI 看页面、自主点击/输入/导航当前及其他网页 —— 但 AI 对话宿主用 **ChatGPT / Qwen 的网页 UI**（不走 API），让网页 AI 输出 PierCode 自有的 `browser_*` 工具来驱动浏览器。

---

## 1. 设计目标与非目标

### 目标
- 侧边栏内嵌一个**可见**的 AI 网页对话界面（iframe 嵌 chatgpt.com / chat.qwen.ai）。
- 用户在侧边栏下自然语言任务（"帮我登录这个站并截图"）。
- AI 通过网页 UI 接收 **任务 + 当前页面快照**，输出 `browser_*` 工具块。
- PierCode 的 content-bridge 读回 AI 回复、解析工具块、经 WS 交给 Go server 的 CDP controller，在**被操作 tab** 执行点击/输入/导航/截图。
- 执行结果 + 新页面快照回注 AI 网页，形成闭环，直到 AI 宣告完成。
- 多个 AI（chatgpt / qwen）各一个常驻 iframe，标签条切换，"挤在一块"。
- 默认 **autopilot**（动作不逐个问），仅高危动作（跨域导航/购买/发送/删除）拦截弹批准。

### 非目标（v1 明确不做）
- **不做 iframe → 真实 tab 降级**（用户决定 v1 iframe-only，赌 DNR 剥头能进）。
- **不动现有 API 子 agent 机制**（`chat-api.ts` 的 `runSubAgent`/`runIsolatedConversation`/`launchSidebarSpawnBatch` 等保持不变；这是独立子系统）。
- 不做 Claude 网页宿主（v1 仅 chatgpt + qwen）。
- 不做被操作页的额外反自动化对抗（边缘 case）。

### 核心约束（来自用户）
- 走**网页界面**，不走 API（绕开 turnstile / bx-ua 签名墙 —— 真 iframe 页面环境天然带签名）。
- 全新侧边栏，**不为兼容旧代码图省事**。
- 最高优先级，做到最好。

---

## 2. 架构总览

### 2.1 两个 tab/frame 分离（决定一切）

| 角色 | 宿主 | 作用 | 通信 |
|------|------|------|------|
| **AI 对话宿主** | 侧边栏内的 **iframe**（chatgpt.com / chat.qwen.ai，DNR 剥 CSP 头） | 网页 AI 在此对话；可见 | content-script 注入 iframe，读回复 + 注入任务 |
| **被操作页** | 用户当前**真实 tab**（或 AI `browser_new_tab` 开的） | CDP attach，执行 click/type/navigate/screenshot | 现有 `browser_*` WS 链路 |

**为什么分离**：被操作页必须是真实 tab 才能 CDP attach；iframe 装不了它。AI 对话宿主用 iframe 是为了"可见 + 网页签名天然过"。两者通信只经 SW 中转，无直接耦合。

### 2.2 核心闭环

```
用户在侧边栏输入任务
  ↓ SIDEBAR → SW: BROWSER_AGENT_TASK
SW 取被操作页快照(a11y 文本 / 可选 screenshot+SoM)
  ↓ SW → AI-iframe content: BROWSER_AGENT_INJECT { task + snapshot }
content 把 (任务 + 快照) 注入 AI 网页 composer 并提交
  ↓ AI 网页生成回复（含 piercode-tool browser_* 块）
content 读回复（listen route tee SSE  或  DOM observe responseSelector）
  ↓ 解析 piercode-tool → content → SW: BROWSER_AGENT_TOOLS
SW: autopilot 直接执行 / 高危弹批准 → execTool(browser_*, args) → Go CDP
  ↓ 执行结果 + 新页面快照
SW → AI-iframe content: 注回结果，循环
  ↓ AI 输出无工具（自然语言"完成"）→ 回合结束
SW → SIDEBAR: BROWSER_AGENT_DONE
```

### 2.3 与现有基础设施的复用关系

**几乎全部基础件已存在**，本设计主要是**重新接线 + 新 UI + 新 prompt**：

| 已有件 | 复用方式 |
|--------|----------|
| `browser/` Go CDP controller + 44 个 `browser_*` 工具 | 直接复用执行层 |
| `api-listen.ts`（页面 fetch tee SSE → 解析 piercode-tool） | 把"在 AI tab 监听"改为"在 AI iframe 监听"——读回复的核心 |
| content-route DOM observe + `extractText` + `responseSelector` | listen 失败时的读回复兜底 |
| `send-fallback.ts` + 现有 composer 注入逻辑 | 注入任务到 AI 网页 composer |
| Multi-AI Hub 的 DNR header-strip（剥 X-Frame/CSP） | iframe 嵌 chatgpt/qwen |
| `hub-iframe-content-script-registration` 动态注册 + `all_frames:true` | content-script 进 iframe |
| `page-bridge` 保活 shim | iframe 后台不被节流 |
| `browser/approval.go` 审批流 | 高危动作拦截 |
| `phantom-cursor.ts` | 动作可视化（可选） |

**新写件**：新侧边栏 UI、浏览器 agent 编排器（SW 端，独立于 `chat-api.ts`）、browser-agent prompt profile、被操作页快照器。

---

## 3. 组件分解

### 3.1 扩展端（`extension/src/`）

#### A. 新侧边栏 UI — `sidebar/`（全新；旧 App.tsx 的 API 聊天逻辑下线，子 agent 引擎不动）

```
sidebar/
  BrowserAgentApp.tsx     # 新主组件（取代旧 App.tsx 的入口角色）
  AiTabBar.tsx            # AI 标签条（chatgpt/qwen 切换 + ＋ 加新 AI）
  AiFrame.tsx             # 单个 AI iframe 容器（常驻，懒挂载，切换只 display 切）
  ActionTimeline.tsx      # 动作时间线（⏺执行/⎿结果/✓✗，autopilot 流）
  ApprovalCard.tsx        # 高危动作批准卡（执行/跳过/全程放行）
  TargetTabBar.tsx        # 被操作页指示器（显示/切换当前控制的 tab）
  TaskInput.tsx           # 任务输入框（▶ 跑 / ■ 停）
  browser-agent-store.ts  # 前端状态（任务/动作流/被操作页/活跃 AI）
```

- **AI iframe 区**：每个 AI 一个 `<iframe>`，`src` = chatgpt.com / chat.qwen.ai。全部常驻（切换不销毁，对话保留），非选中的 `display:none`。
- **动作时间线**：消费 SW 广播的 `BROWSER_AGENT_*` 事件，渲染 AI 调的每个 `browser_*` 动作（名 + 关键参数 + 状态 + 结果摘要）。
- 输入框下task / 停止 / 显示当前被操作 tab + 换 tab 按钮。

#### B. 浏览器 Agent 编排器 — `background/browser-agent.ts`（全新，**独立于 `chat-api.ts`**）

负责整个闭环的 SW 端编排：
- `startBrowserAgentTask(platform, task, targetTabId)` —— 入口。
- 取被操作页快照（调 `browser_snapshot` / `browser_screenshot`+SoM via `execTool`）。
- 经 `BROWSER_AGENT_INJECT` 让 AI iframe content 注入并提交。
- 接 content 回传的 `BROWSER_AGENT_TOOLS`（解析好的 `browser_*` 调用）。
- **autopilot 调度**：只读动作直跑；写动作直跑（autopilot）；高危动作走 `approval` 拦截。
- `execTool(browser_*, args)` → 现有 Go CDP 链路。
- 拼"执行结果 + 新快照"回注 AI iframe，循环。
- 终止条件：AI 回复无工具块 / 用户停止 / 深度上限。
- 广播 `BROWSER_AGENT_SPAWN|TOOL|TOOL_DONE|DONE|ERROR|APPROVAL` 给侧边栏。

> **复用而非重写**：`extractToolCalls`、`processSSEStream`、`PLATFORMS`（取 SSE 解析配置）从 `chat-api.ts` 复用（已 export）；执行走 `execTool`（已存在）。但循环编排是新文件，不塞进 `chat-api.ts`，避免与 API 子 agent 耦合。

#### C. AI-iframe 桥 — `content/browser-agent-bridge.ts`（全新 content 模块）

注入到 AI iframe（chatgpt/qwen）内，负责：
- **注入任务**：接 `BROWSER_AGENT_INJECT`，把文本写进 composer（复用现有 composer 注入 + `dispatchEnterAsSendFallback`），等 enabled 再提交（memory `worker-id-collision-and-send` 教训：等按钮 enabled）。
- **读回复**：优先 listen route（page-bridge tee SSE，已有 `api-listen.ts`）；兜底 DOM observe `responseSelector` + `extractText`（已有）。
- 解析出的 `piercode-tool`（`browser_*`）→ `BROWSER_AGENT_TOOLS` → SW。
- 用 `conversation-scope` 风格的判定确保只处理本 iframe 的回复。

#### D. browser-agent prompt（全新）—— `prompts/browser_agent_append.txt` + profile

新 prompt profile `browser-agent`，告诉网页 AI：
- 你是浏览器操作 agent，通过 `browser_*` 工具操作用户的真实浏览器页面。
- 每轮你会收到「当前页面快照」（带编号的可交互元素 a11y 树，或截图+SoM 编号）。
- 用 `browser_click {ref}` / `browser_type {ref, text}` / `browser_navigate {url}` / `browser_snapshot` / `browser_screenshot` 等操作。
- 一次输出一个 `piercode-tool` 块（或 `browser_batch` 串若干）。
- 操作完等结果 + 新快照再继续；任务完成输出自然语言总结（不带工具块）= 收尾信号。
- 强调：基于快照里**真实存在**的元素编号操作，不臆造。

#### E. manifest / DNR

- DNR 规则剥 chatgpt.com / chat.qwen.ai 的 `X-Frame-Options` + CSP `frame-ancestors`（复用 Hub 规则，扩到这两 host）。
- content_scripts 已 `all_frames:true`；`browser-agent-bridge` 经动态注册进 iframe（Hub 案底，避免整批注册因 host 不匹配被拒）。
- `web_accessible_resources` 含 iframe 需要的资源。

### 3.2 服务端（Go，`internal/`）

- **执行层零改动**：`browser_*` 工具 + CDP controller 直接复用。
- **prompt profile**：`internal/prompt/profile.go` 加 `browser-agent` profile；`prompts/browser_agent_append.txt` 经 `//go:embed` 嵌入。
- 被操作页快照：复用 `browser_snapshot`（a11y 树）/ `browser_screenshot`（截图）/ `browser_mark`（SoM 编号），无需新工具。

---

## 4. 数据流（消息契约）

新增一组 `BROWSER_AGENT_*` runtime 消息（与现有 `CHAT_*` 隔离，不复用，避免串台）：

| 消息 | 方向 | 载荷 | 含义 |
|------|------|------|------|
| `BROWSER_AGENT_TASK` | sidebar→SW | `{platform, task, targetTabId}` | 用户下任务 |
| `BROWSER_AGENT_INJECT` | SW→iframe content | `{prompt}` | 注入 (任务+快照) 到 AI 网页 |
| `BROWSER_AGENT_TOOLS` | iframe content→SW | `{tools: ToolCall[]}` | AI 回复里解析出的 browser_* 调用 |
| `BROWSER_AGENT_TOOL` | SW→sidebar | `{name, args, callId}` | 某动作开始执行（时间线 ⏺） |
| `BROWSER_AGENT_TOOL_DONE` | SW→sidebar | `{callId, output, success}` | 某动作结果（时间线 ⎿ ✓/✗） |
| `BROWSER_AGENT_APPROVAL` | SW→sidebar | `{callId, name, args, risk}` | 高危动作待批准 |
| `BROWSER_AGENT_APPROVAL_ANSWER` | sidebar→SW | `{callId, decision}` | 批准/跳过/全程放行 |
| `BROWSER_AGENT_STREAM` | SW→sidebar | `{chunk}` | AI 回复文本流（可选，预览） |
| `BROWSER_AGENT_DONE` | SW→sidebar | `{}` | 任务回合结束 |
| `BROWSER_AGENT_ERROR` | SW→sidebar | `{error}` | 错误 |
| `BROWSER_AGENT_TARGET` | sidebar↔SW | `{tabId}` | 设/查被操作 tab |

### 快照格式（注入 AI 网页的内容）
```
<page-snapshot url="https://example.com" title="...">
[1] link "首页" → /
[2] button "登录"
[3] textbox "邮箱"
[4] textbox "密码"
...
</page-snapshot>

任务：<用户任务 或 上一步工具结果>
请基于上面快照中的元素编号操作；用 piercode-tool 块输出 browser_* 工具。
```
（截图模式下改为 `browser_screenshot` + `browser_mark` 编号图，附简短文本索引。）

---

## 5. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| chatgpt/qwen 官网改 CSP，iframe 进不去 | 高 | DNR 剥头（Hub 已验证可进）；官网改了需跟进。v1 不做降级（用户决定）。 |
| iframe 内 content-script 注入脆 / TDZ | 中 | 复用 Hub 案底：动态注册 + `queueMicrotask` 避 TDZ（memory `hub-iframe-tdz-crash`）。 |
| 网页发消息签名墙（turnstile/bx-ua） | 低（反而是优势） | 真 iframe 页面环境天然带签名 —— 走 UI 的核心好处。 |
| 同源 iframe sessionStorage 客户端 id 冲突 | 中 | per-document id（memory `worker-id-collision-and-send`）。 |
| AI 网页限流/账号风险（频繁自动发） | 中 | autopilot 但加最小间隔；高危拦截；用户可停。 |
| 截图传图：网页 UI 收图路径复杂 | 中 | 默认 a11y 文本快照；截图+SoM 仅 AI 显式要时，经 composer 附件上传（`attachment-upload.ts` 已有）。 |
| prompt injection（被操作页恶意内容骗 AI） | 中 | 高危动作硬拦截；prompt 里声明"只操作快照真实元素"；跨域导航拦截。 |
| 被操作 tab 关闭/导航中途 | 中 | 编排器检测 tab 存活；快照失败则回报 AI 让其重试/换页。 |

---

## 6. 测试策略

- **单元（vitest）**：
  - `browser-agent.ts` 编排循环：mock `execTool` + mock AI 工具流，验证 注入→执行→回注 闭环、autopilot vs 高危拦截、终止条件、深度上限。
  - 快照格式器：DOM → `<page-snapshot>` 文本。
  - `browser-agent-bridge` 解析：AI 回复文本 → `browser_*` ToolCall（复用 `extractFenceToolCalls` 测法）。
  - 高危分类器：哪些 `browser_*` + args 判高危。
- **Go**：prompt profile 渲染含 browser_agent_append；`browser_*` 工具已有测试，不重测。
- **冒烟**：`scripts/browser-smoke.mjs` 扩展验证 iframe 嵌入 + 一轮闭环（登录态需手动）。
- **手动验收**（PUA 证据要求）：真实 chatgpt iframe 嵌入成功 + 下一个任务跑通一轮 click/screenshot。

---

## 7. 实施分期（供 workflow 编排）

1. **DNR + iframe 嵌入**：剥头规则扩 chatgpt/qwen；`AiFrame.tsx` 能嵌入并显示真实对话界面。（最高风险，先验证）
2. **content-bridge 注入 + 读回复**：iframe 内注入任务 + 提交；listen/DOM 读回 AI 回复并解析 `browser_*`。
3. **browser-agent 编排器**：SW 端闭环，autopilot 调度 + execTool + 回注循环。
4. **快照器 + prompt profile**：被操作页 → `<page-snapshot>`；新 browser-agent prompt。
5. **侧边栏 UI**：AiTabBar / AiFrame / ActionTimeline / ApprovalCard / TargetTabBar / TaskInput。
6. **高危拦截 + 审批卡**：分类器 + ApprovalCard + approval 消息往返。
7. **测试 + 冒烟 + 手动验收**。

> 旧 `App.tsx` 的 API 聊天 UI 在 v1 替换下线（入口改指 `BrowserAgentApp`）。`chat-api.ts` 的子 agent/API 引擎**保留不动**（独立子系统，旧会话与子 agent 仍可用其逻辑）。
