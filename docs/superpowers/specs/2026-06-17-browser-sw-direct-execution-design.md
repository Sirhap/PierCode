# browser_* 工具迁移到扩展 Service Worker 直接执行

**日期**: 2026-06-17
**分支**: `dev_browser`
**状态**: 设计已批准（待 spec review）

## 1. 目标与动机

把 `browser_*` 工具的执行从 Go 服务器迁移到 Chrome 扩展的 Service Worker (SW) 内直接执行，**完全跳过 Go `/exec` 链路**。

三个驱动目标：

1. **解决跨浏览器抢答**：当前 `browser_*` 经 WS 从 Go 广播到所有 `browser-relay` 客户端，多个 Chrome 连同一 server 时会打到错的浏览器（非 owner 抢先答 "No tab with id"）。让 `browser_*` 在每个 SW 内直接执行 → SW 只通过 `chrome.tabs`/`chrome.debugger` 看到**自己浏览器**的 tab，天然不跨浏览器。`WSManager` 的 `tabOwners`/`SendBrowserCommand` 定向路由对 `browser_*` 变得不再必要。
2. **架构简化**：`browser_*` 是纯浏览器操作，逻辑上不需要本地 Go server（只有文件/shell 才需要）。SW 本身就是 CDP 客户端（已持有 `chrome.debugger`），多一层 Go→WS→CDP 是冗余。
3. **插件单独可用**：Go server 没跑时，扩展也能做浏览器自动化。浏览器 agent 侧边栏（驱动网页 UI 出 `browser_*`，无文件工具）可完全脱离 Go 二进制运行。

## 2. 关键背景（已精读代码确认）

### 2.1 WS 协议分工 = 低层 CDP（决定性发现）

**确认**：Go 经 WS 发的是**低层 CDP 方法调用**，不是高层意图。

- Go `internal/browser/types.go` `Command{Type, ID, TabID, SessionID, Domain, Method, Params, TimeoutMS}` — `Domain`/`Method` 是字面 CDP 字符串（如 `"Input"`/`"dispatchMouseEvent"`），在调用点设置。
- SW `extension/src/background/index.ts:450`：`chrome.debugger.sendCommand(target, ${msg.domain}.${msg.method}, params)` — **纯透传**，把 `domain+"."+method` 拼成 CDP 方法字符串照原样喂进去。
- SW **没有任何高层浏览器逻辑**：无 ref→坐标解析、无 hit-test、无 click 三段式、无 settle/stability、无 snapshot 解析。它是 thin CDP pass-through + 事件转发器，唯一例外是一个固定的 `PierCode` 合成域（12 个 native chrome.* 命令：listTabs/createTab/cookies/navigate/viewport 等）。

**推论**：所有编排逻辑（~4900 LOC）都在 Go `controller*.go`，必须移植成 TS 进 SW。这是 option A 的全部工作量。

### 2.2 要移植的 Go 编排（按可移植性分类）

总计 `internal/browser/` 约 7.2K LOC Go：

| 桶 | 内容 | ~LOC | 移植性 |
|---|---|---|---|
| **纯 CDP 编排（机械可移植）** | controller.go/ext/find/state（去掉文件尾）、snapshot.go (439)、marks.go (198)、input_fidelity.go (71)、security.go（去 PSL ~180）、~600 LOC 内嵌 JS 字符串 | **≈4,700** | CDP 命令→`chrome.debugger.sendCommand`，Go struct→TS interface，JS 字符串→内联 TS 函数 |
| **glue（需重设计）** | EventBus 的 channel/goroutine 机制（~150/516）、ApprovalManager transport（~80/168）、图像预算 (screenshot_budget 120)、GIF/zip (screenshot_gif 84)、所有 `os.*` 文件 I/O 尾（~120）、approval 广播 + attachment 上传耦合（~100）、goroutine/`time` 改写（~60） | **≈900–1,000** | redesign，非翻译 |
| **直接消失** | RelayManager 请求/响应关联 (220)、多浏览器 preferSuccess/fanout、WSManager `tabOwners` 路由 | (—) | SW 直接持有 `chrome.debugger`，无需 relay |

