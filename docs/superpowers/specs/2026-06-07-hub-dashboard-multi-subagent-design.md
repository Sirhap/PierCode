# Hub 数据看板 + 多子 Agent — 设计

日期：2026-06-07
分支：dev

## 目标

在「多 AI 工作台」（Hub，`extension/src/hub/`）里增加一个 **agent 数据看板**，并支持 **多子 agent 同屏运行**：协调者 AI 调 `spawn_agent` 时，worker 直接作为一个 Hub pane 注入工作台，多个子 agent 并排在同一前台标签页里运行（不被后台节流），看板实时显示所有 agent 的生命周期状态与最近回复。

## 背景（现状）

- `AgentRegistry`（`internal/tool/agent_registry.go`）已存每个 worker 的完整状态：`Status`、`Platform`、`Description`、`Task`、`CreatedAt/BoundAt/EndedAt`、`LastResult`、`LastAIResponse`、`LastDebug`。`List(dispatcherClientID)` 返回 `AgentSummary` JSON。
- `spawn_agent`（`internal/tool/agent_tools.go`）当前用 `ctx.Browser.NewTab()` 开**独立 Chrome 标签页**当 worker，worker 各自散落，不在 Hub 里。
- Hub pane 结构已支持 worker：`paneSrc(pane)` 在 `agentId` 存在时给 iframe src 追加 `?piercode_agent=<id>`，worker content 脚本会自绑定（现有链路）。
- WS 层（`internal/server/ws.go`）有 `SendToRole(role,msg)`、`RoleCount(role)`、`SendToID(id,msg)`、`Broadcast(msg)`。client `role` 来自 `/ws?role=` 握手参数。
- **没有** `/agents` HTTP 路由；Hub 页面**还没有**自己的 WS 连接。
- 工作台 iframe 工具检测的注册 bug 已在本分支修复（见 memory `hub-iframe-content-script-registration`）。

## 架构总览

```
spawn_agent (Go)                       Hub page (role=hub WS client)
  │ rec := Agents.Create(...)            │
  │ HubOnline()? ── yes ──► Broadcast(hub_add_pane{agent_id,platform,description})
  │                                       │  收到 → addPane(worker) → iframe ?piercode_agent
  │                                       │  worker content 自绑定（现有链路）→ 看板转 running
  └─ no ──► Browser.NewTab(...)           │  （回退：Hub 未开则开独立 tab，行为同现状）

Dashboard 侧栏（Hub 内 React 组件）
  ├─ 首屏 + 容错：GET /agents 轮询(1.5s)   ──► AgentRegistry.List("")
  └─ 实时增量：WS agents_update 推送        ──► registry 状态变更汇聚点广播
  交互：点击聚焦 pane / 状态统计卡 / 停止·重试 / 展开看 last_ai_response·debug
```

四块改动，复用现有 registry + WS + worker pane 链路，不动 Go 沙箱执行层。

## 组件与边界

### Go server

1. **`GET /agents`**（`internal/server/server.go`）：只读，复用现有 Bearer 鉴权中间件。Handler：`c.JSON(200, gin.H{"agents": s.executor.Agents().List("")})`。空 dispatcher = 全部。

2. **`broadcastAgentsUpdate()`**（server 方法，新增）：序列化 `{type:"agents_update", agents:[...AgentSummary]}` → `wsManager.SendToRole("hub", payload)`。调用点（汇聚，不是每个 setter 加回调）：
   - worker bind（`handleWS` 绑定 worker 后）
   - `agent_result` 处理后
   - `agent_control` 处理后（停止/重试）
   - `worker-inject-debug` / `ai_log` 记录后（已是 WS 消息处理点）
   YAGNI：一组已有的 WS 消息处理点统一调一次，不引入 registry→server 反向回调。

