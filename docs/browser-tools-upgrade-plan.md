# 浏览器工具全量升级 — 实施计划

源: [browser-tools-audit-2026-06.md](browser-tools-audit-2026-06.md)（对标）+ `tmp/ref-porting-spec.md`（参考机制规格，逆向素材仅供推导，不照搬代码/文案）。

范围: 全部 Top10 + 第二梯队 + iframe。两个已定决策:
- **find 采样**走已连接 AI（sidebar API / 网页 AI 通道）。
- **焦点**改后台不抢（CDP Input 验证非前台 tab 生效后去 activateTabForInput，保留按需回退开关）。

## 关键架构发现（改变实现路线）

**PierCode 扩展的 click/type/snapshot 走页面上下文，不是裸 CDP。** `handleNativeBrowserCommand`（background/index.ts:427）的 native 域 switch:
- `click` → `clickElementInTab`（506）→ `window.__piercodeAccessibilityTree.getElementByRef(ref).click()` + scroll
- `type` → `typeInElement`（547）→ `element.value=text; dispatchEvent`
- `snapshot` → `getAccessibilitySnapshot`（465）→ `window.__piercodeAccessibilityTree.generate()`

即 PierCode **没有**像 Claude/Codex 那样用 `Input.dispatchMouseEvent/dispatchKeyEvent` 真合成输入。但 Controller 层（controller.go Click/Type）走的是 CDP 路径（resolveRefObject + Input dispatch）——**存在两套并行实现**，native 域是旧路径。须先确认哪条在跑（snapshot.go CompactSnapshot 处理的是 CDP `Accessibility.getFullAXTree`，说明主链是 CDP；native 域 click/type 是 legacy）。**Phase 0 先证实并删 legacy，避免在死代码上叠功能。**

真合成输入（Input.dispatch）是 drag/编辑器/游戏/keydown 监听生效的前提——是多个改进项的公共底座。

---

## 批次划分（依赖排序，每批独立可验证可提交）

### Phase 0 — 地基核查 + 死代码清理（S，无新功能）
**目标**: 锁定真实执行链，删并行 legacy，给后续批次干净底座。
- 证实主 click/type 链: 加临时日志 / 读 controller.go Click(384)→ 确认走 CDP Input 还是 native 域。
- 删 native 域 legacy click/type/snapshot（background/index.ts 506-607, 465-503）若确认未用；保留 native 域里仍活的（listTabs/cookies/downloads/resizeWindow/finalizeTabs/resolveSelectorRect/viewport）。
- 删 controller_ext.go 死代码 interpolate()/distance()（drag 未用）。
- **验证**: `go build ./...` + `go test ./internal/...` + 扩展 `npx tsc --noEmit` + `npm run build`；手动跑一次 browser_click 确认仍工作。

### Phase 1 — Prompt 文案包 + 安全双修（S，零/低代码，最高性价比）
依赖: 无。最先做——立即提升弱模型表现 + 堵安全洞。
- **1a Prompt 包** → `prompts/init_prompt.txt`（PierCode 自有措辞，参考 BASE_CHROME_PROMPT 结构）:
  - anti-rabbit-hole: 同一浏览器动作失败 2-3 次即停、报告、问用户，别死磕。
  - dialog 死锁预防: 永不触发 alert/confirm/prompt；调试用 console.log + browser_console。
  - tab 生命周期契约: 先 browser_tabs；不复用陈旧 tabId；默认新建；tab-not-found 即重列。
  - 文件上传: 永不点 file input（开原生选择器，AI 看不见），用 browser_upload 按 ref 设 files。
- **1b cookies 默认 metadata-only**: browser_tools_find.go:224 BrowserCookiesTool + controller_find.go:367 Cookies——`includeValue` 默认 false，取值须显式 opt-in。
- **1c 注入消毒**: tab 标题/页面标题/agent_result/文件列表注入 prompt 前过消毒（字符白名单 + 长度/数量上限 + DATA-ONLY 包裹）。新建 `internal/security/sanitize.go`，prompt/inject 路径调用。
- **1d 服务端 auto-dialog policy**: attach 时武装 `Page.javascriptDialogOpening` 自动 dismiss（per-tab 可配），兜底"点击同步弹 dialog wedge"。events.go 已 relay 该事件，加默认 handleJavaScriptDialog 回应。
- **验证**: go test；手动: 触发 confirm() 的页面点击不再 wedge；cookies 默认不返回值；标题含"Ignore previous"的页面不污染 prompt。