**最高风险移植点**：(1) snapshot ref 系统 + staleness 不变式（registry.go + snapshot.go）；(2) OOPIF 跨域 click 坐标数学（`resolveOOPIFPoint`/`iframeOwnerOffset`）；(3) 图像 token 预算 + GIF 编码（不同工具链）；(4) approval/attachment transport 重设计。

### 2.3 工具清单：44 个 browser_* 工具

`executor.go:139–182` 注册 44 个，`BrowserController` 接口 44 方法（`tool.go:227–272`）。`browser_batch` 不调 controller（re-dispatch 子调用）。只读工具 13 个（`isReadOnlyTool` 标记）：snapshot/screenshot/find/console/network/get_content/get_page_text/pdf/record/wait/wait_for_function/get_attributes/tabs。其余为交互/写工具（含 drag/click/type 等）。

### 2.4 当前两条 `browser_*` 路由（都要改）

1. **content 自动执行**：`content/index.ts:1417` `executeToolCallRaw` → `bgFetch(/exec)` → Go。
2. **浏览器 agent 侧边栏**（刚重构）：`background/browser-agent.ts:382` `execBrowserTool` → `fetch(/exec)` → Go。

两条都 POST `/exec`。改成在 SW 内调 TS controller。

### 2.5 安全 / 审批 / 锁（跨切面）

- **安全** (`security.go`)：`CheckNavigate`（仅 http/https/about:blank 白名单）、`IsAIPage`（hardcoded host 列表，已在 manifest/adapters 存在）、`IsSensitive`（付款页**硬拒**非审批：host `bank`/`alipay`/`paypal`，路径+标题关键词 `/payment`/`/checkout`/`付款`/`支付`/`转账`/`结账`）。~95% 纯函数，仅 `sensitiveAllow` map 需 SW 态。`registrableDomain` 用 `golang.org/x/net/publicsuffix`，SW 需 JS PSL 库或简化 eTLD+1。
- **审批** (`approval.go` + `controller.go`)：两个独立 gate——
  - **Gate A（AI 页 gate）**：硬拒，非弹窗。`ensureTab` 解析 tab 时若 `IsAIPage && !IsApproved` → 拒 "refusing to control AI conversation tab by default"。`browser_use_tab` 或 AI 自开 AI 页时 `MarkApproved`。worker tab（`?piercode_agent=`）保持 uncontrolled 绕过。
  - **Gate B（动作审批）**：`c.ask()` → `ApprovalManager.Ask`。18 个调用点（click/type/hover/select/press_key/drag/form_input/evaluate/clipboard/upload/handle_dialog/cookie/cross-origin-nav/finalize 等）。当前广播 `browser_approval_ask` 经 WS → `content/ws-linker.ts:742` 渲染卡 → `browser_approval_answer` 回。grants（session "always" per host+action-class）、action-class 粗化（evaluate/cookie/clipboard/upload/dialog/interact）、5 分钟超时——全纯逻辑可移。
- **锁** (`executor.go:455–562`)：browser write 工具 = `sharedPlusKeyed(browserTabKey(args))` = 共享 RLock + per-tab 互斥（key `tab:<id>` 或 `tab:default`）。不同 tab 并发，同 tab/默认串行。只读 browser 工具 = 纯 RLock 无 per-tab 互斥。SW 已有 `queueBrowserCommand(key, ...)` 但 key 在更低 CDP 层，要移植 tool 级 `tab:<id>`/`tab:default` 语义。

### 2.6 约束

- **content.js 不能有 ESM import**（`content-build.test.ts:24-25` 守 `not.toMatch(/import/)` + `/from ["']/`）。content 侧的改动只能用已内联的方式（`chrome.runtime.sendMessage`）。**SW 侧 TS 可正常 import** → controller 全部放 SW 侧模块。
- TabRegistry（registry.go 288 LOC）核心态：`defaultID`/`tabs`/`snapshots`（每 tab 3 个，`refs map`）/`approved`/`tracking`/`lastPointer`/`marksByTab`。**ref staleness 不变式**：任何 mutating action 必须 `MarkStale` 失效 refs，否则 click-by-ref 静默打错。

## 3. 选定方案：A（全移 SW，删 Go controller）

