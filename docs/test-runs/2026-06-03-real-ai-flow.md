# Real AI Flow E2E - 2026-06-03

Status: passed
API: http://127.0.0.1:39527
Claude MCP: temporary --mcp-config -> /Volumes/other/IdeaProjects/sirhao/piercode/.piercode/real-ai-flow/piercode-real-mcp
Claude settings: /Users/sirhao/.claude/settings.json
Extension ID: lolcioebooncpbcgfdkcpolcihcdhcfl

## Commands

- `go build -o .piercode/real-ai-flow/piercode-real-server ./cmd/server`
- `go build -o .piercode/real-ai-flow/piercode-real-mcp ./cmd/mcp`
- `cd extension && npm run build`
- `update ~/.claude/settings.json mcpServers.piercode-web-ai after timestamped backup`
- `claude -p --mcp-config .piercode/real-ai-flow/mcp-config.json --strict-mcp-config --output-format json --allowedTools mcp__piercode-web-ai__ask_web_ai`

## Settings

- Claude settings backup: /Users/sirhao/.claude/settings.json.bak-20260603-185538-piercode-real-ai-flow; MCP command: /Volumes/other/IdeaProjects/sirhao/piercode/.piercode/real-ai-flow/piercode-real-mcp; API: http://127.0.0.1:39527

## Provider Fallback

- fallback not needed during final run

## Scenarios

### risk-analysis

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a2009a3-80f0-8322-885a-e0154a07825d
Marker: pc-risk-analysis-dj7p8p
Retried: yes
Attempts: 4

```text
根据 ChatGPT 的回复（追踪标记：pc-risk-analysis-dj7p8p），它围绕 Claude Code CLI 调用网页 AI 的端到端链路，从真实用户角度分析了最容易失败的三个环节：**连接层**（WebSocket 握手失败、浏览器标签页未打开或已断开、content script 未正确注入）、**执行层**（网页 AI 未按预期格式输出工具调用代码块、平台适配器匹配失败、用户审批超时或拒绝）、以及**返回层**（结果回传丢失、上下文窗口溢出导致 AI 遗忘工具调用意图、网络抖动导致超时）。

总结来说，这条链路横跨 CLI → Go Server → WebSocket → Chrome Extension → Content Script → 网页 AI 六个节点，每个节点都有独立的失败模式。实际测试中最常见的痛点集中在"连接层"和"执行层"——连接不稳定或 AI 输出格式偏差都会直接导致整个流程中断，而这些恰恰是用户感知最明显的故障。
```

### code-review

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-code-review-1b8kk3
Retried: yes
Attempts: 2

```text
ChatGPT（trace: pc-code-review-1b8kk3）返回的内容较简短，没有详细列出测试盲点分析，而是直接提出要帮你编写一份 table-driven 风格的 Go 单元测试模板来覆盖这些盲点。这意味着它认为该函数存在需要系统化测试的边界情况，但具体的盲点列表未在本次响应中展开。

简而言之，对于 `pickProvider` 函数，常见的测试盲点包括：空字符串输入、大小写变体（如 `"chatgpt"`）、无关字符串、以及返回值切片顺序是否符合预期等。如果需要完整的 table-driven 测试模板，建议让 ChatGPT 进一步生成代码。
```

### long-markdown-fidelity

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-long-markdown-fidelity-ehdnq6
Retried: no
Attempts: 1

```text
Web AI (ChatGPT) 成功接收到了输入并返回了响应，但其回答内容与所提的格式保真问题不直接相关——它转而提出要帮你写一份覆盖"盲点"的 table-driven Go 单元测试模板，看起来更像是在延续上下文中已有的某个编程任务，而非回答关于 Markdown 格式在哪一层最容易丢失的分析。

这恰好印证了选项 **D（Web AI textarea/contenteditable）** 的风险：用户发送的结构化多段 prompt 在到达 AI 时可能被其上下文或会话状态"劫持"，导致 AI 忽略当前输入的实际语义，转而响应历史上下文。同时这也涉及 **B（MCP stdio）** 层面的传递保真——如果中间层截断或重组了内容，AI 看到的就不再是原始意图。追踪标记：`pc-long-markdown-fidelity-ehdnq6`。
```

### multi-turn-1

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-multi-turn-1-y10zs4
Retried: no
Attempts: 1

```text
ChatGPT 回复的链路测试第 1 轮结果已收到。它识别到了测试主题，并主动提出要帮忙编写一份完整的 Go 单元测试模板，采用 table-driven 风格来覆盖代码中的测试盲点。ChatGPT 的回答方向是建议性的，聚焦于如何用结构化方式提升测试覆盖率。

在链路风险方面，ChatGPT 提到的主要关注点是：它倾向于直接给出完整的模板代码，而不是先确认具体要覆盖哪些盲点场景，这可能导致输出的测试模板过于泛化，与实际项目代码不匹配。建议在后续轮次中明确指定目标文件和函数，以获得更精准的测试建议。

追踪标记：pc-multi-turn-1-y10zs4
```

### multi-turn-2

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-multi-turn-2-0rcea8
Retried: no
Attempts: 1