3. **`spawn_agent` 改造**（`internal/tool/agent_tools.go`）：
   ```
   rec := ctx.Agents.Create(...)
   workerURL, _ := resolvePlatformURL(platform, rec.AgentID)   // 仅回退路径用
   if ctx.HubOnline != nil && ctx.HubOnline() {
       ctx.BroadcastHubAddPane(rec.AgentID, platform, desc)     // 推 hub_add_pane
       return "Dispatched worker <id> into the Hub workspace ..." 
   }
   tab, err := ctx.Browser.NewTab(ctx.Context, workerURL)       // 回退现状
   ...
   ```
   - `Context`（`internal/tool/tool.go`）新增两个回调字段：`HubOnline func() bool` 与 `BroadcastHubAddPane func(agentID, platform, description string)`。executor 接线到 `wsManager.RoleCount("hub")>0` 与 `SendToRole("hub", hub_add_pane{...})`。
   - **不等 ack**：推完即返回。worker iframe 几秒内自绑定，bind 时广播 `agents_update`，看板自然从 pending→running。若 Hub 收到 `hub_add_pane` 但 worker 始终不 bind（极少），看板停在 pending，用户可手动停止——不引入复杂的 ack 超时回退（YAGNI；回退仅针对「Hub 根本没开」这个确定可测的情况）。

4. **`agent_control` WS 消息**（`internal/server/server.go` `handleWSClientMessage`）：Hub→server 的写操作，信道已在 `/ws?token=` 握手鉴权。
   - `{type:"agent_control", action:"stop", agent_id}` → `Agents.SetStatus(id, AgentStopped)` + 广播 `agents_update`。（不强制关 worker tab/pane —— pane 关闭由 Hub UI 的 ✕ 负责；停止只标状态。）
   - `{type:"agent_control", action:"retry", agent_id}` → 取 `rec.WorkerClientID` 与 `rec.Task`，`SendToID(workerClientID, inject{text:task, await_ready:true})` 重发任务；状态回 running；广播。worker 未绑定则忽略并回一条 user_log 诊断。

### 前端（`extension/src/hub/`）

- **`hub/dashboard/agent-store.ts`** — 纯状态容器（无 DOM/chrome/React）。
  - `mergeSummaries(prev, summaries): AgentVM[]` 用 `agent_id` 去重合并（轮询全量 + WS 增量都走它）。
  - `computeStats(vms): {total,running,pending,completed,failed,blocked,stopped}`。
  - `sortAgents(vms)`：running/pending 在前，按 createdAt 倒序。
  - **可单测**，照 `frame-unlock.test.ts` 套路。

- **`hub/dashboard/hub-ws.ts`** — Hub 的 `role=hub` WS 客户端。薄包装：读 `chrome.storage.local` 的 apiUrl/token，连 `/ws?role=hub&client=hub&id=<hubClientId>`，收 `hub_add_pane`/`agents_update` 派发回调，断线重连（复用 ws-linker 的重连思路，但独立实现，不 import content 模块）。暴露 `sendAgentControl(action, agentId)`。

- **`hub/dashboard/Dashboard.tsx`** — React 侧栏：顶部统计卡（计数）、agent 列表（行：平台徽标/描述/状态徽标/运行时长）、行交互（点击聚焦、停止▣、重试↻、展开▾看 last_ai_response·last_debug·result）。从 store 渲染，纯展示 + 回调向上。

- **`hub/App.tsx`** 接线：
  - 挂 `hub-ws`：收 `hub_add_pane{agent_id,platform}` → `addPane(panes, providerIdFor(platform), agent_id)`；收 `agents_update` → 更新 store。
  - 起 `/agents` 轮询（1.5s）灌 store（首屏 + WS 容错）。
  - 渲染 `<Dashboard panes store onFocusPane onStop onRetry />`。
  - `onFocusPane(agentId)`：找到 `key===providerId+":"+agentId` 的 pane DOM，`scrollIntoView` + 临时高亮 class。

- **`platform→providerId` 映射**：spawn 的 platform 名（qwen/chatgpt/claude/gemini/kimi/z.ai/aistudio/mimo）映射到 Hub `PROVIDERS` 的 id。pane-manager 加 `providerIdForPlatform(platform): string|undefined`（未知平台不加 pane，记一条警告）。注意 `z.ai`→`chatz`、`aistudio`/`mimo` 当前不在 Hub PROVIDERS catalog —— 这些平台 spawn 时 Hub 无法承载，回退开独立 tab（spawn_agent 端无法预知 Hub catalog，由 Hub 端收到 hub_add_pane 后若映射不到 provider 则忽略；server 端此时已不会再开 tab —— 见下「未覆盖平台」）。

