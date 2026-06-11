# Qwen page-context fetch proxy (绕 baxia 风控)

## 问题

`extension/src/background/chat-api.ts` 在 **service worker** 里直接 `fetch()` qwen API
(`/api/v2/chats/new`, `/api/v2/chat/completions`)。SW 环境没有加载 qwen 网页的
baxia 反爬 SDK (`g.alicdn.com/sd/baxia/2.5.36/baxiaCommon.js`),该 SDK 在真页面里
monkey-patch 了 `XMLHttpRequest.send` / `fetch`,每次请求自动注入动态签名头
`bx-ua` / `bx-umidtoken`。SW fetch 缺这些头 → 阿里风控评分累积越线 →
`RGV587_ERROR::SM` 滑块墙 (`哎哟喂,被挤爆啦`)。

抓包确认:写死的 `version: 0.2.63` / `bx-v: 2.5.36` **没过期**——真页面此刻仍用
同样的值且成功。根因是缺 baxia 现算的 `bx-ua`,不是版本号陈旧。

## 方案:把 qwen fetch 挪到真 qwen tab 的 page-context 执行

让真页面里的 baxia 替我们签名。SW 不再直接 fetch,而是把请求转发给一个已打开的
`chat.qwen.ai` tab,在它的 page-world 里调原生 `window.fetch`(baxia patch 生效),
再把响应(JSON 或 SSE 流)逐块回传给 SW。

```
SW (chat-api.ts)
  └─ qwenPageFetch(url, headers, body, signal)        [background/qwen-page-fetch.ts 新增]
       ├─ chrome.tabs.query({url: qwen hosts}) 找活动 qwen tab
       ├─ tabs.sendMessage(tabId, {PIERCODE_PAGE_FETCH, requestId, url, headers, body, stream})
       └─ 收 {PIERCODE_PAGE_FETCH_CHUNK/_DONE/_ERROR} → 拼成 Response-like {ok,status,body.getReader(),text()}
content (content/index.ts)
  └─ onMessage(PIERCODE_PAGE_FETCH) → window.postMessage 转给 page-bridge
       └─ 收 page-bridge 的 window message 回包 → chrome.runtime.sendMessage 回 SW (用 port 流式)
page-bridge (page-bridge/index.ts, page-world, baxia 已 patch)
  └─ window.message(PIERCODE_PAGE_FETCH) → window.fetch(url, {headers, body})
       ├─ 非流式: 读 res.text() → 回 {PIERCODE_PAGE_FETCH_DONE, status, ok, text}
       └─ 流式(SSE): res.body.getReader() 逐块 → 回 {PIERCODE_PAGE_FETCH_CHUNK, base64(value)} ... {_DONE}
```

### 关键设计点

1. **Response-like 鸭子类型**:`processSSEStream` 只用 `response.body.getReader()` /
   `.ok` / `.status` / `.text()`。SW 端用收到的 chunk 流构造一个假 Response
   (`ReadableStream` + 这几个字段),喂回现有 `processSSEStream`,
   **parseChunk / parseThinking / 分支锚定 / UI 管线全部不动**。

2. **通用 proxy**:`createConversation`(`/chats/new`, JSON)和 completions(SSE)
   都走同一个 `qwenPageFetch`。`stream` 标志区分:JSON 走一次性 text,SSE 走逐块。

3. **二进制安全**:SSE chunk 是 `Uint8Array`。`window.postMessage` 跨 page↔content
   能传结构化克隆(Uint8Array OK);但 `chrome.runtime.sendMessage` 只能传 JSON →
   content→SW 段把 chunk base64 编码,SW 端 decode 回 Uint8Array 喂给假 Response。
   (qwen SSE 用 `content-encoding: br`,但 page-context fetch 已自动解码,
   `getReader()` 拿到的是解压后的明文字节,无需我们处理 br。)

4. **tab 选取**:`chrome.tabs.query` 匹配 qwen hosts,优先 `__PIERCODE_WS_STATUS__`
   已连接的 tab(probeBridge 复用);没有任何 qwen tab → 回明确错误
   (`无可用的 qwen 页面,请先打开 chat.qwen.ai`),sidebar 显示提示。

5. **abort**:`abortSignal` → SW 发 `{PIERCODE_PAGE_FETCH_ABORT, requestId}` →
   page-bridge `reader.cancel()` + `controller.abort()`。

6. **超时/容错**:首块超时(如 30s 无响应)视为失败回错误;tab 中途关闭
   (sendMessage reject)→ 错误冒泡到 sidebar。

### 仅 qwen 走 proxy

其它平台(chatgpt 走 tab-worker、claude/gemini API 直连)不受影响。
`PlatformConfig` 加可选标志 `usePageFetch?: boolean`,仅 qwen 置 true;
chat-api 的两处 fetch 调用点据此分流:true → `qwenPageFetch`,false → 原生 `fetch`。

## 涉及文件

- `extension/src/background/qwen-page-fetch.ts` (新增) — proxy 函数 + tab 选取 + 假 Response 构造
- `extension/src/background/chat-api.ts` — 两处 fetch 调用点分流;`createConversation`/`buildHeaders` 改为可被 proxy 调用;`PlatformConfig.usePageFetch`
- `extension/src/content/index.ts` — `PIERCODE_PAGE_FETCH` onMessage handler,转发 page-bridge,base64 回传 SW
- `extension/src/page-bridge/index.ts` — page-world fetch 执行 + 逐块 postMessage
- (可能) `extension/src/background/index.ts` — 若 tab 选取逻辑需复用 probeBridge/AI_PAGE_URLS

## 测试

- 单测:假 Response 构造 + base64 round-trip(chunk 字节完整)
- 手测:sidebar 发 qwen 请求 → 抓包确认 `/chat/completions` 带 baxia `bx-ua` →
  不再 `RGV587_ERROR`;关掉所有 qwen tab → 明确报错。
