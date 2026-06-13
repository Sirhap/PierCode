# Phase 10 — iframe/OOPIF 支持设计

源: 审计 PierCode 现状(零 frame 支持) + CDP OOPIF 机制研究。背景见 [browser-tools-upgrade-plan.md](browser-tools-upgrade-plan.md) Phase 10。

## 现状(全无 frame 支持)

- `Accessibility.getFullAXTree` 空参数,只覆盖主 frame(snapshot.go / controller.go:402)。
- Command 结构无 sessionId/frameId,relay 只按 tabId 路由(types.go:8, relay.go)。
- 扩展 `chrome.debugger.sendCommand({tabId})` 无 sessionId;无任何 Target.* / setAutoAttach。
- ref 解析 / boxModelBounds 只在主 frame;Input 坐标视口绝对无 iframe 偏移。
- `Page.frameNavigated` 的子 frame(ParentID 非空)被静默丢弃(events.go:190)。

## CDP 现实(决定设计)

**chrome.debugger 关键约束**:
- `attach({tabId})` **不**自动 attach OOPIF。Chrome 125+ 才有 flat sessions:`Target.setAutoAttach{autoAttach:true, waitForDebuggerOnStart:false, flatten:true}` → 子 frame 经 `Target.attachedToTarget` 给 `sessionId` → `sendCommand({tabId, sessionId})` 定向。
- **同源** child frame: `getFullAXTree({frameId})` 在页面 session 直接拿(共进程),`getBoxModel` 返主视口坐标(无需偏移)。
- **跨源** OOPIF: 每 frame 独立 session,逐个 enable 域 + getFullAXTree;ref 复合(frame 序号 + backendNodeId,跨 session 不唯一)。
- 递归**不自动**: A→B→C 每个子 session 重新 setAutoAttach。
- **坐标陷阱**(headed 扩展必踩): OOPIF 的 `getBoxModel` 返 **frame 相对**坐标(Puppeteer #7849)。绝对点 = 逐层 iframe owner 偏移(`DOM.getFrameOwner(frameId)` → 父 session `getBoxModel` 拿 iframe 元素位置 + border/padding)累加 + frame 内相对点。Input 发页面 session 用绝对坐标。

## 分层落地

### Tier A — 同源 iframe（先做,小/稳/立即可用）
纯页面上下文,零 CDP 管线改动。覆盖同源嵌入编辑器、同源 Stripe 等。
- snapshot/find/click 在 page-context 递归 `iframe.contentDocument`(同源可访问),`getBoundingClientRect()` + 逐层 `iframe.getBoundingClientRect()` 偏移 → 绝对坐标。
- 实现点:
  - find 的 `findElementsExpression` 已是 page-context,加同源 iframe 递归遍历(`el.contentDocument` 可达即下钻,偏移累加到 rect)。返回的坐标已绝对,click 用 x/y 直接生效。
  - snapshot 可选:page-context 生成同源 iframe 内元素的补充列表(标 frame 来源 URL),附在 AX 树后。先做 find,snapshot 增强次之。
- 跨源 iframe(`contentDocument` 抛 SecurityError)→ 跳过,标为不可下钻的 leaf。

### Tier B — 跨源 OOPIF（后续,需 Chrome 125 门控 + 全套管线）
- Command 加 `SessionID` 字段(types.go),relay 透传,扩展 `sendCommand({tabId, sessionId})`。
- 扩展 `ensureAttached` 后发 `setAutoAttach{flatten:true}`;`onEvent` 加 `source.sessionId` + 监听 `Target.attachedToTarget`/`detachedFromTarget` 维护 `frameId↔sessionId` 注册表 + 每子 session 重发 setAutoAttach 递归。
- snapshot 多 session 合并:每 OOPIF session enable DOM/Accessibility + getFullAXTree,复合 ref。
- RefTarget 加 frame 偏移链字段;resolvePoint 跨 frame 累加偏移算绝对坐标。
- Chrome <125 fallback:跨源 iframe 当不透明 leaf(URL + 中心点)。

## 顺序
Tier A 先(本次)。Tier B 单独立项(标注 Chrome 125+ 要求)。
