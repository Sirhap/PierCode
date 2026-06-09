# 侧边栏子 Agent 增强设计

日期：2026-06-09
状态：设计已批准，待实现

## 背景

PierCode 侧边栏（`extension/src/sidebar/`）通过 API 直连 AI 平台（Qwen/ChatGPT/Claude/OpenAI 兼容），子 agent (`spawn_agent`) 已经是纯 API 实现：`runSubAgent` 在内存里跑一个隔离子对话（`runIsolatedConversation`），不开浏览器 tab，最终文本直接作为父对话的 ToolResult 返回。

这与旧的「网页 worker」路线（`internal/tool/agent_registry.go` + WS `agent_result` + `piercode-agent-result` fence 检测）是**两套并行系统**。网页 worker 服务的是「真 AI 网页当 coordinator 派 worker 到别的 tab」的场景，本设计**不触碰**它。

本设计只增强**侧边栏 API 子 agent**，因为它没有网页 worker 那套坑（Monaco 截断解析、keep-alive shim、WS 路由、URL 迁移丢回调）。

## 现状痛点

| 痛点 | 位置 | 现象 |
|---|---|---|
| 子 agent 串行执行 | `chat-api.ts:872` `for (tc of spawns)` | 一个跑完才下一个，N 个子 agent 总耗时 = 累加 |
| `currentAbort` 单例共享 | `chat-api.ts` 模块级 | 停一个子 agent = 停全部；主对话与子 agent 互绑 |
| done 卡片不消失 | `App.tsx` `subAgents` 数组 | done 永久堆积在列表里 |
| 结果只塞父对话文本 | `chat-api.ts:879` `toolResultContent` | 无单独可回看的汇总视图 |
| 无单 worker 取消 | 只有全局 `currentAbort` | 无法只停一个子 agent |

## 设计决策（已确认）

- **并发上限**：无限制，全部 `spawn_agent` 同时跑。
- **done 收起方式**：done 后 ~2.5s 淡出移除卡片；结果靠汇总卡 + 父对话保留。error 卡片不自动移除。
- **汇总视图位置**：父对话内联一张汇总卡，仿 Claude Code Task 树（⏺/⎿）。
- **取消入口**：running 子 agent 卡片上的 ✕ 按钮。

## §1 AbortController 重构（地基）

参考 Claude Code `src/bridge/capacityWake.ts` 的 signal-merge 原语（合并两个 AbortSignal，任一 fire 即 abort，带 cleanup 移监听）。只借这一个原语，不抄其余 Task/swarm 机制。

`chat-api.ts` 新增模块级 map：

```ts
const agentAborts = new Map<string, AbortController>()

// merge: 全局停 (currentAbort) OR 单独停 (own)，任一 fire 即 abort 子 agent。
function mergedAgentSignal(agentId: string): { signal: AbortSignal; cleanup: () => void } {
  const own = new AbortController()
  agentAborts.set(agentId, own)
  const outer = currentAbort?.signal
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
```

- `runSubAgent`：进入时 `const { signal, cleanup } = mergedAgentSignal(agentId)`，传 signal 给 `runIsolatedConversation`（替换现在的 `currentAbort?.signal`），`finally { cleanup() }`。
- 主对话 `handleChatRequest` 仍用 `currentAbort`，不变。
- 全局停止照旧 `currentAbort.abort()` → merge 自动连带停所有子 agent。

**取舍**：`outer` 在 `mergedAgentSignal` 调用时刻快照 `currentAbort?.signal`。并行子 agent 在同一个父 turn 内启动，此刻 `currentAbort` 已存在且稳定，快照安全。

## §2 并行执行

`chat-api.ts:872` 串行循环改 `Promise.all`：

```ts
// spawn_agent → 并行子对话（无 tab），全部同时跑。
const spawnResults = await Promise.all(
  spawns.map(tc => runSubAgent(tc, platform, modelOverride, depth))
)
for (const r of spawnResults) {
  results.push(r)
  broadcast({ type: 'CHAT_TOOL_DONE', result: r })
}
```

`runSubAgent` 内部已 try/catch 把失败包成 `success:false` 的 ToolResult，从不抛——故 `Promise.all` 不会因单个失败整体 reject，无需 `allSettled`。

`runSubAgent` 已分别广播带 `agentId` 的 `CHAT_AGENT_SPAWN`/`CHAT_AGENT_STREAM`/`CHAT_AGENT_DONE`，并行天然按 agentId 分流，无需改广播。

结果顺序：`Promise.all` 保序，`spawnResults[i]` 对应 `spawns[i]`，汇总卡顺序稳定。

## §3 done 后淡出移除（UI）

`App.tsx` `subAgents` 状态机改动：

- 收到 `CHAT_AGENT_DONE` → 该条状态置 `done`/`error`。
- `done` 条目：~2.5s 后从 `subAgents` 移除。移除前最后 ~400ms 加 `fade-out` CSS class 播淡出。
- `error` 条目：**不自动移除**（保留失败原因），靠汇总卡回看或随会话清空。
- setTimeout 句柄需在组件卸载/会话切换时清理，避免对已移除条目操作。

