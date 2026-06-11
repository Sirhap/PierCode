/**
 * api-listen.ts — 被动监听通道 (page-bridge / MAIN world)
 *
 * monkey-patch window.fetch。AI 页面用自己的原生 fetch 发聊天请求 (baxia bx-ua /
 * turnstile / cookie 天然带上),我们对命中聊天 API 的 SSE 响应 tee() 出一份副本:
 *   - 原始流 → 还给页面,UI 正常渲染 (零干扰)
 *   - 副本流 → 逐块 base64 → window.postMessage 回 content → SW
 * 与 qwen-page-fetch.ts (SW 主动代发) 相反:这里页面主动发、我们被动读。
 *
 * 开关: content 侧设 window.__PIERCODE_API_LISTEN_ON__ 控制是否回传 (MAIN world
 * 读不到 chrome.storage)。关时仍 patch 但不 tee/不回传,零开销。
 */

const HEAD = 'PIERCODE_API_LISTEN_HEAD'
const CHUNK = 'PIERCODE_API_LISTEN_CHUNK'
const DONE = 'PIERCODE_API_LISTEN_DONE'
const ERROR = 'PIERCODE_API_LISTEN_ERROR'

/** hostname 子串 → 平台 key (与 chat-api PLATFORMS 对齐)。 */
const HOST_PLATFORM: Array<[string, string]> = [
  ['qwen.ai', 'qwen'],
  ['qwenlm.ai', 'qwen'],
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['claude.ai', 'claude'],
]

/** 各平台聊天补全端点 (仅匹配真正产出助手回复的 SSE 流)。 */
const CHAT_API_PATTERNS: Array<[string, RegExp]> = [
  ['qwen', /\/api\/v2\/chat\/completions/],
  ['chatgpt', /\/backend-api\/f?\/?conversation/],
  ['claude', /\/completion\b/],
]

function platformForHost(): string | null {
  const host = location.hostname.toLowerCase()
  for (const [needle, key] of HOST_PLATFORM) if (host.includes(needle)) return key
  return null
}

function isChatApi(url: string, platform: string): boolean {
  for (const [p, re] of CHAT_API_PATTERNS) if (p === platform && re.test(url)) return true
  return false
}

/** Uint8Array → base64 (content↔SW JSON port 无二进制,需 base64 透传)。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[])
  }
  return btoa(bin)
}

function listenOn(): boolean {
  return (window as any).__PIERCODE_API_LISTEN_ON__ === true
}

let reqSeq = 0

/** tee 响应:原始流还给页面,副本流逐块回传。 */
function teeAndRelay(response: Response, platform: string): Response {
  const body = response.body
  if (!body) return response

  const [pageStream, copyStream] = body.tee()
  const requestId = `pal-${reqSeq++}-${platform}`

  window.postMessage({ type: HEAD, requestId, platform, ok: response.ok, status: response.status }, '*')

  const reader = copyStream.getReader()
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) {
          window.postMessage({ type: CHUNK, requestId, b64: bytesToBase64(value) }, '*')
        }
      }
      window.postMessage({ type: DONE, requestId }, '*')
    } catch (e) {
      window.postMessage({ type: ERROR, requestId, error: e instanceof Error ? e.message : String(e) }, '*')
    } finally {
      try { reader.releaseLock() } catch {}
    }
  })()

  // 原始流还给页面,UI 不受影响。
  return new Response(pageStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** 安装 fetch 拦截器。幂等。始终 patch,回传由 listenOn() 门控。 */
export function installApiListen(): void {
  const platform = platformForHost()
  if (!platform) return
  if ((window as any).__PIERCODE_API_LISTEN__) return
  ;(window as any).__PIERCODE_API_LISTEN__ = true

  const originalFetch = window.fetch
  window.fetch = async function (this: typeof globalThis, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args
    const url = typeof input === 'string' ? input : (input as Request)?.url || ''
    const method = ((init as RequestInit)?.method || (input as Request)?.method || 'GET').toUpperCase()

    const response = await originalFetch.apply(this, args)

    if (!listenOn() || method !== 'POST' || !isChatApi(url, platform)) return response

    const ct = response.headers.get('content-type') || ''
    if (!ct.includes('event-stream')) return response

    try {
      return teeAndRelay(response, platform)
    } catch {
      return response
    }
  }
}
