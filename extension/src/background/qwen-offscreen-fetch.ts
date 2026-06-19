/**
 * qwen-offscreen-fetch.ts — qwen API 请求经隐藏 offscreen 文档里的 chat.qwen.ai
 * iframe 代发(无 tab、无界面)。
 *
 * 替代 qwen-page-fetch.ts(经可见 qwen tab)的无-tab 版本。offscreen 文档托管一个
 * chat.qwen.ai iframe,baxia 在其中运行 → 原生 fetch 自动注入新鲜 bx-ua + 带浏览器
 * 共享 cookie(含过滑块后的 x5sec)→ 过 completions 风控(实测 2026-06-13:
 * SW/Node 直发或复制 bx-ua 都撞 RGV587,只有真页面环境过)。见 memory
 * qwen-bxua-needs-page-env。
 *
 * 返回 Response-like 鸭子对象 {ok,status,text(),body.getReader()},processSSEStream
 * 可直接消费,与 qwenPageFetch 的返回完全一致 → platformFetch 里二选一即可。
 *
 * 通道(offscreen 只能用 chrome.runtime 消息,无 tabs.connect):
 *   SW --runtime.sendMessage({target:'offscreen'})--> offscreen.js
 *   offscreen.js --iframe.postMessage--> qwen-iframe content.js --> page-bridge(原生fetch)
 *   回程: page-bridge --> content --> offscreen.js --runtime.sendMessage({target:'sw'})--> SW
 */

const OFFSCREEN_URL = 'offscreen.html'

// SW ↔ offscreen 消息类型(与 offscreen/index.ts 对齐)。
const MSG_PING = 'PIERCODE_OFFSCREEN_PING'
const MSG_FETCH = 'PIERCODE_OFFSCREEN_FETCH'
const MSG_ABORT = 'PIERCODE_OFFSCREEN_ABORT'
const MSG_HEAD = 'PIERCODE_OFFSCREEN_HEAD'
const MSG_CHUNK = 'PIERCODE_OFFSCREEN_CHUNK'
const MSG_DONE = 'PIERCODE_OFFSCREEN_DONE'
const MSG_ERROR = 'PIERCODE_OFFSCREEN_ERROR'
const MSG_READY = 'PIERCODE_OFFSCREEN_READY'

const FIRST_RESPONSE_TIMEOUT_MS = 30_000
const IFRAME_READY_TIMEOUT_MS = 30_000

let requestSeq = 0
let creating: Promise<void> | null = null
let iframeReady = false
const readyWaiters: Array<() => void> = []

interface OffscreenFetchResult {
  ok: boolean
  status: number
  text(): Promise<string>
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
}

// 每个 in-flight 请求的回调集合,按 requestId 路由 SW 收到的流式消息。
interface PendingReq {
  onHead(ok: boolean, status: number): void
  onChunk(b64: string): void
  onDone(): void
  onError(err: string): void
}
const pending = new Map<string, PendingReq>()

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 单一全局监听器:offscreen → SW 的所有回传消息都过这里,按 requestId 分发。
let listenerInstalled = false
function installListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || msg.target !== 'sw') return
    if (msg.type === MSG_READY) {
      iframeReady = true
      readyWaiters.splice(0).forEach(fn => fn())
      return
    }
    const req = typeof msg.requestId === 'string' ? pending.get(msg.requestId) : undefined
    if (!req) return
    switch (msg.type) {
      case MSG_HEAD: req.onHead(msg.ok === true, Number(msg.status) || 0); break
      case MSG_CHUNK: if (typeof msg.b64 === 'string') req.onChunk(msg.b64); break
      case MSG_DONE: req.onDone(); break
      case MSG_ERROR: req.onError(String(msg.error || 'offscreen fetch failed')); break
    }
  })
}

async function hasOffscreen(): Promise<boolean> {
  // chrome.offscreen.hasDocument exists on newer Chrome; fall back to getContexts.
  try {
    const off = chrome.offscreen as unknown as { hasDocument?: () => Promise<boolean> }
    if (typeof off?.hasDocument === 'function') {
      return await off.hasDocument()
    }
  } catch { /* fall through */ }
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

// Tear down a stale/half-loaded offscreen document so the next ensureOffscreen rebuilds
// it from scratch. Used by the ready-timeout retry: a qwen iframe that didn't signal
// ready in time (slow/blocked load, SW-restart race) is more likely to recover from a
// fresh document than from re-pinging a wedged one.
async function closeOffscreen(): Promise<void> {
  iframeReady = false
  creating = null
  readyWaiters.splice(0)   // drop stale resolvers from the timed-out attempt
  try { await chrome.offscreen.closeDocument() } catch { /* none open / already closing */ }
}

async function ensureOffscreenOnce(): Promise<void> {
  installListener()
  if (await hasOffscreen()) {
    // 文档已在,但 iframe 可能尚未 ready(SW 重启场景)。等一次 ready。
    if (!iframeReady) await pingForReady()
    return
  }
  if (creating) return creating
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['IFRAME_SCRIPTING' as chrome.offscreen.Reason],
        justification: 'Run chat.qwen.ai baxia in a hidden frame to obtain a valid bx-ua for the Qwen API (no visible tab).',
      })
    } catch (e) {
      // 并发创建竞态:已存在则忽略。
      if (!(await hasOffscreen())) throw e
    } finally {
      creating = null
    }
    await waitForReady()
  })()
  return creating
}

