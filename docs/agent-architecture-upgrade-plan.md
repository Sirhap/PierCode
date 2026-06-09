# PierCode Agent 架构升级计划

> 从 Claude Code 源码（513K 行）精读中提取的可移植模式，结合 PierCode 现有架构制定。

## 背景

对 `@anthropic-ai/claude-code` 还原源码进行了两轮 11 个 agent 的深度分析，覆盖架构、安全、代码质量、隐藏功能、性能、工具系统六个维度。从中提取了 10 个可移植到 PierCode 的 AI 智能体架构模式。

PierCode 现有 agent 系统已具备：8 平台派发、Hub iframe 嵌入、推送回调（非轮询）、重复 spawn 检测、递归深度限制、MV3 弹性。在多平台能力和浏览器集成上已领先 Claude Code。

本计划聚焦 Claude Code 中 PierCode 尚不具备的能力：上下文管理、任务抽象、错误级联、质量保障。

---

## 优先级 1：立即执行（零代码改动）

### 1.1 Worker Prompt 优化

**来源**：Claude Code Coordinator Mode 的工具分区设计

**现状**：`prompts/worker_append.txt` 对 worker 行为约束较简略

**改动**：增强 `worker_append.txt`，增加以下约束

- 角色定义：你是一个执行者，不是协调者。不要做架构决策，只执行分配的任务。
- 错误处理：如果任务方向根本性错误（不是小问题），用 `blocked` 状态返回并说明原因，不要硬做。
- 完成标准：完成后立即输出 `piercode-agent-result` 包，不要等待确认，不要多轮对话。
- 文件操作：只操作任务明确要求的文件，不要泛化到相关文件。
- 工具使用：所有本地操作必须通过 `piercode-tool`，不要使用 AI 平台自带的代码执行能力。

**文件**：`prompts/worker_append.txt`

**验证**：spawn 一个 worker 执行复杂任务，观察是否减少偏离和泛化

### 1.2 重复 Spawn 增强

**来源**：PierCode 已有的 `HasActiveWithDescription` 机制

**现状**：只基于 description 文本精确匹配

**改动**：
- 在 `activeRosterSuffix` 中增加 worker 运行时长提示（"已运行 5 分钟"）
- 对 `stopped` 状态的 worker 不计入重复检测（已停止的不算活跃）

**文件**：`internal/tool/agent_tools.go`

---

## 优先级 2：短期执行（1-2 周）

### 2.1 Context Compression 扩展

**来源**：Claude Code 5 层压缩架构（snip → microcompact → context collapse → auto-compact → reactive）

**现状**：`extension/src/content/qwen-context-compress.ts` 只覆盖 qwen+chatgpt

**改动**：

1. **扩展平台覆盖**：在 `COMPRESSION_PLATFORMS` 中添加 claude、gemini、kimi
2. **阈值公式统一**：采用 Claude Code 的 `threshold = contextWindow - 13000` 公式
3. **压缩后恢复**：压缩后重新注入 piercode 工具描述和当前任务上下文
4. **压缩触发模式**：
   - `confirm`（默认）：达到阈值时弹出压缩/跳过卡片
   - `auto`：自动压缩，不询问

**关键文件**：
- `extension/src/content/qwen-context-compress.ts`
- `extension/src/content/qwen-settings.ts`
- `extension/src/content/index.ts`（`COMPRESSION_PLATFORMS`）

**验证**：在各平台上进行长对话，观察压缩是否正确触发和恢复

### 2.2 Agent Result 质量检查

**来源**：Claude Code Stop Hooks 的 post-turn 检查机制

**现状**：`handleAgentResult` 直接存储结果并转发，不检查质量

**改动**：在 `internal/server/server.go` 的 `handleAgentResult` 中增加质量检查

```go
// 当 status == "completed" 时：
// 1. 检查 result 长度（< 50 字符 = 可能敷衍）
// 2. 检查是否有 files_changed（可选）
// 3. 如果质量可疑，在 <task-notification> 中追加提示：
//    "⚠️ worker 返回结果较短，可能未充分完成任务。考虑用 send_to_agent 要求补充。"
```

**文件**：`internal/server/server.go`

**验证**：故意给 worker 一个模糊任务，观察质量检查是否生效

### 2.3 Agent TTL 自动清理增强

**来源**：Claude Code 的 Task evictAfter 机制

**现状**：统一 30 分钟 sweep

**改动**：分状态差异化 TTL

| 状态 | 当前 TTL | 建议 TTL | 原因 |
|------|---------|---------|------|
| pending | 30 分钟 | 5 分钟 | worker 可能没连上 |
| running | 30 分钟 | 60 分钟 | 长任务需要更多时间 |
| completed | 30 分钟 | 30 分钟 | 保持不变 |
| failed | 30 分钟 | 10 分钟 | 失败结果快速清理 |
| stopped | 30 分钟 | 10 分钟 | 已停止的不需要保留 |
| blocked | 30 分钟 | 10 分钟 | 被阻塞的不需要保留 |

同时增加：`pending` 超过 5 分钟自动标记为 `failed`（worker 没连上）。

**文件**：`internal/tool/agent_registry.go`（Sweep 方法）

---

## 优先级 3：中期执行（2-4 周）

### 3.1 Task 抽象层

**来源**：Claude Code 的 Task System（TaskCreate/Get/Update/List/Output/Stop）

