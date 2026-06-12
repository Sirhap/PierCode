# Sidebar 子 agent 异步化 + UI 重设计 — 设计

日期: 2026-06-12
状态: 已批准架构 / 待实现

## 背景

sidebar 的 `spawn_agent` 把每个子 agent 跑成一个内存 API 子对话（`runSubAgent` → `runIsolatedConversation`，无 tab）。当前实现有 4 类问题：

1. **同步阻塞**：`handleChatRequest` 在主对话里 `await runSubAgentBatch`，整个 batch 完成前主对话停在 streaming 态 → 输入框被 `handleSend` 的 `if (!text || streaming) return` 锁死。用户派了子 agent 就只能干等，无法继续输入或发别的消息。
2. **内联 spawn 静默丢弃**：`runIsolatedConversation` 用 `partitionSpawnCalls(calls)` 只取 `normal`，若子 agent 的 AI 只输出 spawn_agent（想再派孙 agent），`normal=[]` → 直接 break，spawn 调用无执行、无结果、AI 无反馈 → 子 agent 输出戛然而止，主 agent 收半截结果。
3. **隔离不彻底**：网页 content 颁发的子 agent（`originTabId` 有值）与 sidebar 颁发的（`originTabId` undefined）状态可能串到对方 UI。
4. **UI 弱**：子 agent 状态走 `WorkerRadar`（顶部横向 bar），执行中看不到实时工具调用，无右上角聚合视图。

## 目标

子 agent 真异步：不阻塞主对话、不锁输入、多 spawn 并行；内联 spawn 被拒时给 AI 明确反馈；网页/sidebar 颁发严格隔离；右上角浮标 + 抽屉展示实时状态与工具调用预览，点卡展开完整调用树。

## 架构

### Part 1 — 异步化（核心，其余依赖它）

```
AI 输出 spawn_agent(s)
  → 主对话【立即返回】，不 await batch → streaming=false 解锁输入
  → batch 在后台 Promise.all 并行跑（已有并行）
  → 各子 agent 完成 → 右上角抽屉实时更新
  → 全 batch 完成 → 结果【排队】
  → 主对话【空闲时】(非 streaming 且用户未在输入) 才注入汇总作为新 turn
```

改动要点：
- `handleChatRequest` / `runToolCalls`：spawn 与 normal tool 分离。normal tool 同步执行（不变）；spawn **不 await**，交给一个后台批管理器。
- 主对话在 normal tool 跑完后**立即结束本轮**（broadcast CHAT_DONE，解锁），不等 spawn。
- 后台批管理器：`Promise.all` 跑完整个 batch → 把汇总（`formatToolResults`）放入**注入队列**。
- **注入队列消费**：监听主对话空闲（CHAT_DONE 已发 + 无 in-flight 用户请求）→ 取队列 → 以新一轮 `handleChatRequest`（depth+1，message=汇总）续对话。撞车时排队等空闲，不打断用户。

### Part 2 — 回调容错

- `shapeSubAgentResult` 已是纯文本包装（`output: finalText`，无强格式要求）→ **无需改**。子 agent 的 AI 输出自然文本即可，不依赖固定格式。
- **修内联 spawn 丢弃**：`runIsolatedConversation` 的 1540 行
  ```ts
  const { normal } = partitionSpawnCalls(calls)  // 丢弃 spawns
  if (normal.length === 0) break
  ```
  改为：若 `spawns.length > 0`，给 AI 注入一条工具结果说明「子 agent 不能再派生子 agent（已达嵌套边界），请直接完成任务」，让对话继续到 AI 正常收尾，而非 break 截断。仅当 `normal` 和 `spawns` 都为空才 break。

### Part 3 — 隔离

- `broadcastAgentLifecycle` 已按 `originTabId` 分流（sidebar 走 `broadcast` runtime.sendMessage；网页走 `chrome.tabs.sendMessage(originTabId)`）。
- 强化：sidebar UI 只渲染 `originTabId == null` 的 agent 事件（自己颁发的）；网页 StatusPanel 只渲染自己 tab 的。给 lifecycle 消息带 `origin: 'sidebar' | 'tab'` 标记，UI 据此过滤，避免跨界串台。

