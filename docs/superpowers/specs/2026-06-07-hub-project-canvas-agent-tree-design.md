# Hub v2 — 项目级画布 + Agent 树 + 玻璃拟态看板

日期：2026-06-07
分支：dev
取代：`2026-06-07-hub-dashboard-multi-subagent-design.md` 的「左侧扁平看板 + 每 AI 占一栏」布局。v1 的后端通道（GET /agents、agents_update 推送、hub_add_pane、agent_control、role=hub WS）**保留复用**，只重做信息架构与前端。

## 目标

把「多 AI 工作台」从「每个 AI 占一栏的平铺」重做成 **项目级节点画布**：

1. **项目抽象**：可创建/删除项目。每个项目是一块独立画布，持久化在 `chrome.storage.local`。
2. **节点画布**：项目内的每个 AI 界面是画布上一个可拖拽的卡片节点，内含**常驻 iframe**（加载后绝不重载）。自写轻量 pan/zoom（CSS transform）+ 节点拖拽 + SVG 贝塞尔连线。
3. **Agent 树**：手动添加的 AI 界面 = **主 agent**（树根，无父）；`spawn_agent` 出的 = 子节点，自动接到发起者下面并用发光连线连起来。**子 agent 也能再 spawn 子 agent**（递归树，带深度上限）。
4. **两层看板**：顶部**总览条**（全局 KPI，玻璃拟态）+ 右侧**项目级抽屉**（当前项目的 agent 树 / 状态 / 最近回复 / 控制）。
5. **视觉**：深空玻璃拟态（frosted glass 半透+模糊）+ 霓虹辉光边框 + 发光流动连线 + 状态脉冲（运行=蓝脉冲 / 完成=绿 / 失败=红）。背景点阵。

## 关键技术风险（先标出）

### A. 画布缩放下的常驻 iframe
画布用 `transform: scale()` 缩放，iframe 在 scale 下有两个坑：(1) 鼠标事件坐标错位；(2) 缩小后内容糊。**对策——双态节点**：
- **编辑态**（画布缩放浏览、拖拽布局）：节点 iframe 上盖一层透明遮罩 `pointer-events` 拦截，iframe 只作视觉缩略，不接收交互。缩放靠外层 wrapper 的 transform，iframe 自身不缩放、用固定逻辑尺寸 + CSS `zoom`/scale 视觉适配。
- **聚焦态**（双击节点或点「聚焦」）：该节点 1:1 居中放大（画布平移+缩放到该节点的逻辑尺寸），移除遮罩，iframe 正常交互。
- iframe **永不因布局变化重载**：节点位置=改 wrapper 的 `translate`，缩放=改画布根的 transform，DOM 节点身份（React key）只绑 `nodeId`，与位置/层级无关。

### B. 子 agent 递归 spawn 与现有禁令冲突
当前 `spawn_agent` 有硬禁令：`IsWorkerClient(sourceClientID)` → 拒绝（"workers cannot spawn workers"）。你要的「子 agent 开子 agent」要求**解除该禁令**。替换为**深度上限**（默认 maxDepth=3）防止失控扇出：worker 可 spawn，但若其在树中的深度 ≥ maxDepth 则拒绝。深度由 `ParentAgentID` 链上溯计算。

## 架构

```
chrome.storage.local                         Go AgentRegistry (内存)
  hubProjects: Project[]                        AgentRecord + ParentAgentID(新)
  ├ id,name,createdAt                           父子链：spawn 时从 dispatcher 的
  ├ nodes: CanvasNode[]  (手动加的主 agent)        worker-client→agent 反查父
  │   └ id,providerId,x,y,w,h                   summary 暴露 parent_agent_id
  └ viewport: {x,y,zoom}                        + project_id（节点归属）
                                              GET /agents → 含 parent/project
Hub 画布页 (role=hub WS)
  ├ 顶部总览条：全局 KPI（玻璃拟态）
  ├ 主画布：CanvasNode（常驻 iframe 卡）+ spawn 出的子 agent 节点 + SVG 连线
  └ 右抽屉：当前项目 agent 树 + 状态 + 控制（停止/重试）

spawn_agent：HubOnline && embeddable → hub_add_pane{agent_id, parent_agent_id, project_id, platform}
  → Hub 在「父节点所在项目」里 addChildNode，自动连线
```

## 数据模型

### 前端（chrome.storage.local，key `hubProjects`）
```ts
interface Project {
  id: string;              // uuid
  name: string;
  createdAt: number;
  nodes: CanvasNode[];     // 手动加的主 agent（树根）
  viewport: Viewport;      // {x, y, zoom} 画布平移+缩放
}
interface CanvasNode {
  id: string;              // 节点 id（= 该主 agent 的本地 id）
  providerId: string;      // qwen/claude/...
  agentId?: string;        // worker 节点携带（spawn 出的子节点）
  parentNodeId?: string;   // 父节点 id（子 agent 才有）；用于画连线
  x: number; y: number;    // 逻辑坐标
  w: number; h: number;    // 逻辑尺寸
}
interface Viewport { x: number; y: number; zoom: number; }
```
project-store 纯函数：`createProject/deleteProject/renameProject/addNode/removeNode/moveNode/setViewport/addChildNode`。可单测。