用户决策：**A** + **按工具类别三阶段** + **/exec browser_* 路由整个删（含审计移 SW 侧）** + **截图/PDF/GIF 返 base64/dataURL**。

整个 `BrowserController` 移成 TS 进 SW，删除 Go `internal/browser/` 的 controller/tool 代码。`browser_*` 完全不碰 Go。最干净的最终态。

**关键纪律（A 的安全网）**：每阶段**先**在 TS 落地 + 测试覆盖该批工具，**再**翻路由，**最后**删对应 Go 代码。绝不先删 Go 再写 TS。每阶段 `tsc + vitest + go test + build` 全绿才进下一阶段。

### 3.1 为什么用户选 A 而非 C（保留回退）

任务文档原建议保留 Go 回退（C/B），但用户明确选 A。接受：A 无回退，所以**测试覆盖是硬门槛**——TS controller 每个工具必须有 vitest 覆盖（mock `chrome.debugger`），等价行为锁定后才删 Go。Go 的 controller 测试（`controller_*_test.go` ~3500 LOC）是移植正确性的**行为规格**，移植时逐个对照。

## 4. 目标架构

### 4.1 SW 侧新模块（`extension/src/background/browser/`）

新建目录承载 TS controller。**SW 侧可 ESM import**，所以正常模块化：

```
extension/src/background/browser/
  controller.ts          # 顶层：44 个工具方法（对应 BrowserController 接口）
  cdp.ts                 # CDP helper: runtimeEvaluate / callFunctionOn / sendCommand 封装
  ref-resolve.ts         # resolveRefObject / resolveSelectorObject / resolvePoint / boxModelBounds / OOPIF 坐标
  input.ts               # dispatchClick / moveTo / dispatchTypedKeys / dispatchKeyChord / dispatchMouseWheel / dispatchDrag
  snapshot.ts            # AX 树解析 → 紧凑文本（snapshot.go 439 LOC 移植）
  marks.ts               # enumerateInteractive / SVG overlay（marks.go 移植）
  find.ts                # 元素评分排序（controller_find.go 的 findElementsExpression）
  registry.ts            # TabRegistry: defaultID/tabs/snapshots(refs,staleness)/approved/tracking/lastPointer/marksByTab
  events.ts              # EventBus: console/network ring buffer + dialog/nav waiter（Promise/AbortController）
  approval.ts            # ApprovalManager: pending Promise map + grants + action-class + 5min 超时；UI 经 chrome.runtime.sendMessage
  security.ts            # CheckNavigate / IsAIPage / IsSensitive / registrableDomain（JS PSL）
  image.ts               # 截图 token 预算（OffscreenCanvas）+ GIF 编码（JS 库）
  in-page-js.ts          # 内嵌页面 JS 字符串（getContent/storage/form/select/attr/waitFor 等）
  types.ts               # 请求/响应 TS interface（对应 tool.go 的 struct）
  dispatch.ts            # 工具名 → controller 方法路由 + per-tab 串行锁（browserTabKey 语义）+ 安全/审批 gate 编排
```

### 4.2 新执行链路

```
content 检测 browser_* 工具 / 浏览器 agent 侧边栏出 browser_*
  ↓ chrome.runtime.sendMessage({ type: 'EXEC_BROWSER_TOOL', name, args, callId })
SW background dispatch.ts
  ↓ per-tab 串行锁（按 tabId 分桶）
  ↓ 安全 gate（IsSensitive 硬拒 / CheckNavigate scheme）
  ↓ AI 页 gate（ensureTab）
  ↓ 审批 gate（高危动作 → chrome.runtime.sendMessage 求审批 → await）
  ↓ controller.ts 方法 → cdp.ts → chrome.debugger.sendCommand（多个低层 CDP）
  ↓ 结果（截图/PDF/GIF = base64）
  ↓ 回 sendResponse → content/sidebar 喂回 AI 作工具结果
```

**对比旧链路**：删掉 `content → /exec → Go executor → controller → relay → WS → SW CDP`，压成 `content → SW dispatch → SW controller → CDP`。少 5 跳。

### 4.3 审批 UI 通道（SW 无 DOM）