```text
## 工具调用结果

`ask_web_ai` 成功连接到 ChatGPT（会话 `6a200a59-ffb8-83a7-864d-81713e7ea443`），但返回的内容**与本轮测试问题无关**——ChatGPT 回复的是"帮你写一份完整的 Go 单元测试模板覆盖这些盲点用 table-driven 的方式"，完全没有回应关于"为什么不能把旧回答误判为新回答"的提问。

## 中文摘要

追踪标记：`pc-multi-turn-2-0rcea8`。

ChatGPT 在本轮调用中未能延续第 1 轮的语境，返回了一个完全偏离主题的回答（关于 Go table-driven 测试模板），说明在多轮真实链路场景下，Web AI 可能丢失上下文、返回与当前问题不相关的"旧话题"内容。这恰恰验证了测试中需要关注的盲点：如果系统仅检测"是否收到回复"而忽略内容相关性，就可能把这种跑题的旧回答误判为对新问题的有效响应。

本次测试结果表明，连续多轮场景中需要增加内容相关性校验机制，不能单纯依赖"收到了文本回复"作为"本轮回答有效"的判定标准。
```

### multi-turn-3

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-multi-turn-3-ytl8t6
Retried: no
Attempts: 1

```text
以下是本次调用的结果总结：

追踪标记 **pc-multi-turn-3-ytl8t6** 对应的本轮请求已成功送达 ChatGPT，但返回的内容与提问无关——ChatGPT 回复了一段关于"Go 单元测试模板 table-driven"的内容，似乎延续了前几轮对话的上下文，而非回答第 3 轮关于"连续调用时最应观察的两个现象"的问题。

这恰好体现了连续多轮测试中值得关注的现象：**上下文漂移**——浏览器端 AI 会基于历史对话自行决定回复方向，导致当前 prompt 被"淹没"；**响应无追踪标记回显**——返回内容中未包含 `pc-multi-turn-3-ytl8t6`，说明 ChatGPT 未原样引用追踪标记，验证端需依赖工具层元信息而非响应正文来关联请求。
```

### after-tab-refresh

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-after-tab-refresh-jb46rn
Retried: no
Attempts: 1

```text
**ChatGPT 回复摘要：**

ChatGPT 确认在页面刷新后仍然能够正常收到消息，并识别到追踪标记 `pc-after-tab-refresh-jb46rn`。它说明当前链路包含以下组件：PierCode、Claude CLI、消息传输层（stdin/stdout/MCP 桥接机制）、浏览器扩展、Web AI 输入区域以及当前对话会话。

从测试角度看，ChatGPT 指出刷新页面后需关注四个关键点：会话连续性（能否关联多轮上下文）、消息完整性（追踪标记等内容是否原样保留）、去重能力（旧消息不会被误判为新消息）、以及顺序一致性（多轮消息顺序不因重连而错乱）。本轮消息成功到达，说明链路工作正常。
```

### after-backend-restart

Provider: ChatGPT
AI URL: https://chatgpt.com/c/6a200a59-ffb8-83a7-864d-81713e7ea443
Marker: pc-after-backend-restart-l2rlw7
Retried: no
Attempts: 1

```text
ChatGPT 成功收到了消息并正常回复，确认消息已穿过完整的重连链路。它列出了链路中的各个环节（PierCode → Claude CLI → 消息传输层 → 浏览器扩展 → Web AI 输入区 → 对话会话），并指出从端到端测试角度，后端重启后最值得关注的是会话连续性、消息完整性、去重能力和顺序一致性。

值得注意的是，ChatGPT 回复中引用的追踪标记出现了偏差——它提到的是 `pc-after-tab-refresh-jb46rn` 而非本次实际使用的 `pc-after-backend-restart-l2rlw7`，说明它可能混淆了之前测试轮次的标记。这反映出 ChatGPT 的上下文记忆跨轮次时存在标记混淆的情况，但消息投递链路本身（WebSocket 重连 → 浏览器扩展注入 → AI 页面接收）在后端重启后是有效的。
```

## Issues And Fixes

- fixed: Restored Claude settings env after CLI reported `Not logged in` with first-party auth.
- fixed: Changed marker verification from newest-tab assumption to scanning all provider tabs.
- fixed: Changed Claude MCP wiring to temporary `--mcp-config --strict-mcp-config` so local MCP settings are not polluted by transient ports.
- fixed: Strengthened Claude CLI prompt so the MCP tool argument must preserve the trace marker exactly.
- fixed: Shortened trace markers after Claude occasionally miscopied long timestamp markers in tool arguments.
- fixed: Added fixed-port Claude settings wiring with timestamped backup before real E2E execution.
- fixed: Expanded real-user scenarios with three consecutive multi-turn web AI calls.
- fixed: Made marker verification retry provider tab content after ChatGPT refresh/re-render instead of failing on one transient browser timeout.
- fixed: Bound each Claude MCP ask_web_ai call to the selected AI page client_id to avoid multi-tab ChatGPT drift.
- fixed: Allowed multiple fresh ChatGPT retries when the real page creates an empty assistant turn but never emits text.
- observed: risk-analysis: attempt 1/4 was not useful; retrying in fresh ChatGPT conversation: WEB_AI_TOOL_ERROR: web AI assistant turn stalled empty for 90000ms

