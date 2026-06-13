# qwen 子 agent 风控修复 — offscreen 后台现算 bx-ua（无 tab / 无界面）

## 诊断结论（已验证）

qwen 走 sidebar API 子 agent = SW 直发 `qwenDirectFetch` + 借来的 bx-ua。

实测证据（chat.qwen.ai 控制台）：
- token 在 `localStorage`（209 字 JWT，有效），不在 cookie；`__bx_storage__` 在
- baxia SDK 正常加载（`baxiaCommon.js` / `baxia-entry`，`window.fetch` 被改写）
- **裸 / 复用 bx-ua 请求 → 立即触发验证码（RGV587）**
- 人工过验证码后 `getUA()` 出 1736 字新鲜 bx-ua → 连发两次 `/chats/new` 均 200

根因（双重）：
1. **broker 缓存复用**：`qwen-bxua-broker.ts` 把第一次借到的 bx-ua `cached` 后反复 replay。
   qwen 已收紧——bx-ua 是**一次性 / 短时效**，复用即 RGV587。memory `qwen-bxua-borrow-once`
   （"借一次复用"）已失效。
2. **撞墙账号 getUA 返回截断值**（~1312 字，`page-bridge/index.ts:254`）：页面一旦进 punish 态，
   再 `getUA()` 也是坏值，SW retry 重借仍坏 → 死循环。

`borrowBxUa()`（`page-bridge/index.ts:257`）本身已是**每次现算**（`baxiaCommon.getUA()`，非缓存）——
问题不在借，在 broker 缓存复用 + 没有一个"干净未 punish"的 qwen 环境可借。

baxia 物理上必须真浏览器环境（canvas/AWSC 指纹）才能算 bx-ua → SW 无 DOM 不能自算。
逆向移植 AWSC 指纹链不现实（数千行混淆 + qwen 频繁更新）。

## 方案：chrome.offscreen 隐藏文档

无可见 tab、无窗口、用户不可见。offscreen 文档托管一个 `<iframe src=chat.qwen.ai>`，
baxia 在真 qwen origin 内运行，content script 已自动注入该 iframe（manifest 有 qwen host
perms + `document_start`），复用现成 `piercode-bxua:<id>` port 借**新鲜**（每次重算）bx-ua。

### 为何 offscreen iframe 而非 SW 自托管
- baxia 需 qwen origin 上下文（appKey / pageId / 指纹）。offscreen 文档本身是扩展 origin，
  必须嵌 `iframe src=chat.qwen.ai` 才有真 qwen 环境。
- content.js 注入 all-frames？当前 manifest `content_scripts` **没有** `all_frames`，默认只顶层。
  → 需给 qwen 匹配项加 `all_frames: true`，或用 `chrome.scripting.registerContentScripts`
  动态注册到 iframe（参考 memory `hub-iframe-content-script-registration` 的坑：整批因
  host_permissions 不匹配被拒——这里 qwen 都在 host_perms 内，安全）。
- iframe 嵌 chat.qwen.ai 会被 `X-Frame-Options` / CSP `frame-ancestors` 挡？
  → 需 DNR（declarativeNetRequest）剥离 qwen 响应的 XFO/frame-ancestors，仅对 offscreen 发起的
  子帧请求。参考 memory `multi-ai-hub`（已有 DNR header-strip + Sec-Fetch 伪装的成熟做法）。

## 实施步骤

1. **manifest**
   - `permissions` 加 `"offscreen"`、`"declarativeNetRequest"`
   - `web_accessible_resources` 加 offscreen html + 其 bundle
   - content_scripts qwen 项加 `all_frames: true`（或走动态注册）
   - 加 DNR 规则集剥 chat.qwen.ai 的 `X-Frame-Options` / CSP frame-ancestors（限子帧）

2. **vite.config.ts** 加 offscreen 入口（`src/offscreen/`：html + 一个建 iframe 的 ts）

3. **src/offscreen/**
   - `offscreen.html` + `index.ts`：建 `<iframe src="https://chat.qwen.ai/">`（隐藏即可，文档本身不显示）
   - 等 iframe 内 content script 就绪（握手 ping）

4. **background/**：新增 `ensureQwenOffscreen()`
   - `chrome.offscreen.createDocument({ url, reasons:['IFRAME_SCRIPTING' 或 'DOM_PARSER'], justification })`
   - 已存在则复用（`chrome.offscreen.hasDocument()`）；MV3 单 offscreen 限制需协调（若 chatgpt 等也用要共享）
   - 借 bx-ua 时把 `piercode-bxua` port 目标从"找 qwen tab"改为"offscreen iframe 的 frame"
     - 注意：`chrome.tabs.connect` 连不到 offscreen。offscreen↔SW 用 `chrome.runtime` 消息；
       offscreen→iframe 用 `postMessage`；iframe content script→offscreen 用 `window.parent.postMessage`。
       即多一跳中继：SW ⇄ offscreen ⇄ (postMessage) ⇄ qwen-iframe content ⇄ page-bridge baxia。

5. **broker 改造（关键，独立于 offscreen 也该改）**
   - `qwen-bxua-broker.ts`：**去掉 `cached` 复用**。bx-ua 一次性 → 每个 completions 请求借一个新的。
   - 保留 in-flight dedup（同一请求并发去重），但成功后**不缓存**，下次仍重借。
   - 或：缓存极短 TTL（如 30s）兜并发，过期即弃。
   - `qwenDirectFetch` 的 RGV587 retry 保留（截断值兜底）。

6. **token 来源（次要修复）**
   - qwen `getAuth` 当前读 cookie `token`（已不可靠，token 在 localStorage）。
   - 改：cookie 读不到 → 经 offscreen iframe / content 读页面 `localStorage.token` 回退。

## 风险 / 验证
- offscreen 单实例限制：若多平台都要 offscreen，需排队 / 复用同一文档多 iframe。
- iframe 内 baxia 是否因"非可见 / 非交互"降级出截断 bx-ua → 需实测（keep-alive shim 已防节流，
  offscreen 文档不受 tab 节流，但 baxia 可能查 `document.visibilityState` → 复用 keep-alive shim 伪装）。
- 验证：offscreen 借到的 bx-ua 长度应 ~1560+；连发 N 个子 agent completions 全 200 无 RGV587。
- 手里已有有效样本 `window.__piercode_lastBxUa`（1736 字）可先喂 SW 验证"新鲜 bx-ua + 不复用"能否根治，
  再上 offscreen 自动化。

## 关联 memory
- `qwen-bxua-borrow-once`（需更新：复用已失效 → 改每请求现算 / 不缓存）
- `qwen-baxia-page-fetch-proxy`（page-fetch 经 tab 代发，offscreen 是其无 tab 版）
- `multi-ai-hub`（DNR header-strip + Sec-Fetch 伪装，offscreen iframe 嵌 qwen 复用此法）
- `hub-iframe-content-script-registration`（iframe content script 注册坑）
- `sidebar-api-subagent-parallel`（子 agent 走 API 内存对话，本问题的触发场景）