SW 不能渲染卡片。审批请求经 `chrome.runtime.sendMessage` 发给：
- **浏览器 agent 侧边栏路由**：发给侧边栏（已有 `ApprovalCard.tsx` / `browser-agent-store.ts` 处理 `BROWSER_AGENT_APPROVAL`）。
- **content 自动执行路由**：发给来源 content tab，复用现有审批卡渲染（`content/question-approval.ts`）。

SW 侧维持 `pending Promise map`，UI 回 `chrome.runtime.sendMessage({type:'BROWSER_APPROVAL_ANSWER', approvalId, approved, scope})` resolve。grants/action-class/5min 超时纯逻辑在 SW。

### 4.4 跨浏览器天然解决（验证）

SW 的 `chrome.tabs.query`/`chrome.debugger.attach` 只能见**本扩展实例所在浏览器**的 tab。两个 Chrome 各跑自己的 SW，各自 controller 只操作自己的 tab。`tabOwners`/`SendBrowserCommand`/`SendCommandFanout`/preferSuccess 对 `browser_*` 全部不再需要（这些留给文件/shell 的 WS 如果还用的话；但 `browser_*` 不再经它们）。`browser_tabs` 不再需要 fanout 合并——单 SW 直接 `chrome.tabs.query` 就是本浏览器全部。

## 5. 分阶段实施（按工具类别）

每阶段：移植 TS + vitest 覆盖 → 翻该批工具路由 → `tsc + vitest + go test + build` 全绿 → 删对应 Go → 再次全绿 → 进下阶段。

### Phase 0：核心基建（无工具翻路由，纯搭骨架）

移植所有共享基建，但**不**接任何路由（Go 路径仍是唯一活路径）。这样基建可独立单测。

- `cdp.ts`：`runtimeEvaluate`/`runtimeEvaluateOnSession`/`callFunctionOnObject`/`sendCommand` 封装 + `ensureAttached`/`enableDebuggerDomains`（复用 index.ts 已有的）。
- `registry.ts`：TabRegistry 全部态 + ref staleness 不变式 + `StoreSnapshot`/`MarkStale`/`ResolveRef`。
- `ref-resolve.ts`：`resolveRefObject`/`resolveSelectorObject`/`resolvePoint`/`boxModelBounds`/`resolveOOPIFPoint`/`iframeOwnerOffset`/`assertPointActionable`。
- `security.ts`：`CheckNavigate`/`IsAIPage`/`IsSensitive`/`registrableDomain`（引 JS PSL 库，如 `tldts`，仅 SW bundle）。
- `events.ts`：EventBus console/network ring buffer + dialog/nav waiter。
- `approval.ts`：ApprovalManager pending map + grants + action-class + 超时 + UI message 通道。
- `dispatch.ts`：工具名路由表 + per-tab 串行锁（`browserTabKey` 语义）+ gate 编排骨架。
- `types.ts`：所有请求/响应 interface。

**测试**：每个基建模块 mock `chrome.debugger.sendCommand` 单测，对照 Go 的 `controller_*_test.go` 行为。`go test ./...` + `build` 仍全绿（没动 Go）。

### Phase 1：只读工具（端到端跑通新链路）

移植 + 翻路由只读工具：`browser_tabs`/`browser_snapshot`/`browser_screenshot`/`browser_find`/`browser_console`/`browser_network`/`browser_get_content`/`browser_get_page_text`/`browser_pdf`/`browser_record`/`browser_wait`/`browser_wait_for_function`/`browser_get_attributes`。

- `snapshot.ts`（AX 树解析，最大单块 439 LOC）+ `find.ts` + `in-page-js.ts`（getContent/getPageText/waitFor 等）+ `image.ts`（截图预算 OffscreenCanvas、GIF 编码、PDF base64）。
- 改 `content/index.ts` `executeToolCallRaw`：检测 `browser_*` 只读工具 → `chrome.runtime.sendMessage('EXEC_BROWSER_TOOL')` 而非 `/exec`。
- 改 `background/browser-agent.ts` `execBrowserTool`：同样直发 SW dispatch。
- SW `background/index.ts` 加 `EXEC_BROWSER_TOOL` message handler → `dispatch.ts`。
- 截图/PDF/GIF 返 base64/dataURL；调整 content/sidebar 渲染与喂回 AI 的格式。