`index.css` 新增：

```css
@keyframes agent-fade-out { to { opacity: 0; transform: translateY(-4px); } }
.agent-fading { animation: agent-fade-out .4s ease forwards; }
```

## §4 结果汇总卡（UI）

所有子 agent 终态（全部非 running）后，在父对话流插一条汇总消息，仿 Claude Code Task 树：

```
⏺ spawn_agent ×3
  ⎿ @scanner  ✓ 找到 4 处问题…
  ⎿ @fixer    ✓ 修复 3 个文件…
  ⎿ @reviewer ✓ 审查通过…
  [点击展开看各自完整输出]
```

实现：

- `MessageView.tsx` `ChatMessage` 新增可选字段 `agentSummary?: AgentSummaryItem[]`，类型 `{ label: string; status: 'done'|'error'; summary: string; output: string }[]`。
- 当一批 `spawn_agent` 全部终态，`App.tsx` 追加一条 assistant 消息携带 `agentSummary`（与该批 spawn 对应）。
- `MessageView` 渲染分支：有 `agentSummary` 时渲染折叠树。`summary` = 子 agent finalText 首行（截断 ~50 字）；点击行展开看完整 `output`（复用 ToolCard 的 open/pre 模式）。
- 汇总卡不替代父对话里已有的 tool result 文本（那是喂给模型的）；它是给**用户**回看的视图。

「一批」定义：同一个父 turn 的 `partitionSpawnCalls` 产出的 `spawns`。一个父 turn 内的所有 spawn 归为一张汇总卡。

## §5 每 worker 独立取消（UI）

- `WorkerRadar.tsx` 的 `SubAgentCard`（在 `App.tsx`）/ radar 胶囊：`status === 'running'` 时显 ✕ 按钮。本设计按已确认的「卡片上 ✕」实现，radar 胶囊可选不加。
- 点击 ✕ → `chrome.runtime.sendMessage({ type: 'CHAT_AGENT_ABORT', agentId })`。
- background 新增消息处理：`CHAT_AGENT_ABORT` → `agentAborts.get(agentId)?.abort()`（§1 已备 map）。只停这一个，merge 让该子 agent 的 fetch/SSE 中断。
- 被取消的子 agent：`runSubAgent` 的 catch 捕获 abort → status `error`，`runIsolatedConversation` 返回已累积文本或空 → ToolResult 输出标注「(已取消)」。
- ✕ 点击需 `stopPropagation`，避免触发卡片展开/折叠。

## 错误处理

- 子 agent fetch 失败 / 平台报错：`runSubAgent` catch → `success:false` ToolResult，状态 `error`，汇总卡显 ✗ + 错误摘要。
- 单 worker 取消：abort signal 中断 SSE reader（`processSSEStream` 已检查 `abortSignal.aborted`）→ 返回部分文本 → 标注已取消。
- 全局停止：`currentAbort.abort()` 连带 merge 停所有子 agent（§1）。
- `agentAborts` map 必须在每个 `runSubAgent` finally `cleanup()` 删条目，避免泄漏。

## 测试

- `chat-api`（vitest）：
  - `mergedAgentSignal`：own abort 触发 merged；outer abort 触发 merged；cleanup 后 map 无残留。
  - 并行：两个 spawn 同时跑，`Promise.all` 保序返回；单个失败不影响另一个（包成 failed result）。
  - `CHAT_AGENT_ABORT`：abort 指定 agentId 只停该条。
- `MessageView` 渲染：`agentSummary` 折叠树渲染、展开看 output、done/error 标记。
- 现有 chat-api / sidebar 测试不回归。

## 文件触及

| 文件 | 改动 |
|---|---|
| `extension/src/background/chat-api.ts` | §1 `mergedAgentSignal` + `agentAborts` map；§2 `Promise.all`；§5 `CHAT_AGENT_ABORT` 处理 |
| `extension/src/sidebar/App.tsx` | §3 done 淡出移除；§4 汇总卡追加；§5 ✕ 事件发送 |
| `extension/src/sidebar/MessageView.tsx` | §4 `agentSummary` 字段 + 渲染分支 |
| `extension/src/sidebar/WorkerRadar.tsx` / `SubAgentCard` | §5 running 卡片 ✕ 按钮 |
| `extension/src/sidebar/index.css` | §3 fade-out 动画 |
| 测试文件 | chat-api 并行/abort、MessageView 汇总卡 |

## 非目标（YAGNI）

- 不动网页 worker 路线（`AgentRegistry` / WS `agent_result` / `piercode-agent-result`）。
- 不加并发上限配置（已定无限制）。
- 不做独立汇总面板/抽屉（已定父对话内联）。
- 不加 radar 胶囊上的取消入口（已定仅卡片 ✕；如冲突最小可后续补）。
- 不做子 agent 工具调用计数/细粒度进度（保留 running/done/error + 流式 transcript）。
