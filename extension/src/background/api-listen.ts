/**
 * api-listen.ts — 被动监听通道 (service-worker 端)
 *
 * 与 qwen-page-fetch.ts (主动代发) 相反:这里不由 SW 发起请求。AI 页面用自己的
 * 原生 fetch 发送 (签名/cookie/turnstile 天然带上),page-bridge 在 MAIN world
 * monkey-patch window.fetch,把命中聊天 API 的 SSE 响应 tee() 出一份副本,经
 * content port 逐块回传到这里。我们用同一套 processSSEStream 解析,广播
 * CHAT_STREAM/CHAT_THINKING/CHAT_TOOLS 给侧边栏 —— 解析/UI 管线与主动路径共用。
 *
 * 通道: page-bridge --window.postMessage--> content --runtime.connect(port)--> SW
 * port 名: `piercode-api-listen:<requestId>`
 */

import {
  PLATFORMS,
  processSSEStream,
  extractToolCalls,
  type FetchLike,
  type SSEResult,
} from './chat-api'

const PORT_PREFIX = 'piercode-api-listen:'

/** base64 → Uint8Array (content→SW 段 chunk 用 base64 透传,JSON port 无二进制)。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 可逐块喂入的流式 FetchLike 构造器。返回 fetchLike 鸭子对象 + 控制句柄。
 *  processSSEStream 只用 .body.getReader()/.ok/.status,故无需真 Response。
 *  导出供单测直接驱动 (无浏览器)。 */
export function makeStreamingFetchLike(ok: boolean, status: number): {
  fetchLike: FetchLike
  enqueue: (bytes: Uint8Array) => void
  close: () => void
  error: (e: unknown) => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  // 在 getReader 之前到达的 chunk 先缓存,建流时回放,避免丢首块。
  const pending: Uint8Array[] = []
  let closedEarly = false
  let erroredEarly: unknown = null

  const fetchLike: FetchLike = {
    ok,
    status,
    async text() {
      return ''
    },
    body: {
      getReader(): ReadableStreamDefaultReader<Uint8Array> {
        const rs = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            for (const b of pending) c.enqueue(b)
            pending.length = 0
            if (erroredEarly !== null) { try { c.error(erroredEarly) } catch {} }
            else if (closedEarly) { try { c.close() } catch {} }
          },
        })
        return rs.getReader()
      },
    },
  }

  return {
    fetchLike,
    enqueue(bytes: Uint8Array) {
      if (controller) { try { controller.enqueue(bytes) } catch {} }
      else pending.push(bytes)
    },
    close() {
      if (controller) { try { controller.close() } catch {} }
      else closedEarly = true
    },
    error(e: unknown) {
      if (controller) { try { controller.error(e) } catch {} }
      else erroredEarly = e
    },
  }
}

type Broadcast = (msg: Record<string, unknown>) => void

/** 消费一条被监听到的 SSE 流:跑 processSSEStream,广播流式内容/思考,
 *  结束后抽取工具调用广播 CHAT_TOOLS。返回解析结果供调用方决定后续 (执行/续跑)。
 *  导出供单测。 */
export async function consumeListenStream(
  platform: string,
  fetchLike: FetchLike,
  broadcast: Broadcast,
  abortSignal?: AbortSignal,
): Promise<SSEResult | null> {
  const config = PLATFORMS[platform]
  if (!config) {
    broadcast({ type: 'CHAT_ERROR', error: `未知平台: ${platform}` })
    return null
  }

  const result = await processSSEStream(
    fetchLike,
    config,
    (chunk) => broadcast({ type: 'CHAT_STREAM', chunk }),
    abortSignal,
    (step) => broadcast({ type: 'CHAT_THINKING', step }),
  )

  const toolCalls = extractToolCalls(result.content)
  if (toolCalls.length > 0) {
    broadcast({ type: 'CHAT_TOOLS', tools: toolCalls })
  }
  return result
}

/** 流结束后回调:供 chat-api 注入工具续跑 (执行工具 → 注回 tab → 再监听)。 */
type OnComplete = (platform: string, result: SSEResult) => void | Promise<void>

/** 注册 SW 端 onConnect 接收器。content 在监听到聊天 API 响应时打开
 *  `piercode-api-listen:<id>` port,逐帧推 HEAD/CHUNK/DONE/ERROR。
 *  onComplete 在每条流解析完后触发 (工具续跑由 chat-api 提供,避免环形耦合)。 */
export function installApiListenReceiver(
  broadcast: Broadcast,
  onComplete?: OnComplete,
  getAbortSignal?: () => AbortSignal | undefined,
): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return

    let stream: ReturnType<typeof makeStreamingFetchLike> | null = null
    let platform = ''
    let consuming = false

    port.onMessage.addListener((msg: { type?: string; [k: string]: unknown }) => {
      if (!msg) return
      switch (msg.type) {
        case 'PIERCODE_API_LISTEN_HEAD': {
          platform = String(msg.platform || '')
          stream = makeStreamingFetchLike(msg.ok === true, Number(msg.status) || 0)
          if (!consuming) {
            consuming = true
            // 不 await:让流随 chunk 推进。完成后 port 由 content 断开。
            // 传入当前 listen turn 的 abort signal:Stop 后停止广播在途流。
            void consumeListenStream(platform, stream.fetchLike, broadcast, getAbortSignal?.())
              .then((result) => { if (result && onComplete) return onComplete(platform, result) })
              .catch((e) => {
                broadcast({ type: 'CHAT_ERROR', error: e instanceof Error ? e.message : String(e) })
              })
          }
          break
        }
        case 'PIERCODE_API_LISTEN_CHUNK': {
          if (stream && typeof msg.b64 === 'string') stream.enqueue(base64ToBytes(msg.b64))
          break
        }
        case 'PIERCODE_API_LISTEN_DONE': {
          stream?.close()
          break
        }
        case 'PIERCODE_API_LISTEN_ERROR': {
          stream?.error(new Error(String(msg.error || 'listen stream error')))
          break
        }
      }
    })

    port.onDisconnect.addListener(() => {
      // tab 关闭/导航 → 收尾,避免 reader 永久挂起。
      stream?.close()
    })
  })
}