async function ensureOffscreen(): Promise<void> {
  try {
    await ensureOffscreenOnce()
  } catch (e) {
    // The qwen iframe is flaky to load (risk-control page); a single rebuild clears most
    // transient ready-timeouts. If the rebuild also fails, surface a clearer message.
    if (!(e instanceof Error) || !/未在 30s 内就绪/.test(e.message)) throw e
    await closeOffscreen()
    try {
      await ensureOffscreenOnce()
    } catch {
      throw new Error('qwen 风控页(offscreen 隐藏 iframe)两次都未在 30s 内加载就绪——可能 chat.qwen.ai 不可达/加载过慢,或需要在 qwen 网页重新登录。稍后重试或先在 qwen 标签页确认能正常打开。')
    }
  }
}

async function pingForReady(): Promise<void> {
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: MSG_PING })
    if (r?.ready) { iframeReady = true; return }
  } catch { /* offscreen not answering yet */ }
  await waitForReady()
}

function waitForReady(): Promise<void> {
  if (iframeReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('offscreen qwen iframe 未在 30s 内就绪')), IFRAME_READY_TIMEOUT_MS)
    readyWaiters.push(() => { clearTimeout(timer); resolve() })
  })
}

/**
 * 经 offscreen iframe 发一个 qwen API 请求。签名约定与 qwenPageFetch 一致。
 */
export async function qwenOffscreenFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; stream: boolean },
  abortSignal?: AbortSignal,
): Promise<OffscreenFetchResult> {
  await ensureOffscreen()

  const requestId = `pcof-${Date.now()}-${++requestSeq}`

  return new Promise<OffscreenFetchResult>((resolve, reject) => {
    let settled = false
    let head: { ok: boolean; status: number } | null = null
    let nonStreamText = ''
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject(new Error('offscreen qwen 请求超时（30s 无响应）')) }
    }, FIRST_RESPONSE_TIMEOUT_MS)

    function cleanup() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null }
      abortSignal?.removeEventListener('abort', onAbort)
      pending.delete(requestId)
    }

    function onAbort() {
      chrome.runtime.sendMessage({ target: 'offscreen', type: MSG_ABORT, requestId }).catch(() => {})
      if (streamController) { try { streamController.error(new DOMException('Aborted', 'AbortError')) } catch {} }
      if (!settled) { settled = true; reject(new DOMException('Aborted', 'AbortError')) }
      cleanup()
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return }
      abortSignal.addEventListener('abort', onAbort)
    }

    function resolveStreaming() {
      const body = {
        getReader(): ReadableStreamDefaultReader<Uint8Array> {
          const rs = new ReadableStream<Uint8Array>({ start(c) { streamController = c } })
          return rs.getReader()
        },
      }
      resolve({ ok: head!.ok, status: head!.status, text: async () => nonStreamText, body })
    }

    pending.set(requestId, {
      onHead(ok, status) {
        if (firstTimer) { clearTimeout(firstTimer); firstTimer = null }
        head = { ok, status }
        if (init.stream && !settled) { settled = true; resolveStreaming() }
      },
      onChunk(b64) {
        if (init.stream) {
          if (streamController) { try { streamController.enqueue(base64ToBytes(b64)) } catch {} }
        } else {
          nonStreamText += new TextDecoder().decode(base64ToBytes(b64))
        }
      },
      onDone() {
        if (init.stream) {
          if (streamController) { try { streamController.close() } catch {} }
        } else if (!settled) {
          settled = true
          const h = head || { ok: true, status: 200 }
          resolve({ ok: h.ok, status: h.status, text: async () => nonStreamText, body: null })
        }
        cleanup()
      },
      onError(err) {
        const e = new Error(err)
        if (init.stream && streamController) { try { streamController.error(e) } catch {} }
        if (!settled) { settled = true; reject(e) }
        cleanup()
      },
    })

    chrome.runtime.sendMessage({
      target: 'offscreen', type: MSG_FETCH, requestId,
      url, method: init.method, headers: init.headers, body: init.body, stream: init.stream,
    }).catch(e => {
      if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))) }
      cleanup()
    })
  })
}
