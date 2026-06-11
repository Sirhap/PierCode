/**
 * qwen-page-fetch.ts — Qwen API 请求经真页面 page-context 代发 (绕 baxia 风控)
 *
 * service worker 直接 fetch qwen API 缺 baxia SDK 现算的 `bx-ua`/`bx-umidtoken`
 * 签名头 → 阿里风控弹滑块 (RGV587_ERROR::SM)。本模块把 qwen 请求转发给一个
 * 已打开的 chat.qwen.ai tab,在其 page-world 里调原生 window.fetch(baxia 的
 * XHR/fetch monkey-patch 自动注入 bx-ua),再把响应逐块回传给 SW。
 *
 * 返回一个 Response-like 鸭子对象 {ok,status,text(),body.getReader()},
 * 现有 processSSEStream 可直接消费,无需改其解析/UI 管线。
 *
 * 通道: SW --tabs.connect(port)--> content --window.postMessage--> page-bridge
 *       page-bridge --window.postMessage--> content --port--> SW
 */

const QWEN_TAB_URLS = ['*://chat.qwen.ai/*', '*://qwen.ai/*', '*://*.qwen.ai/*', '*://*.qwenlm.ai/*']

/** 首块超时: page-bridge 应在此窗口内回首个 head/done/error,否则视为失败。 */
const FIRST_RESPONSE_TIMEOUT_MS = 30_000

let requestSeq = 0

interface PageFetchResult {
  ok: boolean
  status: number
  /** 非流式: 整段响应文本。流式: 调 body.getReader() 取字节流。 */
  text(): Promise<string>
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
}

/** base64 → Uint8Array (content→SW 段 chunk 用 base64 透传,JSON port 无法带二进制)。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 找一个可用的 qwen tab。优先 active,其次任意 qwen tab。 */
async function findQwenTab(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: QWEN_TAB_URLS })
  if (tabs.length === 0) return null
  // active 的优先(baxia 状态最新、最不易被节流)。
  const active = tabs.find(t => t.active && typeof t.id === 'number')
  if (active?.id != null) return active.id
  const first = tabs.find(t => typeof t.id === 'number')
  return first?.id ?? null
}

/**
 * 经活动 qwen tab 的 page-context 发一个 qwen API 请求。
 *
 * @param init.stream true=SSE 流式 (completions),false=一次性 JSON (chats/new)
 * 返回 Response-like 对象;失败 throw。
 */
export async function qwenPageFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; stream: boolean },
  abortSignal?: AbortSignal,
): Promise<PageFetchResult> {
  const tabId = await findQwenTab()
  if (tabId == null) {
    throw new Error('无可用的 qwen 页面，请先在浏览器中打开 chat.qwen.ai 并登录')
  }

  const requestId = `pcpf-${Date.now()}-${++requestSeq}`
  const port = chrome.tabs.connect(tabId, { name: `piercode-page-fetch:${requestId}` })

  return new Promise<PageFetchResult>((resolve, reject) => {
    let settled = false
    let head: { ok: boolean; status: number } | null = null
    let nonStreamText = ''
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject(new Error('qwen 页面代理请求超时（30s 无响应）')) }
    }, FIRST_RESPONSE_TIMEOUT_MS)

    function cleanup() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null }
      abortSignal?.removeEventListener('abort', onAbort)
      try { port.disconnect() } catch {}
    }

    function onAbort() {
      try { port.postMessage({ type: 'PIERCODE_PAGE_FETCH_ABORT', requestId }) } catch {}
      if (streamController) { try { streamController.error(new DOMException('Aborted', 'AbortError')) } catch {} }
      if (!settled) { settled = true; reject(new DOMException('Aborted', 'AbortError')) }
      cleanup()
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return }
      abortSignal.addEventListener('abort', onAbort)
    }

    // 流式: 构造 Response-like 并立即 resolve,让 processSSEStream 开始读流。
    function resolveStreaming() {
      const body = {
        getReader(): ReadableStreamDefaultReader<Uint8Array> {
          const rs = new ReadableStream<Uint8Array>({
            start(controller) { streamController = controller },
          })
          return rs.getReader()
        },
      }
      resolve({ ok: head!.ok, status: head!.status, text: async () => nonStreamText, body })
    }

    port.onMessage.addListener((msg: any) => {
      if (!msg || msg.requestId !== requestId) return

      switch (msg.type) {
        case 'PIERCODE_PAGE_FETCH_HEAD': {
          if (firstTimer) { clearTimeout(firstTimer); firstTimer = null }
          head = { ok: msg.ok === true, status: Number(msg.status) || 0 }
          // 流式: 此刻 resolve(streamController 在 getReader 时建)。
          // 非流式: 等 DONE 收齐 text 再 resolve。
          if (init.stream && !settled) { settled = true; resolveStreaming() }
          break
        }
        case 'PIERCODE_PAGE_FETCH_CHUNK': {
          if (typeof msg.b64 !== 'string') break
          if (init.stream) {
            if (streamController) { try { streamController.enqueue(base64ToBytes(msg.b64)) } catch {} }
          } else {
            nonStreamText += new TextDecoder().decode(base64ToBytes(msg.b64))
          }
          break
        }
        case 'PIERCODE_PAGE_FETCH_DONE': {
          if (init.stream) {
            if (streamController) { try { streamController.close() } catch {} }
          } else if (!settled) {
            settled = true
            const h = head || { ok: true, status: 200 }
            resolve({ ok: h.ok, status: h.status, text: async () => nonStreamText, body: null })
          }
          cleanup()
          break
        }
        case 'PIERCODE_PAGE_FETCH_ERROR': {
          const err = new Error(String(msg.error || 'qwen 页面代理请求失败'))
          if (init.stream && streamController) { try { streamController.error(err) } catch {} }
          if (!settled) { settled = true; reject(err) }
          cleanup()
          break
        }
      }
    })

    port.onDisconnect.addListener(() => {
      if (init.stream && streamController) { try { streamController.close() } catch {} }
      if (!settled) { settled = true; reject(new Error('qwen 页面代理连接中断（tab 可能已关闭）')) }
      cleanup()
    })

    try {
      port.postMessage({
        type: 'PIERCODE_PAGE_FETCH',
        requestId,
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        stream: init.stream,
      })
    } catch (e) {
      if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))) }
      cleanup()
    }
  })
}