**现状**：agent 就是任务，没有更高层的任务概念

**改动**：

1. **新增 `task_id` 参数**到 `spawn_agent`：将 agent 归入 task
2. **新增 `task_list` 工具**：显示所有 task 及其 agent 子树
3. **新增 `task_stop` 工具**：停止 task 下的所有 agent
4. **AgentRegistry 扩展**：增加 `TaskID` 字段到 `AgentRecord`

**数据模型**：

```go
type Task struct {
    ID          string
    Description string
    AgentIDs    []string
    Status      TaskStatus // pending/running/completed/failed
    CreatedAt   time.Time
}
```

**文件**：
- `internal/tool/agent_registry.go`（扩展）
- `internal/tool/agent_tools.go`（新增 task_list, task_stop）
- `internal/executor/executor.go`（注册新工具）

### 3.2 并行只读工具执行

**来源**：Claude Code StreamingToolExecutor 的并发模型（`isConcurrencySafe`）

**现状**：工具执行串行

**改动**：在 `internal/executor/executor.go` 中

1. 检测 AI 响应中的多个 `piercode-tool` 块
2. 如果多个工具都是只读的（`read_file`, `list_dir`, `glob`, `grep`, `web_fetch`），并行执行
3. 如果包含写工具，等待前面的工具完成后串行执行
4. 最大并发数：5

**文件**：`internal/executor/executor.go`

### 3.3 send_to_agent 增强

**来源**：Claude Code 的 SendMessage 上下文复用

**现状**：`send_to_agent` 只发送文本消息

**改动**：
- 增加 `context` 参数：附加上下文说明（"基于你之前的结果"）
- 增加 `files` 参数：引用文件路径列表，worker 可以读取

**文件**：`internal/tool/agent_tools.go`

---

## 优先级 4：长期愿景（1-2 月）

### 4.1 跨会话记忆整合

**来源**：Claude Code Auto-Dream（4 阶段记忆整合）

**改动**：
- task 完成后，自动提取关键经验写入 `.piercode/memory/`
- spawn worker 时自动注入相关记忆
- 记忆格式：`{task_id, summary, lessons, files_involved}`

### 4.2 文件级隔离

**来源**：Claude Code Worktree 隔离

**改动**：
- coordinator 可以声明"我正在改这些文件"
- worker 的 `write_file`/`edit` 工具检查是否与 coordinator 冲突
- 冲突时返回 `blocked` 状态

---

## 不移植的模式（及原因）

| Claude Code 模式 | 不移植原因 |
|-----------------|-----------|
| StreamingToolExecutor 流式执行 | PierCode 不控制 API 调用，无法实现"流式返回 tool_use → 立即启动" |
| Fork subagent（字节级相同请求前缀） | PierCode 不控制 API 请求，无法优化 prompt cache |
| ToolSearch 延迟工具发现 | PierCode 工具数量少（~20），不需要延迟加载 |
| AbortController 链（WeakRef） | Go 的 `context.WithCancel` 天然支持父子传播，不需要 WeakRef |
| Feature flag DCE（86 个编译时 flag） | PierCode 是 Go + TypeScript，不需要 Bun 的 DCE 机制 |

---

## 验证标准

每个阶段完成后，用以下标准验证：

1. **Worker 任务完成率**：相同任务，worker 返回 `completed` 且 result 有意义的比例
2. **Worker 偏离率**：worker 做了任务之外的事情的比例
3. **长对话可用性**：在各 AI 平台上，对话超过 20 轮后是否仍然可用
4. **多 agent 协作效率**：coordinator spawn 3 个 worker 并行执行任务的总耗时

---

## 相关文件索引

| 组件 | 文件 |
|------|------|
| Agent 工具 | `internal/tool/agent_tools.go` |
| Agent 注册表 | `internal/tool/agent_registry.go` |
| Worker Prompt | `prompts/worker_append.txt` |
| 后台任务管理 | `internal/executor/tasks.go` |
| 工具执行器 | `internal/executor/executor.go` |
| WebSocket 管理 | `internal/server/ws.go` |
| 服务端 Agent 处理 | `internal/server/server.go` |
| 上下文压缩 | `extension/src/content/qwen-context-compress.ts` |
| 压缩配置 | `extension/src/content/qwen-settings.ts` |
| 内容脚本 | `extension/src/content/index.ts` |
| Result 解析 | `extension/src/parser.ts` |
| Hub 面板管理 | `extension/src/hub/pane-manager.ts` |

---

## Claude Code 参考文件索引

| 模式 | Claude Code 文件 |
|------|-----------------|
| StreamingToolExecutor | `src/services/tools/StreamingToolExecutor.ts` |
| Coordinator Mode | `src/coordinator/coordinatorMode.ts` |
| AgentTool | `src/tools/AgentTool/AgentTool.tsx` |
| Task System | `src/tasks/types.ts`, `src/tools/TaskCreateTool/` |
| Auto-Dream | `src/services/autoDream/autoDream.ts` |
| Context Compression | `src/services/compact/compact.ts`, `src/services/compact/autoCompact.ts` |
| ToolSearch | `src/tools/ToolSearchTool/ToolSearchTool.ts` |
| Stop Hooks | `src/query/stopHooks.ts` |
| Abort Controller | `src/utils/abortController.ts` |
| Bash Security | `src/tools/BashTool/bashSecurity.ts` |