### 后端（AgentRegistry）
- `AgentRecord` 加 `ParentAgentID string`、`ProjectID string`。
- `AgentSummary` 加 `parent_agent_id,omitempty`、`project_id,omitempty`。
- `Create(...)` 增参 `parentAgentID, projectID`。
- 父推断：worker 调 spawn 时，`sourceClientID` 是 worker 的 WS client；反查 `agents[].WorkerClientID==sourceClientID` 得其 AgentID → 即新 agent 的 `ParentAgentID`。主 agent（dispatcher 是普通 ai-page client）spawn 时 `ParentAgentID=""`。
- `Depth(agentID)`：沿 ParentAgentID 上溯计数。`spawn_agent` 用它做 maxDepth 守卫。
- `List(projectID)` 可按 project 过滤（dashboard 抽屉只看当前项目）。保留 `List("")` 全量给总览。

## 画布引擎（自写，`hub/canvas/`）

- `canvas-math.ts`（纯）：屏幕坐标 ↔ 逻辑坐标互转、viewport pan/zoom 累加、节点命中测试、贝塞尔控制点计算。**可单测**。
- `Canvas.tsx`：根 div `transform: translate(vx,vy) scale(zoom)`；滚轮缩放（以光标为锚）、空白拖拽平移、节点拖拽（改 node.x/y）。
- `CanvasNode.tsx`：常驻 iframe 卡片 + 头部（provider 名/worker 徽标/聚焦·关闭按钮）+ 状态辉光环。编辑态遮罩。
- `Edges.tsx`：一层覆盖 SVG，按 `parentNodeId` 画发光贝塞尔曲线（`<path>` + `filter: drop-shadow` + 流动 dash 动画）。
- 双态：`focusedNodeId` 状态；聚焦时画布动画平移缩放到该节点 + 撤遮罩。

## 看板（玻璃拟态）

- `OverviewBar.tsx`（顶部常驻）：全局 KPI —— 项目数 / 活跃 agent / 运行中 / 完成 / 失败。frosted glass（`backdrop-filter: blur`）+ 霓虹描边。数据来自 `computeStats(allAgents)` + 项目数。
- `ProjectDrawer.tsx`（右侧滑出）：当前项目的 agent 树（缩进+连线徽标）、每 agent 状态/最近回复/debug 展开、停止·重试。复用 v1 的 agent-store + hub-ws.sendAgentControl。点树节点 → 画布聚焦对应节点。

## 视觉规范（深空玻璃拟态 + 霓虹辉光）

- 背景 `#0b0b14`，点阵 `radial-gradient` dot grid。
- 面板：`background: rgba(30,30,46,.55)` + `backdrop-filter: blur(12px)` + `border: 1px solid rgba(137,180,250,.25)`。
- 辉光：节点边框按状态 `box-shadow: 0 0 16px <color>`；运行态 `@keyframes pulse`。
- 连线：`stroke` 渐变 + `drop-shadow` + `stroke-dasharray` 流动动画。
- 配色沿用 catppuccin accent：蓝 `#89b4fa`(运行) / 绿 `#a6e3a1`(完成) / 红 `#f38ba8`(失败) / 紫 `#cba6f7`(连线辉光)。

## 数据流

1. 用户建项目 → storage 持久化 → 空画布。
2. 用户在项目里「+ AI」→ addNode（主 agent 根节点，常驻 iframe）。
3. 该主 agent 的 AI 调 `spawn_agent` → server Create（ParentAgentID 反查、ProjectID=父节点项目）→ `hub_add_pane{agent_id,parent_agent_id,project_id,platform}` → Hub 在对应项目 `addChildNode`（位置=父节点下方自动布局）+ 画连线 → worker iframe 自绑定。
4. 子 agent 再 spawn → 同样反查父（这次父是上一层 worker）→ 深度+1，≤maxDepth 才放行 → 再接一层连线。
5. 状态变更：agents_update 推送 → store 更新 → 节点辉光 + 抽屉刷新 + 总览条 KPI。
6. 控制：抽屉/节点的停止·重试 → agent_control（v1 通道）。

## 错误处理

- 画布缩放下 iframe 交互：编辑态遮罩兜底，聚焦态才放行交互。
- 深度超限：spawn_agent 返回明确错误，不开节点。
- spawn 的 project_id 找不到对应项目（项目被删）：Hub 端忽略该 pane + warn。
- Hub 未开：spawn 回退独立 tab（v1 行为不变）。
- storage 写失败：内存态继续，下次重试持久化。

## 测试

- 前端 vitest：`project-store.test.ts`（CRUD/addChildNode/move）、`canvas-math.test.ts`（坐标转换/命中/缩放锚点）、`agent-tree.test.ts`（按 parent_agent_id 建树、深度计算）。复用 `agent-store.test.ts`。
- Go：`agent_registry_test.go` 扩 ParentAgentID/Depth/按 project 过滤；`agent_spawn_test.go` 扩父推断 + 深度守卫（worker spawn 在 ≤maxDepth 放行、超限拒绝）。
- 构建：tsc / vitest / go build / go test 全绿。

## 非目标（YAGNI）

- 不做画布 minimap（先 pan/zoom 够用）。
- 不做节点自由连线编辑（连线只由父子关系生成，不可手动连）。
- 不做项目导出/导入、协作。
- 不做 agent 历史持久化（registry 仍内存态）。
- maxDepth 固定常量，不做可配置 UI。

## 迁移

- v1 的 `Dashboard.tsx`（左侧扁平看板）被 `OverviewBar` + `ProjectDrawer` 取代；`agent-store.ts`、`hub-ws.ts`、`pane-manager.providerIdForPlatform` 保留。
- 旧 `hubPanes` storage key 弃用；首次加载若存在旧 panes 且无 `hubProjects`，迁移成一个「默认项目」放入这些节点。