**验证**：浏览器 agent 侧边栏跑一个只读任务（snapshot + screenshot + get_page_text）端到端，确认走新链路、跨浏览器不抢答（开两个 Chrome 连同一 server 验证）、Go 没跑也能跑只读（脱 server 验证）。然后删 Go 对应的 13 个只读 tool + controller 方法 + 它们独占的 helper（snapshot.go/find 部分/screenshot_budget.go/screenshot_gif.go）。

**门槛**：`tsc + vitest + go test + build` 全绿。

### Phase 2：交互工具（点击/输入 + 审批流 SW 化）

移植 + 翻路由：`browser_click`/`browser_type`/`browser_hover`/`browser_scroll`/`browser_select`/`browser_press_key`/`browser_drag`/`browser_focus`/`browser_navigate`/`browser_new_tab`/`browser_use_tab`/`browser_go_back`/`browser_go_forward`/`browser_reload`/`browser_mark`/`browser_handle_dialog`/`browser_wait_for_navigation`/`browser_resize`/`browser_viewport`/`browser_emulate`。

- `input.ts`（dispatchClick/moveTo/dispatchTypedKeys/dispatchKeyChord/dispatchMouseWheel/dispatchDrag + input fidelity 时序）+ `marks.ts`。
- **审批流 SW 化**：`approval.ts` 接 UI message 通道，两条路由各自渲染审批卡（侧边栏 `ApprovalCard` / content 审批卡）。Gate A（AI 页）+ Gate B（动作审批）在 dispatch.ts 编排。
- per-tab 串行锁实战（同 tab 多步保序，不同 tab 并发）。

**验证**：浏览器 agent 端到端交互任务（导航 + 点击 + 输入 + 提交），审批卡正确弹出/批准/拒绝，sensitive 页硬拒，AI 页 gate 生效。删 Go 对应工具 + 方法 + input_fidelity.go + marks.go + approval.go + 部分 controller。

**门槛**：四绿。

### Phase 3：写/高危工具 + 收尾

移植 + 翻路由：`browser_evaluate`/`browser_upload`/`browser_clipboard`/`browser_cookies`/`browser_set_cookie`/`browser_storage`/`browser_form_input`/`browser_zoom`/`browser_finalize_tabs`/`browser_downloads`/`browser_batch`。

- `browser_batch` 在 SW 内 re-dispatch（dispatch.ts 自调）。
- `browser_upload`：SW 无文件系统——本地路径上传不可行，改为页面内 DataTransfer/drop 或文件选择器（评估，可能降级/移除本地路径上传）。
- 高危审批（evaluate/cookie/upload/clipboard/dialog）走 action-class 隔离 grant。

**收尾**：
- 删 `/exec` 的 `browser_*` 路由：`executor.go` 不再注册 44 个 browser tool；删 `internal/browser/` 全部 controller/relay/registry/events/approval/security/snapshot/marks/input_fidelity/screenshot_* Go 文件；删 `internal/tool/browser_tools*.go`；删 `tool.go` 的 `BrowserController` 接口 + browser 相关 Context 字段；删 server 的 `browser` 字段、`/exec` 里 browser 分支、WS 的 `browser_cmd`/`browser_result`/`browser_event`/`browser_approval_*` 处理（如果文件/shell 不再需要 WS 浏览器通道则一并清；保留 WS 用于其他用途如 inject/agent）。
- 审计：browser 动作记录移 SW 侧（扩展 console / 侧边栏 ActionTimeline）。
- 删 `go test` 里失效的 browser controller 测试（已被 TS vitest 取代）。

**验证**：全套端到端（只读 + 交互 + 写），脱 Go server 跑浏览器 agent 全流程，两浏览器并发不抢答。`tsc + vitest + go test + build` 全绿。

## 6. 离开 Go 丢什么 + 怎么补