### Phase 2 — 真合成输入底座（M，多项依赖此）
依赖: Phase 0。是 drag/逐字符打字/焦点的公共底座。
- **2a 焦点后台化**: 验证 CDP Input.dispatch 在非 active tab 生效 → 去 handleBrowserCommand:409 的无条件 activateTabForInput；加配置 `backgroundInput`（默认 true=后台）+ 按需回退（个别站点/IME 需前台时 opt-out）。
- **2b 逐字符打字模式**: Type 加 `mode: 'keys'|'insert'`（默认 insert 不变）。keys 模式走 per-char `Input.dispatchKeyEvent` keyDown/keyUp + 虚拟键码 + 未映射回退 insertText（参考 spec G: 12ms/char）。修编辑器/自动补全/游戏。
- **2c HTML5 DnD 合成**: browser_drag 重写——发 `dragstart/dragover/drop` DragEvent 序列（非仅裸鼠标），修 react-dnd/sortable。保留鼠标 drag 作 fallback。
- **2d 剪贴板工具**: 新 browser_clipboard（read/write）——配合 keys 打字与粘贴流。
- **验证**: go test；手动: react-dnd 列表能拖；Monaco/CodeMirror 能逐字符输入触发补全；后台 tab 点击不抢前台焦点。

### Phase 3 — 可靠性层（M）
依赖: Phase 2（actionability 在 Input 路径上）。
- **3a actionability + 验证**: ref/坐标解析前 `scrollIntoView(block:center)` + 视口断言；click/type 前 visible/enabled/遮挡（elementFromPoint hit-test）检查；遮挡/屏外即明确报错而非静默 miss。controller.go resolvePoint + Click/Type 入口。
- **3b 滚动位移验证**: Scroll 后验证 scrollY 变化 >5px，否则 DOM scrollBy 最近可滚祖先兜底（现状 DOM 先行，改 CDP mouseWheel 先 + 验证 + DOM 兜底）。controller_ext.go Scroll(98)。
- **3c 跨域中途守卫**: 每个变更动作前重读 tab.url，registrable host 变化即中止。controller 公共前置。
- **3d wait 重建**: browser_wait_for_navigation 改用 CDP `Page.lifecycleEvent`（load/networkIdle）服务端等待，替代页面内轮询（真导航销毁 JS 上下文即报错）。加 networkidle 等待选项。events.go + controller_ext.go Wait。
- **验证**: go test；手动: 点屏外 ref 报"需先滚动"而非假成功；toast 遮挡的点击报遮挡；导航后 wait 不再 eval 报错；networkidle 等到位。

### Phase 4 — console/network 即时捕获（M）
依赖: 无（独立）。可与 Phase 2/3 并行。
- attach 即 enable Runtime + Network（`Network.enable{maxPostDataSize:65536}`），现状懒 enable 丢加载期日志。background attach 钩子。
- 补 `Network.loadingFailed` 捕获（events.go 加 DEBUGGER_EVENTS_TO_RELAY + 记录）。
- 按需 `Network.getResponseBody`（限大小）暴露响应体——新 browser_network 参数 `includeBody`。
- 跨域导航自动清缓冲（events.go）。
- 工具描述强制 regex pattern（browser_console/network）。
- **验证**: go test；手动: 不先调 console 也能拿到加载期 error；loadingFailed 出现；getResponseBody 返回体。

### Phase 5 — 读取原语：层级 snapshot + get_page_text + find 重建（M）
依赖: 无（读路径独立）。
- **5a 层级 snapshot**: snapshot.go CompactSnapshot 改缩进父子格式（role + 引号 name + [ref] + 关键属性 href/type/placeholder），加 `depth`（默认 15）/`ref_id` 子树下钻/`max_chars` 参数；超限改**错误**且文本自带指导（"降 depth 或聚焦 ref_N"）。ref 格式保持 e0/e1 兼容现有（或迁移；评估）。
- **5b get_page_text 工具**: 新 browser_get_page_text——Readability 式正文抽取纯文本（≤50k），区别于 browser_get_content（raw innerText）。新 tool + controller 方法 + executor 注册 + isReadOnlyTool。
- **5c find 重建**: browser_find 改自然语言 → 调已连接 AI 一次采样在 snapshot 上选 ≤20 候选，返回 snapshot 兼容 ref（`ref | role | name | reason`）；超限提示收窄。废弃 TreeWalker 子树评分 + CSS 路径。采样通道走 ClientIO（sidebar API / 网页 AI）。controller_find.go Find(16)。
- **验证**: go test；手动: snapshot 有层级缩进、depth 限制、超限报错带指导；get_page_text 出正文；find 用自然语言命中按钮且返回可用 ref。