### 未覆盖平台的处理

`spawn_agent` 的 platform 全集 ⊋ Hub catalog（Hub 暂无 aistudio/mimo）。为避免「Hub 在线但平台不在 catalog → 既没开 tab 又没加 pane → worker 丢失」：
- `spawn_agent` 端只对 **Hub catalog 覆盖的平台**走 hub_add_pane 路径；其余平台即使 Hub 在线也回退 NewTab。
- 实现：在 Go 侧维护一个 `hubEmbeddablePlatforms` 集合（与 Hub `PROVIDERS` 的平台子集保持一致：qwen/chatgpt/claude/gemini/kimi/z.ai），`spawn_agent` 判 `HubOnline() && hubEmbeddable(platform)` 才推 pane。
- 这个集合与前端 catalog 的一致性加注释互指（类似 frame-unlock AI_FRAME_HOSTS ↔ manifest 的约定）。

## 数据流

1. 协调者 AI（某个 Hub pane 或独立 tab）输出 `spawn_agent` 工具调用 → content 执行 → POST `/exec`。
2. `spawn_agent.execute`：Create 记录；Hub 在线且平台可嵌 → `SendToRole("hub", hub_add_pane)`；否则 NewTab。
3. Hub 页面 hub-ws 收 `hub_add_pane` → `addPane(worker)` → iframe 载 `?piercode_agent=<id>` → worker content 连 `/ws?agent=<id>` → server bind → `broadcastAgentsUpdate` → 看板 running。
4. worker 跑任务、回 `agent_result` → server RecordResult + 广播 → 看板 completed/failed + 协调者收 `<task-notification>`（现有链路不变）。
5. 看板轮询 `/agents` 兜底全量；WS `agents_update` 走增量。
6. 用户点看板「停止/重试」→ hub-ws `sendAgentControl` → server `agent_control` → SetStatus/重发 inject + 广播。

## 错误处理

- **Hub 未开**：`RoleCount("hub")==0` → spawn 回退 NewTab，行为 = 现状，零回归。
- **平台不可嵌**：回退 NewTab。
- **/agents 鉴权失败**：看板显示「未连接」，停轮询，提示检查 token（复用 ws-linker 的 401→清缓存思路，但看板只读，仅提示）。
- **WS 断线**：hub-ws 指数退避重连；断线期间看板靠轮询维持（双通道互为容错，这是选「两者结合」的核心理由）。
- **重试时 worker 未绑定**：忽略 + user_log 诊断，不崩。
- **未知平台 hub_add_pane**：Hub 端映射不到 provider → 忽略该 pane（不崩），记 console.warn。

## 测试策略

- **Go**：`agent_registry_test.go` 已覆盖 RecordResult/Status；新增 `server_agents_test.go`：`/agents` 返回 List JSON + 鉴权（401 无 token）；`agent_control` stop→SetStatus(Stopped)。`spawn_agent` Hub 路径用 fake HubOnline/Broadcast 回调断言「在线→不开 tab、推 pane」「离线→开 tab」。
- **前端 vitest**：`agent-store.test.ts`（merge 去重 / stats 计数 / sort 顺序）；`pane-manager.test.ts` 扩 `providerIdForPlatform` 映射（含 z.ai→chatz、未知→undefined）。
- **构建**：`npx tsc --noEmit`、`npm run build`、`go build ./...`、`go test ./...`、`npx vitest run` 全绿。

## 非目标（YAGNI）

- 不做历史持久化 / 跨重启 agent 记录（registry 是内存态，重启清空——本来如此）。
- 不做独立 dashboard.html 页面（看板内嵌 Hub 即可）。
- 不做 ack 超时回退（仅「Hub 未开」这个确定情况回退）。
- 不做 worker pane 自动关闭（用户用 ✕ 手动关）。
- 不给 Hub catalog 加 aistudio/mimo（超范围；这些平台 spawn 走独立 tab 回退）。