### Part 4 — UI 重设计

替换 `WorkerRadar`（顶部 bar）为右上角 **AgentDock**：

- **浮标**（折叠态）：右上角小标「`▸▸ N agents 运行中`」，有运行中 agent 时显示，全完成后浮标淡出。点击展开抽屉。
- **抽屉**（展开态）：浮标下方弹出，列每个活跃 agent：
  - 运行中：`▸▸ <label>` + 当前工具调用预览 `⎿ <tool> <arg…> ●`（● 脉冲）
  - 完成：`✓ <label>` + `完成 · N 工具调用`
  - 错误：`✗ <label>` + 错误摘要
- **点 agent 卡 → 抽屉内展开完整工具调用树**（Claude Code 风格 ⏺/⎿）：该 agent 每个工具调用 + 结果。再点收起。
- 实时数据来源：现有 `CHAT_AGENT_SPAWN`/`CHAT_AGENT_STREAM`/`CHAT_AGENT_DONE`。新增解析 STREAM 里的工具调用以驱动「当前工具预览」与「调用树」。

## 组件/文件

| 文件 | 改动 |
|---|---|
| `chat-api.ts` `runToolCalls`/`handleChatRequest` | spawn 不 await，分离后台批管理 + 注入队列 |
| `chat-api.ts` 新增批管理器 + 注入队列 | 后台跑 batch、空闲注入 |
| `chat-api.ts` `runIsolatedConversation` 1540 | 内联 spawn 拒绝反馈，不静默丢 |
| `chat-api.ts` `broadcastAgentLifecycle` | lifecycle 带 `origin` 标记 |
| `sidebar/AgentDock.tsx`（新） | 右上角浮标 + 抽屉 + 调用树 |
| `sidebar/App.tsx` | 替换 WorkerRadar → AgentDock；输入锁解耦 spawn 期；按 origin 过滤 agent 事件 |
| `sidebar/WorkerRadar.tsx` | 移除（被 AgentDock 取代）或保留 SubAgent 类型 |
| `sidebar/subagent-ui.ts` | 工具调用树解析（从 STREAM 提取工具调用） |

## 错误处理

| 场景 | 处理 |
|---|---|
| 子 agent RGV587/失败 | `runSubAgent` catch → 失败 ToolResult，状态卡显示 ✗，不崩 batch（Promise.all 不 reject） |
| 注入时用户正发新消息 | 排队，等主对话空闲再注入；不打断 |
| 注入队列 + SW 被 kill | 复用现有 recoverable-batch checkpoint 机制 |
| 内联 spawn 被拒 | 给 AI 反馈结果，对话正常收尾 |
| 网页/sidebar 串台 | origin 标记 + UI 过滤 |
| 浮标无活跃 agent | 淡出隐藏（现有 fade 逻辑） |

## 边界（不做）

- 不做「每个 agent 完成就注入」（已定全 batch 汇总注入）。
- 不做注入时机用户配置（YAGNI）。
- 不改 `shapeSubAgentResult` 格式（已是文本，无强格式）。
- 不动网页 worker 路线的 WS `agent_result` 回调（那是另一套）。
- 不改 bx-ua/qwen 直发（已完成的独立工作）。

## 测试

- `chat-api`: 单测 spawn 不阻塞（主对话 CHAT_DONE 在 batch 完成前发出）；注入队列空闲消费；内联 spawn 拒绝反馈。
- `subagent-ui`: 工具调用树解析（从 STREAM 提工具调用）。
- AgentDock: 组件测试浮标显隐、抽屉展开、调用树渲染。
- 手动验收：sidebar 派多个子 agent → 输入框可用 + 右上角浮标实时 + 点卡看调用树 + 全完成后汇总注入对话。

## 风险

- 异步注入队列与现有 recoverable-batch checkpoint 交互需谨慎（两套后台状态）。实现时复用 checkpoint，不另起一套。
- 输入解锁后用户连发多条 → 主对话请求与 spawn 注入的顺序，靠注入队列「空闲才注入」保证不交错。
