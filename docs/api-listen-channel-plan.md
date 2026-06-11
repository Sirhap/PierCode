# 侧边栏「被动监听」通道 (api-listen)

## 动机

侧边栏当前用 service worker 主动 `fetch` AI 平台 API。问题:

- **ChatGPT**:sentinel turnstile token 由页面 hydration 后的 React 内部态派生,
  后台 fetch 造不出 → 死路 (chat-api.ts 标 `NON-FUNCTIONAL`)。
- **Qwen**:baxia `bx-ua` 签名只在真页面里现算 → 需 `qwen-page-fetch` 代发兜底。

风控趋势是把签名绑死页面运行时。**被动监听** 彻底绕开:不再由 SW 发请求,而是让
AI 页面用自己的原生 fetch 发送(签名/cookie/turnstile 天然带上),我们只 **监听**
页面自己的响应流。零伪造请求。

## 架构:page-fetch proxy 的被动反转

```
AI 页面原生 fetch /chat/completions   (签名天然)
  │ page-bridge (MAIN world, document_start)
  │   patch window.fetch → 命中聊天 API 的 event-stream 响应 → body.tee()
  ├─ 原始流 → 还给页面,UI 正常渲染 (零干扰)
  └─ 副本流 → 逐块 base64 → window.postMessage
       │ content/index.ts
       │   AL_HEAD → chrome.runtime.connect('piercode-api-listen:<id>') 开 port
       │   AL_CHUNK/DONE/ERROR → 转发到 SW
       │ background/api-listen.ts (SW)
       │   makeStreamingFetchLike() 重建 Response-like 鸭子流
       └─ consumeListenStream() → 复用 processSSEStream(PLATFORMS[platform])
            → broadcast CHAT_STREAM / CHAT_THINKING / CHAT_TOOLS / (CHAT_ERROR)
```

`processSSEStream` 吃鸭子类型 `FetchLike`(只用 `.body.getReader()`),与 `qwen-page-fetch`
的假 Response 同一套。**解析/分支锚定/UI 管线零改动**。

## 已落地 (读通道 / READ — 已测)

- `background/api-listen.ts` — `makeStreamingFetchLike`(逐块喂入、getReader 前缓存回放)、
  `consumeListenStream`(跑 processSSEStream + 广播 + 抽 piercode-tool)、
  `installApiListenReceiver`(SW `onConnect` 收 `piercode-api-listen:` port)。
- `page-bridge/api-listen.ts` — fetch 拦截 + tee + 逐块回传;`__PIERCODE_API_LISTEN_ON__`
  门控(关时仍 patch 但不 tee,零开销);hostname→平台、端点正则。
- `content/index.ts` — AL_* 帧 → per-request port 转发 SW;`CHAT_LISTEN_SET` 消息 →
  `setApiListen` → 翻页面门控标志。
- `chat-api.ts` — 导出 `processSSEStream/PLATFORMS/extractToolCalls/FetchLike/SSEResult`;
  `registerChatApiHandler` 内 `installApiListenReceiver(broadcast)`。
- 测试 `__tests__/api-listen.test.ts`(5):流重建、qwen 内容抽取、fence→CHAT_TOOLS、
  并行分支丢弃、未知平台报错。全绿;tsc 干净;build 干净。

门控标志默认关。开启后 qwen 端到端读通道即通(打开 chat.qwen.ai tab,翻 ON,在
qwen UI 发消息 → 侧边栏镜像出流式回复 + 检测到的工具卡)。

## 已落地 (发送侧 + 闭环 — 已接线/单测,待浏览器实测)

决策:**全替换 + 后台静默 worker tab + 注回 tab 续跑**。

- `chat-api.ts`
  - `runToolCalls()` — 从 `handleChatRequest` 抽出的工具执行块(question/exec/spawn +
    CHAT_TOOL_DONE),主动路径与监听路径共用;CHAT_TOOLS 由调用方广播,避免双发。
  - `LISTEN_PLATFORMS = {qwen, chatgpt}` + `isListenPlatform()`;`handleChatRequest`
    在 depth 0 命中监听平台 → 早返走 `handleChatRequestViaListen`(主动 fetch 路径仅
    claude/openai 走)。系统/init prompt 前置进消息(页面驱动无 system 槽)。
  - `setListenSendHook(hook)` — tab 驱动注入口(tab 生命周期在 background)。
  - `continueListenTurn(platform, content)` — 监听流结束回调:无工具→CHAT_DONE;有工具→
    `runToolCalls` → `formatToolResults` → 经 hook 注回 tab(页面再发→再监听)。
- `api-listen.ts` 接收器加 `onComplete(platform, result)`,chat-api 注入 `continueListenTurn`。
- `background/index.ts` — `setListenSendHook`:`ensureListenTab`(按平台找/开后台 tab,
  `listenTabByPlatform` 复用,active:false + keep-alive shim 保活)→ poll-send
  `CHAT_LISTEN_SEND` 到 content。
- `content/index.ts` — `CHAT_LISTEN_SEND` handler:`setApiListen(true)` 后 `fillAndSend`
  提交(标志先于提交落地,确保请求被 tee)。