### Phase 6 — 截图 token 预算 + vision 回路（M）
依赖: 无。
- 截图 1568px token 预算缩放 + JPEG 质量阶梯（0.75→…→0.10）+ base64 上限（spec C: 1398100）。controller.go Screenshot(558)。
- 按 tab 缓存视口↔截图比例，zoom/region 坐标重映射（spec C De()）。browser_zoom 坐标可点。
- sidebar/API 模式返回 base64 vision（现状只文件路径）；browser_zoom 输出像 browser_screenshot 附进对话。ClientIO 附件通道。
- **验证**: go test；手动: 大截图不超 token；zoom 后按返回坐标点中；sidebar 模式模型看得到图。

### Phase 7 — browser_batch 元工具（M，压轴，依赖前面稳定）
依赖: Phase 1（审批粒度）、Phase 3（actionability）、锁域理解。
- 新 browser_batch 工具: 一次执行 `[{name,input},…]` 序列，顺序、首错即停、逐项 Validate + 审批 + AI-page-gate + URL 门控、图片穿插返回、禁嵌套。
- executor 锁域: batch 预计算其锁集合（扫子调用的 tabId/path），一次性获取，一个审批面板管整批。executor.go lockForTool 加 batch 分支。
- prompt: "能预测 2+ 步就用 batch" + 批内坐标不变式（坐标指向批前截图）。
- **验证**: go test（batch 顺序/首错停/锁集合单测）；手动: 一个 batch 完成"点搜索框→输入→回车"三步一次往返、一次审批。

### Phase 8 — 分级权限（M）
依赖: Phase 1（消毒）、Phase 7（batch 审批集成）。
- approval.go + 新权限存储: per-site（netloc + `*.domain` 通配）allow 规则 + once|always 时效（once 绑 toolUseId 自动消费）+ 动作类粒度（click/type vs evaluate/cookie-write）+ turn-approved-domains。
- 自解释拒绝文案（"X 站点禁止输入——只读层级"）替代裸拒绝。
- IsSensitive 可配置 override/allowlist（security.go），修文档页/电商测试误伤。
- **验证**: go test（权限匹配/时效/动作类单测）；手动: 同站第二次点击不再弹窗（always）；evaluate 仍单独问；docs 页加白后不拒。

### Phase 9 — 虚拟光标升级 + tab 组 + 第二梯队收尾（M）
依赖: 无。
- **9a 光标升级**（参考 Codex）: closed shadow DOM（防检测 + 样式隔离）、MutationObserver 自愈（SPA 重建恢复）、随机/可配 id、配置开关。phantom-cursor.ts。可加点击涟漪（已有 pcc-ripple）+ "PierCode active" 指示条 + Stop 按钮。
- **9b tab 组 + favicon 角标**: 自动化 tab 进 chrome.tabGroups 分组 + favicon 角标（需 tabGroups 权限，manifest）。隔离边界 + 用户可见。
- **9c GIF/录屏**: browser_record——`Page.startScreencast` → 帧 → gif/webm。
- **9d 元素截图**: browser_screenshot 加 `ref` 参数，按 ref 元素 clip。
- **9e 网络节流/离线**: browser_emulate 加 Network.emulateNetworkConditions。
- **9f CSP 回退**: evaluate 在 eval-blocked 页回退直接表达式求值。
- **验证**: 各项手动 + go test。

### Phase 10 — iframe / OOPIF（L，单独大件，最后）
依赖: Phase 5（snapshot）、Phase 2（Input）。无参考配方，自研。
- `Target.attachToTarget{flatten:true}` 拿子 frame session。
- frame 级 AX 树合并进 snapshot（标 frame 来源）。
- 所有定向工具加 `frameId` 参数；Input/click 按 frame session 派发。
- 修 Stripe 表单、嵌入编辑器、hub iframe 不可见不可点。
- **验证**: go test；手动: 能 snapshot + 点击 iframe 内（如 Stripe 测试卡输入框）。

---

## 执行原则
- 每个 Phase 独立分支/提交，跑全验证（go build + go test + tsc + 扩展 build + 关键手动）后才进下一个。
- 改 Go 工具三件套: tool 文件 + controller 方法 + executor 注册（+ isReadOnlyTool if 只读）。所有路径过 SafePath/resolveAbsPath。
- 改扩展: tsc --noEmit + npm run build；CDP 命令经 handleBrowserCommand 统一入口。
- prompt 改动同步更新 docs（CLAUDE.md 工具表）。
- 不把逆向参考代码/prompt 原文写进提交文件——只移植机制，PierCode 自有实现与措辞。

## 顺序
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
（4 可与 2/3 并行；5、6 互相独立可并行；其余有依赖按序）