| 丢失 | 补法 |
|---|---|
| `/exec` 的 browser_* API 通道（TUI/curl 直调） | **舍弃**（用户决策）。非浏览器客户端本就需扩展才能跑浏览器自动化。 |
| Go 侧审计日志（TUI logsink）browser 动作 | **移 SW 侧**：扩展 console + 侧边栏 ActionTimeline（已有）。 |
| `golang.org/x/net/publicsuffix` eTLD+1 | JS PSL 库（`tldts`，仅 SW bundle，不进 content.js）。 |
| `os.*` 文件 I/O（截图/PDF/GIF 写盘） | base64/dataURL 返回（用户决策）。GIF 用 JS 编码库，截图缩放用 OffscreenCanvas。 |
| `runtime.GOOS`（select-all 的 Meta vs Ctrl） | `navigator.platform`/`navigator.userAgentData`。 |
| Go 并发原语（RelayManager/EventBus channel/ApprovalManager chan/goroutine/time） | RelayManager **直接删**（SW 是 CDP 客户端）；其余改 Promise/AbortController/Map/setTimeout。 |
| 全局 `toolMu` 跨域互斥（browser vs 文件/shell） | **可接受丢失**（资源不相交：浏览器 vs 文件系统）。browser_* per-tab 串行锁在 SW 重建。 |
| 统一 `/exec` 协议、profile guidance（每 N 调用注入） | browser_* 与文件/shell 分裂可接受。guidance 对 browser 回合若需要，SW 侧自建计数器（仅从内嵌 prompt 渲染，绝不读 sandbox 文件）。**初版可不做**，标注为后续。 |

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| content.js 引入 ESM（破 content-build.test.ts） | content 侧只加 `chrome.runtime.sendMessage` 调用（已内联模式），所有 controller 在 SW 侧模块。每阶段跑 content-build.test.ts。 |
| ref staleness 不变式移植错（click 静默打错） | registry.ts 严格对照 registry.go 的 `MarkStale` 调用点；vitest 锁定"mutating action 后 ResolveRef 失效"。 |
| OOPIF 跨域坐标数学移植错 | 对照 `controller_click_test.go` 的 OOPIF 用例逐个移植 vitest。 |
| 图像预算/GIF 工具链不同 | OffscreenCanvas（SW 可用）+ JS GIF 库；用真实截图回归对比尺寸/质量。 |
| 浏览器 agent 侧边栏刚重构（iframe 跑 content bootstrap → executeToolCallRaw → /exec 自动执行 browser_*） | 这条路改成直发 SW dispatch；不动 chat-api 的 API 子 agent（那是另一套）。Phase 1/2 端到端验证侧边栏路由。 |
| executor per-tab 锁的 TS 等价 | dispatch.ts 移植 `browserTabKey`（tab:<id>/tab:default）+ 按 key 串行；content 侧已有按 tabId 分桶并发，与 SW 锁配合。 |
| TS controller 与 Go 版同步 | 不同步——A 是**替代**。Go controller 测试是移植规格，移完即删 Go，单一真相在 TS。 |
| 一次性删 Go 太多 | 不一次删——每阶段只删该批工具对应 Go，全绿后才进下阶段。 |

## 8. 验证手段

- **单元**：每个 SW browser 模块 vitest，mock `chrome.debugger.sendCommand`，对照 Go `controller_*_test.go` 行为。
- **类型**：`npx tsc --noEmit` 每阶段。
- **Go 回归**：`go test ./...` 每阶段（确认删 Go 没破其余）。
- **构建**：`npm run build`（含 content-build.test.ts）每阶段。
- **端到端（手动 + 脚本）**：
  - 浏览器 agent 侧边栏跑真实任务（只读 → 交互 → 写），观察走新链路。
  - **跨浏览器**：两个 Chrome 各装扩展连同一 server，同时跑 browser_* 任务，确认不抢答、各操作自己 tab。
  - **脱 Go**：Go server 不启动，浏览器 agent 侧边栏跑纯浏览器任务，确认可用。
  - 现有 `scripts/iframe-embed-smoke.mjs`/`scripts/trace-browser-agent.mjs` 适配新链路。

## 9. 非目标（YAGNI）

- 不动 chat-api 的 API 子 agent（`runSubAgent`/`runIsolatedConversation`）——那是纯 API 内存对话，无浏览器 tab，与本迁移无关。
- 不做 guidance 注入的 SW 等价（初版）——标注后续，browser 回合 guidance 非必需。
- 不保留 Go 回退（用户选 A）——测试覆盖替代回退保险。
- 文件/shell 工具完全不动——仍走 Go `/exec`。