- 测试 `listen-platform.test.ts`(3):`isListenPlatform`、`continueListenTurn` 无工具→CHAT_DONE。

全链:侧边栏 CHAT_REQUEST(qwen/chatgpt)→ handleChatRequestViaListen → hook → 后台
找/开 tab → CHAT_LISTEN_SEND → content 开 relay + fillAndSend → 页面自发 → page-bridge
tee → content port → SW 接收器 → consumeListenStream(广播流式+工具卡)→ continueListenTurn
(执行工具→注回 tab)→ 循环。tsc 干净;381 测全绿;build 干净。

## 浏览器实测 (page-world 半程 — 已验证)

`scripts/listen-channel-e2e.mjs`:隔离 Chrome 加载 `extension/dist`,打开真
`chat.qwen.ai`,CDP `Fetch` 把 `/api/v2/chat/completions` 用假 qwen SSE 兜住(免登录),
把 **构建产物** `page-bridge.js` 注入页面 MAIN world(location 即 qwen →
`installApiListen` patch 真 `window.fetch`),触发页面自身 fetch,抓回 `PIERCODE_API_LISTEN_*`
帧并 base64 解码重建。结果全 PASS:

```
page-bridge ready: {"listenGuard":true,"host":"chat.qwen.ai"}
AL head : {"platform":"qwen","ok":true,"status":200} done=true
reconstructed : "Hello world\n```piercode-tool\n{"name":"read_file",...,"path":"E2E.md"}}\n```"
head/relay bytes/content recon/tool fence : PASS
```

证明真 Chrome 里:fetch patch 生效、`Response.tee()` 不干扰页面、relay 帧字节完整携带
SSE 流 + 工具 fence。运行:`node scripts/listen-channel-e2e.mjs`(需本机 Chrome + 联网)。
SW 半程(`consumeListenStream` 重建流→解析→广播)由 `api-listen.test.ts` 单测覆盖。

## 真实浏览器实测 (已装扩展 + 已登录 qwen — 经 Go 后端 browser_* 工具驱动)

- **读通道**:真实认证流量确证。真签名 `/chat/completions` 响应被 tee → relay 帧解码精确
  重建出模型的 `piercode-tool read_file` fence。
- **双源 bug 实测复现**:监听通道 + content DOM observer **都处理同一条响应**(页面工具卡显示
  `✅ 已执行`,同时监听续跑也 execTool 写了标记文件)。**已修**:`content/index.ts` 加
  `listenModeActive`(setApiListen 置位),`maybeScheduleAutoExecute` 命中时直接 return ——
  监听模式下 DOM 路径只渲染卡片、不执行,SW 监听独占执行+回注(单源)。
- **顺带修构建 bug**:`vite.config.ts` 两个内联插件的正则 `(\w+)` 不匹配压缩别名里的 `$`
  (Rollup 这次把 preload-helper 别名压成 `$s`)→ import 漏进 content.js,content-build 测试
  红。改 `[\w$]+`(JS 标识符合法字符)。
- **闭环回注 未最终实测**:发送侧代码就绪 + 加了诊断(content `runListenSend` 留 DOM 面包屑
  `data-piercode-listen-send` + window-message 测试触发器 `PIERCODE_TEST_LISTEN_SEND`)。
  现场测试受阻于环境污染:反复 reload 攒出 `browser_relays:2`(一活一陈旧),browser_* 命令
  在两个浏览器会话间轮询 → tab 时隐时现,多步测试不可靠。**需一次扩展 reload**(同时:让
  新 build 生效 + 清掉陈旧 relay)后再跑干净闭环。tooling 无法 reload 扩展(chrome:// /
  chrome-extension:// 被 browser_navigate 拒、Chrome 未开调试端口)。

## 待办

1. **干净闭环实测**(扩展 reload 后):侧边栏发消息 → 驱动 tab fillAndSend → 监听 → 工具续跑注回。
2. ChatGPT 部分走 WebSocket;gemini batchexecute;listen 路径接 CHAT_CANCEL(同前)。
2. **ChatGPT**:部分响应走 WebSocket topic 推送(私有 v1 delta),需另 patch `WebSocket`
   (当前只 patch fetch,可能漏流)。
3. **Gemini**:batchexecute 长度前缀分块,非 SSE,单独解析器(二期)。
4. **退役**:发送也走 tab 后,`qwen-page-fetch` 主动代发可逐步移除。
5. **abort/取消**:listen 路径接 `CHAT_CANCEL`(停 fillAndSend / 断 tab relay)。

## 与现有通道关系

- **替代** `qwen-page-fetch` 主动代发(若发送也走 tab):页面本就在发,无需再借页面代发。
- **复活** ChatGPT API 级读取(turnstile 只挡主动调用,挡不住监听页面自己的响应)。
- **顺带消除** DOM 解析旧伤:Monaco 截断、虚拟化丢节点、session-gating 首响应漏检 ——
  SSE 原始字节完整、即时、无渲染层损耗。