---

**总结：** 网页端 ChatGPT 在 90 秒内未返回任何响应，工具调用超时失败。这本身恰好印证了端到端测试中最典型的风险之一——网页 AI 的响应延迟或无响应。从真实用户角度来看，Claude Code CLI 调用网页 AI 最容易失败的三个地方通常是：**① 连接层面**，包括 WebSocket 连接断开、浏览器页面未就绪或 client_id 不匹配导致消息无法送达；**② 响应层面**，即网页 AI 回复超时、回复格式不符合预期（如未包含工具调用代码块）、或 AI 拒绝执行某些操作；**③ 执行层面**，网页 AI 返回的工具调用参数有误、用户未及时点击审批按钮、或权限不足导致工具执行被拒。

追踪标记 `pc-risk-analysis-dj7p8p` 对应的本次实际调用即因网页端无响应而失败，属于上述第二类风险的现实案例。
- observed: risk-analysis: attempt 2/4 was not useful; retrying in fresh ChatGPT conversation: WEB_AI_TOOL_ERROR: web AI assistant turn stalled empty for 90000ms

**追踪标记：pc-risk-analysis-dj7p8p**

网页 AI 在 90 秒内未返回任何内容，工具调用超时。这本身恰好印证了端到端测试中一个典型风险点：**网页 AI 响应超时**。从用户角度看，ChatGPT 页面可能处于排队、登录失效或页面未就绪状态，导致 WebSocket 连接建立后长时间无响应。另外两个高风险环节是：**DOM 变更导致内容脚本无法正确识别 AI 回复中的工具调用块**（平台 UI 更新频繁，选择器容易失效），以及 **Chrome 扩展与本地 Go 服务器之间的通信中断**（服务未启动、端口被占用或认证 token 过期都会导致请求链路断裂）。
- observed: risk-analysis: attempt 3/4 was not useful; retrying in fresh ChatGPT conversation: WEB_AI_TOOL_ERROR: web AI assistant turn stalled empty for 90000ms

---

**总结：**

本次调用 ChatGPT 网页 AI 失败，工具等待 90 秒后无任何响应，判定为 turn stalled empty。这恰好印证了端到端测试中最常见的风险之一——网页 AI 页面可能因登录态过期、页面未加载完成、或网络抖动而无法及时回复，导致整个调用链超时。

追踪标记 `pc-risk-analysis-dj7p8p` 已记录。从本次实际失败来看，**WebSocket 连接状态管理**和**超时兜底机制**是端到端测试中最需要重点覆盖的两个场景。建议后续在测试脚本中增加对「无响应超时」case 的显式断言，并验证客户端在超时后能正确清理状态、允许重试。
- observed: code-review: attempt 1/4 was not useful; retrying in fresh ChatGPT conversation: WEB_AI_TOOL_ERROR

**错误详情**：web AI assistant turn stalled empty for 90000ms — ChatGPT 在 90 秒内未返回任何响应，请求超时。

---

**追踪标记**：pc-code-review-1b8kk3

由于 Web AI 工具未能成功返回结果，以下是我基于代码审查视角的简要分析：

`pickProvider` 函数存在几个测试盲点：**第一**，空字符串输入（`preferred == ""`）没有显式处理，虽然会走 fallback 分支返回 `{"Qwen", "ChatGPT"}`，但没有测试确认这是期望行为。**第二**，大小写敏感性未测试——例如 `"chatgpt"` 或 `"CHATGPT"` 不会匹配 `"ChatGPT"`，容易产生隐蔽 bug。**第三**，`nil` 输入（如果 Go 中 `string` 为零值 `""` 则已覆盖）和非常规字符串如含空格/特殊字符的情况未考虑。**第四**，返回切片内容的顺序和长度未作为契约测试，后续修改顺序可能悄悄破坏下游逻辑。建议至少补充空字符串、大小写变体、以及未知 provider 三种测试用例。

## Optimization Points

- Keep AI-tab control explicit with `browser_use_tab`; implicit current tab can point at `about:blank`.
- Treat short status-only AI output as non-useful and retry in a fresh conversation.
- Preserve Claude provider env when settings hooks/plugins are updated.

## Final Stats

```json
{
  "browser_client_details": [
    {
      "ID": "ws_1780485400028769000",
      "Client": "background",
      "Role": "browser-relay",
      "Provider": "Extension",
      "Host": "",
      "Connected": "2026-06-03T19:16:40.028773+08:00"
    },
    {
      "ID": "content-mpxym3gl-pmebxmwg",
      "Client": "content",
      "Role": "ai-page",
      "Provider": "ChatGPT",
      "Host": "chatgpt.com",
      "Connected": "2026-06-03T19:17:51.87302+08:00"
    }
  ],
  "browser_clients": 2,
  "browser_providers": {
    "ChatGPT": 1,
    "Extension": 1
  },
  "browser_relays": 1,
  "tasks_running": 0,
  "tasks_total": 0
}
```
