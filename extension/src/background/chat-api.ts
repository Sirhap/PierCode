/**
 * chat-api.ts — PierCode 侧边栏聊天 API 代理
 *
 * 处理来自侧边栏的 CHAT_REQUEST 消息：
 * 1. 从浏览器 cookie 获取 AI 平台认证
 * 2. 向 AI 平台 API 发起 SSE 流式请求
 * 3. 解析 SSE 响应，提取文本内容
 * 4. 检测 piercode-tool 工具调用块
 * 5. 通过 Go server /exec 执行工具
 * 6. 将工具结果注入对话，递归调用让 AI 继续
 */

import { extractFenceToolCalls, formatToolResults } from '../parser'
import { qwenPageFetch } from './qwen-page-fetch'
import { qwenOffscreenFetch } from './qwen-offscreen-fetch'
import { installApiListenReceiver } from './api-listen'
import { createBxUaBroker, type BxUaCreds } from './qwen-bxua-broker'
import { genSsxmod } from './qwen-ssxmod'

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolCall {
  name: string
  args: Record<string, unknown>
  call_id: string
}

interface ToolResult {
  call_id: string
  name: string
  output: string
  success: boolean
}

export interface PlatformConfig {
  name: string
  cookieName: string
  cookieDomain: string
  /** Create a new conversation on the server, return its ID. */
  createConversation?(token: string, model: string): Promise<string>
  getUrl(ctx?: { chatId?: string; model?: string }): string
  buildHeaders(token: string): Record<string, string> | Promise<Record<string, string>>
  buildBody(message: string, parentId: string | null, ctx?: BuildCtx): string
  parseChunk(data: any): string | null
  /** Optional: extract a thinking-summary step from a delta (Qwen's
   *  thinking_summary phase). Returned steps are shown in a collapsible
   *  "thinking" block, Claude-Code style. Platforms without reasoning return
   *  nothing / omit this. */
  parseThinking?(data: any): { title: string; thought: string } | null
  /** Optional: the per-delta response_id, so processSSEStream can pin to the
   *  primary branch (response_index 0) and drop parallel branches. */
  deltaResponseId?(data: any): string | null
  /** When true, parseChunk returns the cumulative full-text-so-far snapshot on
   *  each event (e.g. ChatGPT's content.parts[0]), not an incremental delta.
   *  processSSEStream then diffs against what it already has instead of
   *  appending, so fullContent isn't duplicated. */
  isSnapshot?: boolean
  /** True if the platform's API accepts a real system role/field. openai +
   *  claude do; qwen + chatgpt use a private web protocol with no system slot,
   *  so the system prompt is prepended to the first user message instead. */
  supportsSystem?: boolean
  /** When true, all API requests for this platform are routed through a real
   *  page tab's context (see qwen-page-fetch.ts) instead of fetched directly
   *  from the service worker. Required for qwen: its endpoints are behind
   *  Aliyun baxia risk control, whose dynamic bx-ua header is only produced by
   *  the SDK running in the real qwen page. A SW fetch lacks it → captcha wall
   *  (RGV587_ERROR). */
  usePageFetch?: boolean
  /** When true, requests route through a hidden offscreen document hosting a
   *  chat.qwen.ai iframe (see qwen-offscreen-fetch.ts) — baxia runs there and
   *  auto-injects a fresh bx-ua, with the browser's shared cookies (incl.
   *  post-滑块 x5sec) clearing completions risk control. No visible tab.
   *  Preferred over usePageFetch for qwen (no open tab required). */
  useOffscreenFetch?: boolean
}

/** Response-like duck type that both window.fetch's Response and qwenPageFetch's
 *  proxy result satisfy. processSSEStream only needs .ok/.status/.text()/.body. */
export interface FetchLike {
  ok: boolean
  status: number
  text(): Promise<string>
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
}

/** Route a request either through the page-context proxy (usePageFetch) or a
 *  direct SW fetch. `stream` selects SSE vs one-shot JSON for the proxy path. */
async function platformFetch(
  config: PlatformConfig,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  stream: boolean,
  signal?: AbortSignal,
): Promise<FetchLike> {
  // qwen offscreen path: run the request inside a hidden chat.qwen.ai iframe so
  // baxia auto-injects a fresh bx-ua + the browser's shared cookies (incl.
  // post-滑块 x5sec) clear completions risk control. No visible tab. This is the
  // ONLY path verified to pass completions (SW direct / copied bx-ua → RGV587;
  // see memory qwen-bxua-needs-page-env).
  if (config.useOffscreenFetch) {
    return qwenOffscreenFetch(url, { ...init, stream }, signal)
  }
  if (config.usePageFetch) {
    return qwenPageFetch(url, { ...init, stream }, signal)
  }
  // qwen direct path (legacy fallback): detect RGV587 risk control on the
  // response; on hit, invalidate the cached bx-ua, re-borrow, retry once.
  if (config.name === 'Qwen') {
    return qwenDirectFetch(config, url, init, signal)
  }
  return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal })
}

/** Swap the bx-ua / ssxmod risk headers on a header set to whatever the broker
 *  now holds (after an invalidate, this re-borrows; if borrow fails it lands on
 *  ssxmod). Other headers (auth, origin, etc.) are preserved. */
async function refreshQwenRiskHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
  const next = { ...headers }
  delete next['bx-ua']
  delete next['bx-umidtoken']
  delete next['Cookie']
  await applyQwenRiskHeaders(next)
  return next
}

/** qwen direct send with one RGV587-aware retry. A successful completions call
 *  returns a `text/event-stream`; risk control instead returns JSON containing
 *  RGV587/punish. We only consume (and thus burn) the body when it is NOT an
 *  event-stream, so the SSE body stays intact for processSSEStream on success. */
async function qwenDirectFetch(
  _config: PlatformConfig,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  signal?: AbortSignal,
): Promise<FetchLike> {
  const send = (headers: Record<string, string>): Promise<Response> =>
    fetch(url, { method: init.method, headers, body: init.body, credentials: 'include', signal })

  const isStream = (r: Response) => (r.headers.get('content-type') || '').includes('event-stream')
  const isPunish = (t: string) => t.includes('RGV587') || t.includes('punish') || t.includes('aliyun_waf')

  let res = await send(init.headers)
  if (isStream(res)) return res

  // Non-stream: peek the body to tell risk control apart from a business error.
  const text = await res.text()
  if (!isPunish(text)) {
    // Business error / non-stream JSON — surface as-is (body already consumed).
    return { ok: res.ok, status: res.status, text: async () => text, body: null }
  }

  // RGV587 → re-borrow bx-ua + retry once.
  qwenBxUaBroker.invalidate()
  const retryHeaders = await refreshQwenRiskHeaders(init.headers)
  res = await send(retryHeaders)
  if (isStream(res)) return res
  const t2 = await res.text()
  return { ok: false, status: res.status, text: async () => t2, body: null }
}

interface BuildCtx {
  chatId?: string
  model?: string
  /** System prompt. Platforms with supportsSystem put it in a real system
   *  field; others have it pre-merged into `message` by the caller. */
  systemPrompt?: string
  /** Per-platform "thinking level" key from the sidebar picker (see
   *  sidebar/reasoning.ts). 'off' = no reasoning everywhere; the rest are
   *  platform-scoped ('fast'/'think'/'auto' for qwen, 'low'/'medium'/'high'
   *  for openai, etc.). Each buildBody maps its own keys onto request fields
   *  and ignores keys it doesn't recognise. Undefined → platform default. */
  reasoning?: string
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum tool-call recursion depth per user request. Prevents infinite loops
 *  when the AI keeps emitting piercode-tool blocks (prompt injection / bugs). */
const MAX_TOOL_DEPTH = 10

// ── Qwen bx-ua borrow ────────────────────────────────────────────────────────
// Borrow a baxia bx-ua from an open qwen tab via the content↔page-bridge relay
// (piercode-bxua port). Returns null if no qwen tab is open or capture fails.
const QWEN_TAB_URLS_BXUA = ['*://chat.qwen.ai/*', '*://qwen.ai/*', '*://*.qwen.ai/*']
let bxuaSeq = 0

async function borrowBxUaFromTab(): Promise<BxUaCreds | null> {
  const tabs = await chrome.tabs.query({ url: QWEN_TAB_URLS_BXUA })
  const tab = tabs.find(t => t.active && typeof t.id === 'number') ?? tabs.find(t => typeof t.id === 'number')
  if (!tab?.id) return null
  const requestId = `bxua-${Date.now()}-${++bxuaSeq}`
  const port = chrome.tabs.connect(tab.id, { name: `piercode-bxua:${requestId}` })
  return new Promise<BxUaCreds | null>(resolve => {
    let settled = false
    const done = (v: BxUaCreds | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { port.disconnect() } catch { /* gone */ }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 10_000)
    port.onMessage.addListener((msg: { ok?: boolean; bxUa?: string; umid?: string }) => {
      if (msg?.ok && msg.bxUa) done({ bxUa: msg.bxUa, umid: msg.umid || '' })
      else done(null)
    })
    port.onDisconnect.addListener(() => done(null))
  })
}

const qwenBxUaBroker = createBxUaBroker(borrowBxUaFromTab)

// Attach the primary bx-ua signature (replayed from the borrow cache) onto a
// qwen request's headers. If no tab is available to borrow from, fall back to
// locally generated ssxmod cookies. Shared by createConversation + buildHeaders.
async function applyQwenRiskHeaders(headers: Record<string, string>): Promise<void> {
  const creds = await qwenBxUaBroker.getBxUa()
  if (creds) {
    headers['bx-ua'] = creds.bxUa
    if (creds.umid) headers['bx-umidtoken'] = creds.umid
  } else {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod()
    headers['Cookie'] = `ssxmod_itna=${ssxmod_itna};ssxmod_itna2=${ssxmod_itna2}`
  }
}

// ── Platform Configs ───────────────────────────────────────────────────────
// Note: `getUrl()` is a function, not a mutable field, to avoid module-level
// state mutation that would cause races if two requests run concurrently.

// Exported for unit tests (buildBody reasoning mapping). Not used elsewhere.
export const PLATFORMS: Record<string, PlatformConfig> = {
  qwen: {
    name: 'Qwen',
    cookieName: 'token',
    cookieDomain: 'chat.qwen.ai',
    // Route all qwen requests through the hidden offscreen chat.qwen.ai iframe
    // so baxia injects a fresh bx-ua and shared cookies (incl. post-滑块 x5sec)
    // clear risk control. No visible tab. See qwen-offscreen-fetch.ts.
    useOffscreenFetch: true,
    async createConversation(token, model) {
      // Qwen's web client echoes the `xsrf-token` cookie back as an x-xsrf-token
      // header. The offscreen iframe's page-bridge sends the request from the
      // real qwen page so baxia adds bx-ua/bx-umidtoken and credentials:'include'
      // carries cookies; we still pass Authorization + x-xsrf-token here.
      const xsrf = await getCookieToken('chat.qwen.ai', 'xsrf-token')
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      }
      const res = await qwenOffscreenFetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers,
        stream: false,
        body: JSON.stringify({
          title: '新建对话',
          models: [model],
          chat_mode: 'normal',
          chat_type: 't2t',
          timestamp: Math.floor(Date.now() / 1000),
          project_id: '',
        }),
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`创建会话失败 ${res.status}: ${text.slice(0, 200)}`)
      }
      let data: any
      try { data = JSON.parse(text) } catch { throw new Error(`创建会话失败: 响应非 JSON: ${text.slice(0, 200)}`) }
      if (!data.success || !data.data?.id) {
        throw new Error(`创建会话失败: ${JSON.stringify(data)}`)
      }
      return data.data.id
    },
    getUrl(ctx) {
      const chatId = ctx?.chatId || crypto.randomUUID()
      return `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`
    },
    async buildHeaders(token) {
      // Primary path: replay a borrowed baxia bx-ua so a clean SW fetch clears
      // risk control; no tab to borrow from → ssxmod cookie fallback. The
      // x-xsrf-token (mirrored from the cookie) is still sent when present.
      const xsrf = await getCookieToken('chat.qwen.ai', 'xsrf-token')
      const base: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'bx-v': '2.5.36',
        ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      }
      await applyQwenRiskHeaders(base)
      return base
    },
    buildBody(message, parentId, ctx) {
      const chatId = ctx?.chatId || crypto.randomUUID()
      const model = ctx?.model || 'qwen3.7-plus'
      const now = Math.floor(Date.now() / 1000)
      const fid = crypto.randomUUID()

      // Map the sidebar thinking-level key onto Qwen's feature_config knobs.
      // Default ('off') keeps the original behaviour (no deep thinking) so the
      // model emits tool calls directly instead of analysing for pages.
      const r = ctx?.reasoning || 'off'
      const thinkingCfg =
        r === 'auto'  ? { thinking_enabled: true,  auto_thinking: true,  thinking_mode: 'Thinking' } :
        r === 'think' ? { thinking_enabled: true,  auto_thinking: false, thinking_mode: 'Thinking' } :
        r === 'fast'  ? { thinking_enabled: true,  auto_thinking: false, thinking_mode: 'Fast' } :
                        { thinking_enabled: false, auto_thinking: false, thinking_mode: 'Fast' }

      const msg: Record<string, unknown> = {
        fid,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: message,
        user_action: 'chat',
        files: [],
        timestamp: now,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          ...thinkingCfg,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_search: true,
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
      }

      return JSON.stringify({
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        model,
        parent_id: parentId || null,
        messages: [msg],
        timestamp: now,
      })
    },
    parseChunk(data) {
      // Qwen SSE: only the "answer" phase carries the real reply. Skip
      // thinking_summary (→ parseThinking) and code_interpreter (the model's
      // internal "preview" of a tool call, display_position:"think" — not a real
      // piercode-tool call; the real one is re-emitted in the answer phase).
      const delta = data.choices?.[0]?.delta
      if (!delta) return null
      if (delta.phase === 'answer' && typeof delta.content === 'string') {
        return delta.content
      }
      return null
    },
    parseThinking(data) {
      const delta = data.choices?.[0]?.delta
      if (!delta || delta.phase !== 'thinking_summary') return null
      // summary_title / summary_thought accumulate as arrays; take the latest.
      const titles = delta.extra?.summary_title?.content
      const thoughts = delta.extra?.summary_thought?.content
      const title = Array.isArray(titles) ? String(titles[titles.length - 1] || '') : ''
      const thought = Array.isArray(thoughts) ? String(thoughts[thoughts.length - 1] || '') : ''
      if (!title && !thought) return null
      return { title, thought }
    },
    deltaResponseId(data) {
      return typeof data.response_id === 'string' ? data.response_id : null
    },
    // qwen sends direct from the SW with a borrowed bx-ua (see qwenDirectFetch);
    // no page-fetch proxy. RGV587 → re-borrow + retry once → ssxmod fallback.
  },

  chatgpt: {
    name: 'ChatGPT',
    cookieName: '__Secure-next-auth.session-token',
    cookieDomain: 'chatgpt.com',
    supportsSystem: true,
    // ChatGPT's web backend gates every message behind a Cloudflare Turnstile
    // token that only the live page can mint, so a background fetch can't drive
    // /backend-api/conversation directly. Instead we go through the local
    // chatgpt-proxy (see piercode/chatgpt-proxy/), which solves the sentinel
    // (PoW + Turnstile) chain server-side and exposes an OpenAI-compatible
    // /v1/chat/completions. getAuth('chatgpt') resolves the proxy URL + a dummy
    // token; the proxy reads the user's chatgpt.com cookies itself. The request
    // and SSE shape below are therefore plain OpenAI, identical to the 'openai'
    // platform. If the proxy isn't running, getAuth returns an error and the
    // sub-agent fails fast (no tab-worker fallback by design).
    getUrl() {
      // Resolved per-request from storage via getAuth().
      return ''
    },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      }
    },
    buildBody(message, _parentId, ctx) {
      const messages: Array<{ role: string; content: string }> = []
      if (ctx?.systemPrompt) messages.push({ role: 'system', content: ctx.systemPrompt })
      messages.push({ role: 'user', content: message })
      // 'think' selects a thinking slug; otherwise let the proxy/ChatGPT
      // auto-route. The proxy maps these to ChatGPT web model slugs.
      const model = ctx?.reasoning === 'think' ? 'gpt-5-thinking' : (ctx?.model || 'gpt-5')
      return JSON.stringify({ model, messages, stream: true })
    },
    parseChunk(data) {
      return data.choices?.[0]?.delta?.content || null
    },
  },

  claude: {
    name: 'Claude',
    cookieName: 'sessionKey',
    cookieDomain: 'claude.ai',
    // claude.ai's web /completion endpoint has no system slot — the init
    // prompt is prepended to the first user message instead. (The old config
    // POSTed a public-API shaped body straight to /chat_conversations — the
    // conversation-CREATE endpoint — which 400'd with "name: Field required".)
    supportsSystem: false,
    async createConversation(token) {
      const orgId = await getClaudeOrgId(token)
      const uuid = crypto.randomUUID()
      const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://claude.ai',
          'Referer': 'https://claude.ai/',
        },
        body: JSON.stringify({ uuid, name: '' }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`claude.ai 创建会话失败 ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json().catch(() => null)
      return (data?.uuid as string) || uuid
    },
    getUrl(ctx) {
      // Org id resolved by getAuth() before any turn; chatId by createConversation.
      if (!claudeOrgId || !ctx?.chatId) return ''
      return `https://claude.ai/api/organizations/${claudeOrgId}/chat_conversations/${ctx.chatId}/completion`
    },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/',
      }
    },
    buildBody(message, parentId) {
      // Web protocol: conversation state lives server-side; each turn posts the
      // prompt (+ parent message uuid when we have one) to /completion.
      const body: Record<string, unknown> = {
        prompt: message,
        parent_message_uuid: parentId || '00000000-0000-4000-8000-000000000000',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        attachments: [],
        files: [],
        rendering_mode: 'messages',
      }
      return JSON.stringify(body)
    },
    parseChunk(data) {
      // claude.ai streams `{"type":"completion","completion":"..."}` chunks;
      // newer responses may use public-API content_block_delta shapes.
      if (typeof data.completion === 'string') return data.completion
      if (data.type === 'content_block_delta' && data.delta?.text) {
        return data.delta.text
      }
      return null
    },
    deltaResponseId(data) {
      // Thread the assistant message uuid as next turn's parent when present.
      const id = data.message?.uuid ?? data.uuid ?? data.parent_uuid
      return typeof id === 'string' ? id : null
    },
  },

  openai: {
    name: 'OpenAI 兼容',
    cookieName: '',
    cookieDomain: '',
    supportsSystem: true,
    getUrl() {
      // Resolved per-request from storage
      return ''
    },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      }
    },
    buildBody(message, _parentId, ctx) {
      const messages: Array<{ role: string; content: string }> = []
      if (ctx?.systemPrompt) messages.push({ role: 'system', content: ctx.systemPrompt })
      messages.push({ role: 'user', content: message })
      const body: Record<string, unknown> = {
        model: ctx?.model || 'gpt-4o',
        messages,
        stream: true,
      }
      // OpenAI reasoning models accept reasoning_effort=low|medium|high. Only
      // send it for an explicit level: non-reasoning models reject the unknown
      // field on some gateways, so 'off' (default) omits it entirely.
      const r = ctx?.reasoning
      if (r === 'low' || r === 'medium' || r === 'high') {
        body.reasoning_effort = r
      }
      return JSON.stringify(body)
    },
    parseChunk(data) {
      return data.choices?.[0]?.delta?.content || null
    },
  },
}

// ── State ──────────────────────────────────────────────────────────────────

let currentAbort: AbortController | null = null

// Per-sub-agent abort controllers, keyed by agentId. Lets a single worker be
// cancelled without touching the global currentAbort or sibling workers.
const agentAborts = new Map<string, AbortController>()

// mergedAgentSignal returns a signal that aborts when EITHER this agent's own
// controller fires (single-worker cancel) OR the outer signal fires (global
// stop). Borrowed from Claude Code's capacityWake.ts signal-merge primitive.
// cleanup() removes listeners and the map entry — call in finally.
export function mergedAgentSignal(
  agentId: string,
  outer: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const own = new AbortController()
  agentAborts.set(agentId, own)
  const merged = new AbortController()
  const onAbort = () => merged.abort()
  if (own.signal.aborted || outer?.aborted) {
    merged.abort()
  } else {
    own.signal.addEventListener('abort', onAbort, { once: true })
    outer?.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: merged.signal,
    cleanup: () => {
      own.signal.removeEventListener('abort', onAbort)
      outer?.removeEventListener('abort', onAbort)
      agentAborts.delete(agentId)
    },
  }
}

// Test-only accessor for the abort map.
export function __agentAbortsForTest(): Map<string, AbortController> {
  return agentAborts
}

// ── Claude org cache ─────────────────────────────────────────────────────────

// claude.ai org id, resolved once per SW lifetime (re-fetched after SW restart).
let claudeOrgId: string | null = null

async function getClaudeOrgId(token: string): Promise<string> {
  if (claudeOrgId) return claudeOrgId
  const res = await fetch('https://claude.ai/api/organizations', {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`无法获取 Claude 组织信息（HTTP ${res.status}），请确认已登录 claude.ai`)
  const orgs = await res.json().catch(() => null)
  if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0]?.uuid) {
    throw new Error('无法获取 Claude 组织信息，请确认已登录 claude.ai')
  }
  claudeOrgId = orgs[0].uuid as string
  return claudeOrgId
}

// ── Cookie Auth ────────────────────────────────────────────────────────────

async function getCookieToken(domain: string, name: string): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({ url: `https://${domain}/`, name })
    return cookie?.value || null
  } catch {
    return null
  }
}

interface AuthResult {
  token: string
  /** Override URL for platforms that resolve it dynamically (Claude, OpenAI). */
  url?: string
}

async function getAuth(platform: string): Promise<AuthResult | { error: string }> {
  const config = PLATFORMS[platform]
  if (!config) return { error: `未知平台: ${platform}` }

  // OpenAI 兼容：从 storage 获取 API key + base URL
  if (platform === 'openai') {
    const result = await chrome.storage.local.get(['openaiApiKey', 'openaiBaseUrl'])
    if (!result.openaiApiKey) return { error: '请在设置中配置 OpenAI API Key' }
    if (!result.openaiBaseUrl) return { error: '请在设置中配置 OpenAI API Base URL' }
    const url = result.openaiBaseUrl.replace(/\/+$/, '') + '/v1/chat/completions'
    return { token: result.openaiApiKey, url }
  }

  // Claude：解析并缓存 org ID；URL 由 getUrl(ctx) 按会话拼出（createConversation
  // → /chat_conversations/{uuid}/completion），这里不返回 url。
  if (platform === 'claude') {
    const token = await getCookieToken(config.cookieDomain, config.cookieName)
    if (!token) return { error: '未找到 Claude sessionKey cookie，请先登录 claude.ai' }
    try {
      await getClaudeOrgId(token)
      return { token }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '无法获取 Claude 组织信息，请确认已登录' }
    }
  }

  // ChatGPT：走本地 chatgpt-proxy（piercode/chatgpt-proxy/），它在 server 端解
  // 完整 sentinel（PoW + Turnstile）链并暴露 OpenAI 兼容 /v1/chat/completions。
  // proxy 自己从 chatgpt.com cookie 取 accessToken，所以这里不需要 token，给个
  // 占位即可；URL 指向 proxy。proxy 未启动则探测失败、明确报错（按设计不回退
  // tab-worker）。地址来自 storage chatgptProxyUrl，默认 127.0.0.1:8765。
  if (platform === 'chatgpt') {
    const stored = await chrome.storage.local.get(['chatgptProxyUrl'])
    const base = (stored.chatgptProxyUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '')
    try {
      const ping = await fetch(`${base}/health`, { method: 'GET' })
      if (!ping.ok) throw new Error(`health ${ping.status}`)
    } catch {
      return { error: `ChatGPT 代理未运行（${base}）。请先启动 chatgpt-proxy（见 chatgpt-proxy/README.md）` }
    }
    return { token: 'chatgpt-proxy', url: `${base}/v1/chat/completions` }
  }

  // Qwen：cookie 认证
  const token = await getCookieToken(config.cookieDomain, config.cookieName)
  if (!token) {
    return { error: `未找到 ${config.name} 的认证 cookie，请先登录 ${config.cookieDomain}` }
  }
  return { token }
}

// ── PierCode Server Exec ───────────────────────────────────────────────────

async function execTool(name: string, args: Record<string, unknown>, callId?: string): Promise<ToolResult> {
  callId = callId || `sidebar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try {
    const { apiUrl, authToken } = await chrome.storage.local.get(['apiUrl', 'authToken'])
    if (!apiUrl || !authToken) {
      return { call_id: callId, name, output: '错误：未连接 PierCode 服务', success: false }
    }

    const res = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name, call_id: callId, args }),
    })

    if (!res.ok) {
      const text = await res.text()
      return { call_id: callId, name, output: `HTTP ${res.status}: ${text}`, success: false }
    }

    const data = await res.json()
    return {
      call_id: callId,
      name,
      output: data.output || data.error || JSON.stringify(data),
      success: !data.error,
    }
  } catch (error) {
    return {
      call_id: callId,
      name,
      output: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    }
  }
}

// ── Question Tool (user interaction) ───────────────────────────────────────

const pendingQuestions = new Map<string, { resolve: (answer: string) => void }>()

/** Ask the user a question via the sidebar. Returns a ToolResult with the answer. */
function askQuestion(tc: ToolCall): Promise<ToolResult> {
  const question = String(tc.args.question || '')
  const options = Array.isArray(tc.args.options) ? tc.args.options.map(String) : []

  return new Promise(resolve => {
    pendingQuestions.set(tc.call_id, {
      resolve: (answer: string) => {
        // Build the same format the server would return
        let output = `Q: ${question}`
        if (options.length > 0) {
          output += '\n选项：' + options.map((o, i) => `\n  ${i + 1}. ${o}`).join('')
        }
        output += `\n\nA: ${answer}`
        resolve({ call_id: tc.call_id, name: 'question', output, success: true })
      },
    })

    // Broadcast to sidebar
    broadcast({
      type: 'CHAT_QUESTION',
      call_id: tc.call_id,
      question,
      options,
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingQuestions.has(tc.call_id)) {
        pendingQuestions.delete(tc.call_id)
        resolve({
          call_id: tc.call_id,
          name: 'question',
          output: `Q: ${question}\n\n[超时未收到回答]`,
          success: false,
        })
      }
    }, 5 * 60 * 1000)
  })
}

// ── Tool Detection ─────────────────────────────────────────────────────────

export function extractToolCalls(content: string): ToolCall[] {
  // extractFenceToolCalls 用花括号配对消费 fence body，而不是 FENCE_RE 的非贪婪
  // 匹配 —— 后者在 args 字符串里的第一个 ``` 处截断 JSON（write_file 写 markdown
  // /代码文件必现），截断残尾还可能再被匹配成"幽灵 fence"解析出错误工具。
  return extractFenceToolCalls(content).map((tc, i) => ({
    name: tc.name,
    args: tc.args,
    call_id: tc.callId || `detected-${i}`,
  }))
}

// ── Sub-agent orchestration ──────────────────────────────────────────────────

/** Max nesting depth of recursive sub-agents (separate from MAX_TOOL_DEPTH). */
const MAX_AGENT_DEPTH = 3

/** Split tool calls into spawn_agent calls (run as sub-conversations) and the
 *  rest (executed normally via /exec). */
export function partitionSpawnCalls(calls: ToolCall[]): { spawns: ToolCall[]; normal: ToolCall[] } {
  const spawns: ToolCall[] = []
  const normal: ToolCall[] = []
  for (const c of calls) {
    if (c.name === 'spawn_agent') spawns.push(c)
    else normal.push(c)
  }
  return { spawns, normal }
}

/** Compose the first message of a sub-agent conversation. */
export function buildSubAgentMessage(workerPrompt: string, task: string): string {
  return `${workerPrompt}\n\n任务：${task}`
}

/** Shape a sub-agent's final assistant text into a ToolResult for the parent. */
export function shapeSubAgentResult(call: ToolCall, finalText: string): ToolResult {
  // Prefix the worker's identity so the parent model (and the user reading the
  // injected turn) can tell WHICH sub-agent each result block came from — the
  // block header is always `### spawn_agent #id`, which alone is ambiguous.
  const label = String(call.args?.label || call.args?.description || '').trim()
  const header = label ? `【子agent「${label}」结果】\n\n` : ''
  return {
    call_id: call.call_id,
    name: call.name,
    output: header + (finalText || '(子 agent 无输出)'),
    success: true,
  }
}

// Worker prompt cache (fetched once from the PierCode server).
let workerPromptCache: string | null = null

async function fetchWorkerPrompt(): Promise<string> {
  if (workerPromptCache !== null) return workerPromptCache
  try {
    const { apiUrl, authToken } = await chrome.storage.local.get(['apiUrl', 'authToken'])
    if (apiUrl && authToken) {
      const res = await fetch(`${apiUrl}/prompt?profile=worker`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (res.ok) {
        workerPromptCache = await res.text()
        return workerPromptCache
      }
    }
  } catch {
    // fall through to inline default
  }
  workerPromptCache =
    '你是一个子 agent。独立完成下面的任务，可以使用 piercode-tool 工具（read_file/write_file/exec_cmd 等）。' +
    '完成后用纯文本简明汇报结论，不要再派生新的子 agent。'
  return workerPromptCache
}

// ── SSE Stream Processing ──────────────────────────────────────────────────

export interface SSEResult {
  content: string
  responseId: string | null
}

export async function processSSEStream(
  response: FetchLike,
  config: PlatformConfig,
  onChunk: (text: string) => void,
  abortSignal?: AbortSignal,
  onThinking?: (step: { title: string; thought: string }) => void,
): Promise<SSEResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let fullContent = ''
  // Primary-branch anchor: Qwen can open parallel assistant branches
  // (response_index 0 and 1+). We pin to the index-0 response_id from the first
  // response.created and drop deltas from any other branch, so content/thinking
  // from a parallel branch doesn't interleave and responseId isn't clobbered.
  let primaryResponseId: string | null = null

  // For snapshot platforms (ChatGPT) parseChunk returns the cumulative
  // full-text-so-far; emit only the newly-appended suffix as the delta and set
  // fullContent to the snapshot. For delta platforms, append as before.
  const emit = (text: string) => {
    if (config.isSnapshot) {
      if (text.length <= fullContent.length) {
        // Same-or-shorter snapshot (rare reorder / retry); resync without re-emitting.
        fullContent = text
        return
      }
      const delta = text.startsWith(fullContent) ? text.slice(fullContent.length) : text
      fullContent = text
      if (delta) onChunk(delta)
    } else {
      fullContent += text
      onChunk(text)
    }
  }
  let responseId: string | null = null
  let buffer = ''

  try {
    while (true) {
      if (abortSignal?.aborted) break

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (abortSignal?.aborted) break

        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const dataStr = trimmed.slice(6).trim()
        if (dataStr === '[DONE]') continue

        try {
          const json = JSON.parse(dataStr)
          // Pin the primary branch from response.created (response_index "0").
          const created = json['response.created']
          if (created?.response_id) {
            const idx = String(created.response_index ?? '0')
            if (idx === '0' && !primaryResponseId) primaryResponseId = created.response_id
            if (!responseId) responseId = created.response_id
          }
          if (!responseId && json.response_id) responseId = json.response_id

          // Drop deltas from a parallel (non-primary) branch.
          // Use platform-specific deltaResponseId if available, otherwise
          // fall back to the top-level response_id field.
          if (primaryResponseId) {
            const did = config.deltaResponseId
              ? config.deltaResponseId(json)
              : (typeof json.response_id === 'string' ? json.response_id : null)
            if (did && did !== primaryResponseId) continue
          }

          if (onThinking && config.parseThinking) {
            const step = config.parseThinking(json)
            if (step) onThinking(step)
          }
          const text = config.parseChunk(json)
          if (text) emit(text)
        } catch {
          // Non-JSON data line — skip
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ') && trimmed !== '[DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6).trim())
          if (!responseId && json['response.created']?.response_id) {
            responseId = json['response.created'].response_id
          }
          if (!responseId && json.response_id) responseId = json.response_id
          if (primaryResponseId && config.deltaResponseId) {
            const did = config.deltaResponseId(json)
            if (did && did !== primaryResponseId) throw new Error('parallel branch')
          }
          const text = config.parseChunk(json)
          if (text) emit(text)
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Prefer the pinned primary-branch id so a tool-result follow-up continues the
  // right branch.
  return { content: fullContent, responseId: primaryResponseId || responseId }
}

// ── Main Chat Handler ──────────────────────────────────────────────────────

interface ChatRequestParams {
  platform: string
  message: string
  chatId: string | null
  parentId: string | null
  model?: string
  depth?: number
  /** System/init prompt. Only honoured on the first turn (depth 0). For
   *  platforms with supportsSystem it goes in a real system field; otherwise
   *  it is prepended to the first user message. */
  systemPrompt?: string
  /** Per-platform thinking-level key (sidebar/reasoning.ts). Threaded into
   *  BuildCtx.reasoning so each platform's buildBody can apply it. */
  reasoning?: string
}

// Execute the NON-spawn tool calls of one assistant turn and broadcast each
// result. Question tools need user interaction; the rest go to server /exec.
async function runNormalToolCalls(
  normal: ToolCall[],
  signal: AbortSignal,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []

  // Separate question tools — they need user interaction, not server exec.
  const questions = normal.filter(tc => tc.name === 'question')
  const execTools = normal.filter(tc => tc.name !== 'question')

  for (const tc of questions) {
    if (signal.aborted) break
    const answer = await askQuestion(tc)
    results.push(answer)
    broadcast({ type: 'CHAT_TOOL_DONE', result: answer })
  }

  for (const tc of execTools) {
    if (signal.aborted) break
    const result = await execTool(tc.name, tc.args, tc.call_id)
    results.push(result)
    broadcast({ type: 'CHAT_TOOL_DONE', result })
  }

  return results
}

// Legacy synchronous tool runner for the LISTEN path (page-driven tabs): spawn
// batches are awaited inline because the driven tab has no idle-injection
// channel. The active sidebar path (handleChatRequest) instead defers spawns to
// launchSidebarSpawnBatch so the main conversation is never blocked.
async function runToolCalls(
  toolCalls: ToolCall[],
  platform: string,
  modelOverride: string | undefined,
  depth: number,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  const { spawns, normal } = partitionSpawnCalls(toolCalls)
  const results = await runNormalToolCalls(normal, signal)

  // spawn_agent → parallel sub-conversations (no tabs). Each runSubAgent catches
  // its own failures into a failed ToolResult, so Promise.all never rejects.
  if (spawns.length > 0 && !signal.aborted) {
    const spawnResults = await runSubAgentBatch(spawns, platform, modelOverride, depth)
    for (const r of spawnResults) {
      results.push(r)
      broadcast({ type: 'CHAT_TOOL_DONE', result: r })
    }
  }

  return results
}

// ── Listen-path send hook ────────────────────────────────────────────────────
//
// For LISTEN_PLATFORMS the sidebar no longer fetches from the SW. Instead it
// drives a background AI tab (DOM fill + submit) — the page sends its own
// authenticated request, and the teed response flows back through the listen
// receiver (installApiListenReceiver → consumeListenStream → broadcast). The
// driver lives in background/index.ts (it owns tab lifecycle); chat-api calls it
// through this hook to keep tab logic out of the chat module.
export type ListenSendHook = (
  platform: string,
  text: string,
  opts?: { fresh?: boolean },
) => Promise<{ ok: boolean; error?: string }>
let listenSendHook: ListenSendHook | null = null
export function setListenSendHook(hook: ListenSendHook): void {
  listenSendHook = hook
}

const LISTEN_PLATFORMS = new Set(['chatgpt'])
export function isListenPlatform(platform: string): boolean {
  return LISTEN_PLATFORMS.has(platform)
}

// Drive the page to send `message`. The response is handled asynchronously by
// the listen receiver, so this returns once the page has accepted the input.
// Synthetic conversation ids for the listen route. The page owns the real
// conversation; this id only marks "the sidebar conversation has started" so
// the sidebar sends chatId≠null on later turns (fresh=false → same tab/chat).
const listenChatIds = new Map<string, string>()

async function handleChatRequestViaListen(platform: string, message: string, fresh = false): Promise<void> {
  if (!listenSendHook) {
    broadcast({ type: 'CHAT_ERROR', error: '监听通道未初始化（缺少 tab 驱动）' })
    return
  }
  if (fresh) listenChatIds.set(platform, `listen-${crypto.randomUUID()}`)
  const r = await listenSendHook(platform, message, { fresh })
  if (!r.ok) {
    broadcast({ type: 'CHAT_ERROR', error: r.error || `无法驱动 ${platform} 页面发送` })
  }
}

// Called by the listen receiver after an intercepted stream finishes. If the
// assistant emitted tool calls, execute them and inject the formatted results
// back into the driven tab (the page sends again → next response is intercepted).
// No assistant tools → the turn is done.
export async function continueListenTurn(platform: string, content: string): Promise<void> {
  const listenChatId = listenChatIds.get(platform) || null
  const toolCalls = extractToolCalls(content)
  if (toolCalls.length === 0) {
    broadcast({ type: 'CHAT_DONE', chatId: listenChatId, responseId: null })
    return
  }
  const signal = (currentAbort ??= new AbortController()).signal
  const results = await runToolCalls(toolCalls, platform, undefined, 0, signal)
  if (signal.aborted) {
    broadcast({ type: 'CHAT_DONE', chatId: listenChatId, responseId: null })
    return
  }
  broadcast({ type: 'CHAT_CONTINUING' })
  await handleChatRequestViaListen(platform, formatToolResults(results))
}

// ── Async sidebar spawn batches + idle injection ─────────────────────────────
//
// spawn_agent from the SIDEBAR main conversation must not block it: the batch
// runs detached (through the recoverable-batch machinery, so checkpoints,
// keep-alive and SW-restart resume all apply), the main turn ends immediately
// (CHAT_DONE unlocks the input), and the batch summary is queued. The queue is
// drained only when the main conversation is idle (no handleChatRequest in
// flight), injecting the summary as a new turn so it never interleaves with a
// user message.

// The resume point of the sidebar main conversation, refreshed after every
// completed stream turn. Injection continues from here.
interface MainTurnContext {
  platform: string
  chatId: string
  parentId: string | null
  model?: string
  reasoning?: string
}

let lastMainContext: MainTurnContext | null = null
// >0 while any handleChatRequest is running (the whole recursion chain).
let mainTurnDepth = 0
// Queued batch summaries waiting for an idle main conversation. ctx is the
// fallback resume point persisted with the batch (used when a restarted SW has
// no lastMainContext yet); a fresher lastMainContext wins at drain time.
const pendingInjections: Array<{ message: string; ctx: MainTurnContext }> = []

let sidebarBatchSeq = 0

// launchSidebarSpawnBatch runs a sidebar spawn batch detached. Reuses the
// recoverable-batch path (persist + checkpoint + keep-alive + resume); the
// `inject` ctx on the record routes results into the injection queue instead of
// a CONTENT_SPAWN_RESULT tab push.
export function launchSidebarSpawnBatch(
  spawns: ToolCall[],
  ctx: MainTurnContext,
  depth: number,
): void {
  const batchKey = `sidebar-${Date.now()}-${++sidebarBatchSeq}`
  void startRecoverableSpawnBatch(batchKey, spawns, ctx.platform, ctx.model, undefined, {
    inject: ctx,
    depth,
  }).catch(err => {
    broadcast({ type: 'CHAT_ERROR', error: `子 agent 批次失败: ${err instanceof Error ? err.message : String(err)}` })
  })
}

// enqueueInjection queues a finished batch's summary and tries to drain.
function enqueueInjection(message: string, ctx: MainTurnContext): void {
  pendingInjections.push({ message, ctx })
  drainInjectionQueue()
}

// drainInjectionQueue injects ONE queued summary when the main conversation is
// idle. The injected turn is itself a handleChatRequest, whose finally drains
// the next item — so multiple finished batches inject sequentially, never
// interleaved with each other or with a user turn.
function drainInjectionQueue(): void {
  if (mainTurnDepth > 0 || pendingInjections.length === 0) return
  const item = pendingInjections.shift()!
  // The summary belongs to the conversation that SPAWNED the batch (item.ctx).
  // lastMainContext is only "the same conversation, fresher parentId" when the
  // chatId matches — the user may have started a new session or switched
  // platform while the batch ran, and injecting there would leak the summary
  // into an unrelated conversation.
  const ctx = lastMainContext && lastMainContext.chatId === item.ctx.chatId
    ? lastMainContext
    : item.ctx
  // New assistant bubble in the sidebar for the continuation.
  broadcast({ type: 'CHAT_CONTINUING' })
  void handleChatRequest({
    platform: ctx.platform,
    message: item.message,
    chatId: ctx.chatId,
    parentId: ctx.parentId,
    model: ctx.model,
    reasoning: ctx.reasoning,
    depth: 1, // continuation turn: never re-applies the system prompt
  }).catch(err => {
    broadcast({ type: 'CHAT_ERROR', error: err instanceof Error ? err.message : String(err) })
  })
}

// Test-only: inspect/reset the injection machinery.
export function __injectionStateForTest(): {
  queue: Array<{ message: string; ctx: MainTurnContext }>
  setMainContext: (ctx: MainTurnContext | null) => void
  setTurnDepth: (n: number) => void
  drain: () => void
  reset: () => void
} {
  return {
    queue: pendingInjections,
    setMainContext: (ctx) => { lastMainContext = ctx },
    setTurnDepth: (n) => { mainTurnDepth = n },
    drain: drainInjectionQueue,
    reset: () => {
      pendingInjections.length = 0
      lastMainContext = null
      mainTurnDepth = 0
    },
  }
}

export async function handleChatRequest(params: ChatRequestParams): Promise<void> {
  // 插件总开关：关闭时拒绝整个对话回合（含其触发的子 agent / 工具执行）。
  try {
    const { extensionEnabled } = await chrome.storage.local.get(['extensionEnabled'])
    if (extensionEnabled === false) {
      broadcast({ type: 'CHAT_ERROR', error: 'PierCode 插件已停用（在 popup 中打开总开关后重试）' })
      return
    }
  } catch {
    // storage 不可用时按开启处理。
  }
  mainTurnDepth++
  try {
    await handleChatRequestInner(params)
  } finally {
    mainTurnDepth--
    if (mainTurnDepth === 0) drainInjectionQueue()
  }
}

async function handleChatRequestInner(params: ChatRequestParams): Promise<void> {
  const { platform, depth = 0, systemPrompt, reasoning } = params
  let { chatId, parentId, model: modelOverride, message } = params

  const config = PLATFORMS[platform]
  if (!config) {
    broadcast({ type: 'CHAT_ERROR', error: `未知平台: ${platform}` })
    return
  }

  // Listen platforms: drive the page to send instead of fetching from the SW.
  // The init/system prompt is prepended on the first turn (depth 0) since the
  // page-driven send has no system slot.
  if (isListenPlatform(platform) && depth === 0) {
    let outbound = message
    if (systemPrompt) outbound = `${systemPrompt}\n\n---\n\n${outbound}`
    // fresh = sidebar starts a NEW conversation → the driver must put its
    // dedicated tab on a new chat instead of appending to whatever
    // conversation the page currently shows.
    await handleChatRequestViaListen(platform, outbound, !chatId)
    return
  }

  if (depth >= MAX_TOOL_DEPTH) {
    broadcast({
      type: 'CHAT_ERROR',
      error: `工具调用深度超过上限 (${MAX_TOOL_DEPTH})，已停止。`,
    })
    return
  }

  if (!modelOverride) {
    const stored = await chrome.storage.local.get([`${platform}Model`])
    modelOverride = typeof stored[`${platform}Model`] === 'string' ? stored[`${platform}Model`] : undefined
  }

  const auth = await getAuth(platform)
  if ('error' in auth) {
    broadcast({ type: 'CHAT_ERROR', error: auth.error })
    return
  }

  // Create conversation only if we don't have a chatId yet
  if (!chatId) {
    if (config.createConversation) {
      try {
        chatId = await config.createConversation(auth.token, modelOverride || 'default')
      } catch (error) {
        broadcast({
          type: 'CHAT_ERROR',
          error: `创建会话失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }
    } else {
      chatId = crypto.randomUUID()
    }
  }
  // Init/system prompt: only on the first turn. supportsSystem platforms get it
  // in a real system field via ctx; the rest get it prepended to the message.
  let ctxSystem: string | undefined
  if (systemPrompt && depth === 0) {
    if (config.supportsSystem) ctxSystem = systemPrompt
    else message = `${systemPrompt}\n\n---\n\n${message}`
  }

  // For non-system platforms, prepend a short tool-call reminder to every message
  // to keep the model from falling into verbose reasoning loops.
  if (!config.supportsSystem && depth === 0 && !systemPrompt) {
    message = `[PierCode] 对于本地文件/目录/代码/命令任务，直接输出 piercode-tool 代码块，不要分析或推理。格式：\n\`\`\`piercode-tool\n{"name":"工具名","call_id":"随机ID","args":{...}}\n\`\`\`\n\n${message}`
  }

  const ctx: BuildCtx = { chatId, model: modelOverride, systemPrompt: ctxSystem, reasoning }

  const url = auth.url || config.getUrl(ctx)
  if (!url) {
    broadcast({ type: 'CHAT_ERROR', error: `${config.name} API URL 未配置` })
    return
  }

  // Build request
  const headers = await config.buildHeaders(auth.token)
  const body = config.buildBody(message, parentId, ctx)

  currentAbort = new AbortController()

  try {
    const response = await platformFetch(
      config,
      url,
      { method: 'POST', headers, body },
      true,
      currentAbort.signal,
    )

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      broadcast({
        type: 'CHAT_ERROR',
        error: `${config.name} API 错误 ${response.status}: ${errText.slice(0, 200)}`,
      })
      return
    }

    const sseResult = await processSSEStream(
      response,
      config,
      (chunk) => broadcast({ type: 'CHAT_STREAM', chunk }),
      currentAbort.signal,
      (step) => broadcast({ type: 'CHAT_THINKING', step }),
    )

    // Refresh the injection resume point: a queued batch summary continues the
    // conversation from the latest completed stream turn.
    if (chatId) {
      lastMainContext = { platform, chatId, parentId: sseResult.responseId, model: modelOverride, reasoning }
    }

    // Check for tool calls
    const toolCalls = extractToolCalls(sseResult.content)

    if (toolCalls.length > 0) {
      broadcast({ type: 'CHAT_TOOLS', tools: toolCalls })
      const { spawns, normal } = partitionSpawnCalls(toolCalls)
      const results = await runNormalToolCalls(normal, currentAbort.signal)

      // spawn_agent runs DETACHED: the batch summary is injected later, when
      // the main conversation is idle. The turn itself ends without waiting.
      // Agent NESTING depth is 0 here — the spawner is the main conversation —
      // regardless of `depth`, which counts TOOL recursion turns. Conflating
      // the two falsely tripped MAX_AGENT_DEPTH after 3 tool turns.
      if (spawns.length > 0 && !currentAbort.signal.aborted && chatId) {
        launchSidebarSpawnBatch(
          spawns,
          { platform, chatId, parentId: sseResult.responseId, model: modelOverride, reasoning },
          0,
        )
      }

      if (results.length > 0) {
        const toolResultContent = formatToolResults(results)

        // Signal sidebar to create a new assistant message for the continuation
        broadcast({ type: 'CHAT_CONTINUING' })

        // Recursive: same chatId, use responseId as parentId for tool result
        await handleChatRequest({
          platform,
          message: toolResultContent,
          chatId,
          parentId: sseResult.responseId,
          model: modelOverride,
          reasoning,
          depth: depth + 1,
        })
        return
      }

      // Spawn-only turn: end it now so the input unlocks; the batch result
      // arrives later through the injection queue.
      broadcast({ type: 'CHAT_DONE', chatId, responseId: sseResult.responseId })
      return
    }

    broadcast({ type: 'CHAT_DONE', chatId, responseId: sseResult.responseId })
  } catch (error) {
    if (currentAbort?.signal.aborted) {
      broadcast({ type: 'CHAT_DONE', chatId, responseId: null })
      return
    }
    broadcast({
      type: 'CHAT_ERROR',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    currentAbort = null
  }
}

// AgentCheckpoint is the per-turn resume state of one sub-agent conversation.
// The transcript itself lives server-side on the AI platform (chatId/parentId),
// so this is all a restarted service worker needs to re-enter the turn loop.
// `message` is the next user-role message to send (initial task or the last
// turn's tool results); `turn` is the loop index to resume from.
interface AgentCheckpoint {
  chatId: string
  parentId: string | null
  message: string
  turn: number
}

// SubAgentRecovery threads recoverable-batch state into runSubAgent: a stable
// agentId (so abort ✕ and StatusPanel rows survive a SW restart), the last
// checkpoint to resume from, and a callback that persists new checkpoints.
interface SubAgentRecovery {
  agentId: string
  checkpoint?: AgentCheckpoint
  onCheckpoint: (cp: AgentCheckpoint) => Promise<void> | void
}

// runSubAgent runs a spawn_agent call as an isolated sub-conversation: fresh
// chatId, worker prompt + task, its own abort. The sub-agent can itself execute
// tools (recursively through runIsolatedConversation), bounded by MAX_AGENT_DEPTH
// and MAX_TOOL_DEPTH. Its final assistant text becomes the parent's tool result.
async function runSubAgent(
  call: ToolCall,
  platform: string,
  model: string | undefined,
  parentDepth: number,
  batchId: string,
  originTabId?: number,
  recovery?: SubAgentRecovery,
): Promise<ToolResult> {
  const agentId = recovery?.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const label = String(call.args.label || 'agent')
  const task = String(call.args.task || call.args.prompt || '')

  if (parentDepth >= MAX_AGENT_DEPTH) {
    return shapeSubAgentResult(call, `(子 agent 嵌套超过上限 ${MAX_AGENT_DEPTH}，已拒绝)`)
  }
  if (!task) {
    return shapeSubAgentResult(call, '(spawn_agent 缺少 task 参数)')
  }

  broadcastAgentLifecycle({ type: 'CHAT_AGENT_SPAWN', agentId, label, task, batchId }, originTabId)

  // Resuming from a checkpoint skips the worker-prompt build: the prompt is
  // already the first message of the server-side conversation.
  const resume = recovery?.checkpoint
  const message = resume ? '' : buildSubAgentMessage(await fetchWorkerPrompt(), task)
  const { signal, cleanup } = mergedAgentSignal(agentId, currentAbort?.signal)

  try {
    const finalText = await runIsolatedConversation({
      platform,
      message,
      model,
      depth: parentDepth + 1,
      agentId,
      abortSignal: signal,
      originTabId,
      resume,
      onCheckpoint: recovery?.onCheckpoint,
    })
    const cancelled = signal.aborted
    const output = cancelled ? `${finalText}\n\n(已取消)`.trim() : finalText
    broadcastAgentLifecycle({
      type: 'CHAT_AGENT_DONE', agentId, status: cancelled ? 'error' : 'done',
      ...(cancelled ? { error: '已取消' } : {}),
    }, originTabId)
    return cancelled
      ? { call_id: call.call_id, name: call.name, output: output || '(已取消)', success: false }
      : shapeSubAgentResult(call, finalText)
  } catch (err) {
    const cancelled = signal.aborted
    const msg = cancelled ? '(已取消)' : `子 agent 失败: ${err instanceof Error ? err.message : String(err)}`
    // error 文本随 DONE 广播，AgentDock 行能直接显示失败原因（风控/网络/超时），
    // 不再只有一个裸 ✗。
    broadcastAgentLifecycle({ type: 'CHAT_AGENT_DONE', agentId, status: 'error', error: msg }, originTabId)
    return { call_id: call.call_id, name: call.name, output: msg, success: false }
  } finally {
    cleanup()
  }
}

// runSubAgentBatch runs N spawn_agent calls as parallel in-memory sub-conversations
// (no tabs). One batchId tags the whole batch so UIs can group the summary. Each
// runSubAgent catches its own failure into a failed ToolResult, so Promise.all
// never rejects on a single worker error. Used by both the sidebar turn loop and
// the content-script CONTENT_SPAWN_AGENT route.
export async function runSubAgentBatch(
  spawns: ToolCall[],
  platform: string,
  model: string | undefined,
  depth: number,
  originTabId?: number,
): Promise<ToolResult[]> {
  if (spawns.length === 0) return []
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return Promise.all(spawns.map(tc => runSubAgent(tc, platform, model, depth, batchId, originTabId)))
}

// ── Recoverable Spawn Batches ──────────────────────────────────────────────
// MV3 kills the service worker (30s idle / 5-min cap on an open message
// channel). The legacy CONTENT_SPAWN_AGENT path held the sendResponse channel
// open for the whole batch, so a SW death rejected the content-side promise
// and lost every in-flight sub-agent. Recoverable mode instead:
//   1. acks the start message synchronously (no long-lived channel),
//   2. persists batch + per-turn agent checkpoints to chrome.storage.session
//      (survives SW restarts, cleared with the browser),
//   3. keeps the SW alive during a live batch via a cheap-API heartbeat,
//   4. on any SW wake (registerChatApiHandler / content status poll), resumes
//      undone batches from their checkpoints,
//   5. delivers results by pushing CONTENT_SPAWN_RESULT to the origin tab,
//      with the content-side CONTENT_SPAWN_STATUS poll as fallback + waker.

interface SpawnAgentRecord {
  call: ToolCall
  agentId: string
  status: 'pending' | 'done'
  result?: ToolResult
  checkpoint?: AgentCheckpoint
}

interface SpawnBatchRecord {
  batchKey: string
  batchId: string
  platform: string
  model?: string
  depth: number
  originTabId?: number
  createdAt: number
  done: boolean
  agents: SpawnAgentRecord[]
  /** Sidebar route: resume point of the main conversation. When set, finished
   *  results go to the idle-injection queue instead of a tab push. */
  inject?: MainTurnContext
  /** True once the summary was handed to the injection queue (emit-once across
   *  SW restarts; resumeOrphanedSpawnBatches re-injects done-but-uninjected). */
  injected?: boolean
}

const SPAWN_BATCH_PREFIX = 'spawnBatch:'
const SPAWN_BATCH_TTL_MS = 2 * 60 * 60 * 1000
const SPAWN_KEEPALIVE_MS = 20_000

// Batches currently running in THIS service-worker life. A record in storage
// but not in this set is an orphan from a killed SW → resume it.
const liveSpawnBatches = new Set<string>()
// Completed results kept in memory so the status poll works even when
// chrome.storage.session is unavailable (tests / restricted contexts).
const finishedSpawnBatches = new Map<string, ToolResult[]>()
let spawnKeepAliveTimer: ReturnType<typeof setInterval> | null = null

function sessionStore(): chrome.storage.StorageArea | null {
  try {
    return (typeof chrome !== 'undefined' && chrome.storage?.session) || null
  } catch {
    return null
  }
}

async function saveSpawnBatch(rec: SpawnBatchRecord): Promise<void> {
  try {
    await sessionStore()?.set({ [SPAWN_BATCH_PREFIX + rec.batchKey]: rec })
  } catch {
    // Quota/availability failures degrade to in-memory-only operation.
  }
}

async function loadSpawnBatch(batchKey: string): Promise<SpawnBatchRecord | null> {
  const store = sessionStore()
  if (!store) return null
  try {
    const key = SPAWN_BATCH_PREFIX + batchKey
    const got = await store.get(key)
    return (got?.[key] as SpawnBatchRecord) || null
  } catch {
    return null
  }
}

// sweepSpawnBatches deletes expired records and returns the survivors that
// still need work: undone batches (resume) and done sidebar batches whose
// summary never reached the injection queue (SW died between done and inject).
async function sweepSpawnBatches(): Promise<{ undone: SpawnBatchRecord[]; uninjected: SpawnBatchRecord[] }> {
  const store = sessionStore()
  if (!store) return { undone: [], uninjected: [] }
  try {
    const all = await store.get(null)
    const now = Date.now()
    const undone: SpawnBatchRecord[] = []
    const uninjected: SpawnBatchRecord[] = []
    const drop: string[] = []
    for (const [k, v] of Object.entries(all || {})) {
      if (!k.startsWith(SPAWN_BATCH_PREFIX)) continue
      const rec = v as SpawnBatchRecord
      if (!rec || typeof rec.createdAt !== 'number' || now - rec.createdAt > SPAWN_BATCH_TTL_MS) {
        drop.push(k)
      } else if (!rec.done) {
        undone.push(rec)
      } else if (rec.inject && !rec.injected) {
        uninjected.push(rec)
      }
    }
    if (drop.length) await store.remove(drop)
    return { undone, uninjected }
  } catch {
    return { undone: [], uninjected: [] }
  }
}

// While any batch is live, ping a cheap extension API every 20s: each call
// resets the SW idle timer (Chrome ≥110), so the worker survives long batches.
function updateSpawnKeepAlive(): void {
  const want = liveSpawnBatches.size > 0
  if (want && !spawnKeepAliveTimer) {
    spawnKeepAliveTimer = setInterval(() => {
      try {
        chrome.runtime?.getPlatformInfo?.(() => void chrome.runtime.lastError)
      } catch {
        // API unavailable — keep-alive is best-effort.
      }
    }, SPAWN_KEEPALIVE_MS)
  } else if (!want && spawnKeepAliveTimer) {
    clearInterval(spawnKeepAliveTimer)
    spawnKeepAliveTimer = null
  }
}

// startRecoverableSpawnBatch persists a fresh batch record, then runs it.
// Exported for tests; production entry is the CONTENT_SPAWN_AGENT handler.
export async function startRecoverableSpawnBatch(
  batchKey: string,
  spawns: ToolCall[],
  platform: string,
  model: string | undefined,
  originTabId?: number,
  opts?: { inject?: MainTurnContext; depth?: number },
): Promise<void> {
  const stamp = Date.now()
  const rec: SpawnBatchRecord = {
    batchKey,
    batchId: `batch-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
    platform,
    model,
    depth: opts?.depth ?? 0,
    originTabId,
    inject: opts?.inject,
    createdAt: stamp,
    done: false,
    agents: spawns.map((call, i) => ({
      call,
      agentId: `agent-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending' as const,
    })),
  }
  await saveSpawnBatch(rec)
  await runSpawnBatchRecord(rec)
}

// runSpawnBatchRecord runs/resumes one batch: already-done agents return their
// saved result untouched (partial salvage), pending ones run from their last
// checkpoint. Results are pushed to the origin tab when finished.
async function runSpawnBatchRecord(rec: SpawnBatchRecord): Promise<void> {
  if (liveSpawnBatches.has(rec.batchKey)) return
  liveSpawnBatches.add(rec.batchKey)
  updateSpawnKeepAlive()
  try {
    const results = await Promise.all(rec.agents.map(async (a) => {
      if (a.status === 'done' && a.result) return a.result
      const result = await runSubAgent(a.call, rec.platform, rec.model, rec.depth, rec.batchId, rec.originTabId, {
        agentId: a.agentId,
        checkpoint: a.checkpoint,
        onCheckpoint: async (cp) => {
          a.checkpoint = cp
          await saveSpawnBatch(rec)
        },
      })
      a.status = 'done'
      a.result = result
      delete a.checkpoint
      await saveSpawnBatch(rec)
      return result
    }))
    rec.done = true
    // Sidebar route: per-result CHAT_TOOL_DONE (attaches to the spawning turn's
    // message in the UI) + queue the batch summary for idle injection.
    if (rec.inject && !rec.injected) {
      for (const r of results) broadcast({ type: 'CHAT_TOOL_DONE', result: r })
      rec.injected = true
      enqueueInjection(formatToolResults(results), rec.inject)
    }
    finishedSpawnBatches.set(rec.batchKey, results)
    // Cap the in-memory finished store: it only exists so the status poll works
    // without chrome.storage.session, and a long SW life would otherwise retain
    // every batch's full results forever. Map preserves insertion order, so the
    // first key is the oldest. The storage copy (with its own TTL) still serves
    // evicted batches.
    while (finishedSpawnBatches.size > 20) {
      const oldest = finishedSpawnBatches.keys().next().value
      if (oldest === undefined) break
      finishedSpawnBatches.delete(oldest)
    }
    await saveSpawnBatch(rec)
    if (rec.originTabId != null) {
      try {
        chrome.tabs?.sendMessage?.(rec.originTabId, {
          type: 'CONTENT_SPAWN_RESULT',
          batchKey: rec.batchKey,
          results,
        })?.catch?.(() => {})
      } catch {
        // Tab gone — content poll (if any) still sees the stored record.
      }
    }
  } finally {
    liveSpawnBatches.delete(rec.batchKey)
    updateSpawnKeepAlive()
  }
}

// resumeOrphanedSpawnBatches re-launches batches a killed SW left undone.
// Called on every SW start (registerChatApiHandler) and is cheap when idle.
export async function resumeOrphanedSpawnBatches(): Promise<void> {
  const { undone, uninjected } = await sweepSpawnBatches()
  for (const rec of undone) {
    if (!liveSpawnBatches.has(rec.batchKey)) void runSpawnBatchRecord(rec)
  }
  // SW died after the batch finished but before its summary was queued:
  // re-queue from the persisted results (emit-once via the injected flag).
  for (const rec of uninjected) {
    const results = rec.agents.map(a => a.result).filter((r): r is ToolResult => !!r)
    if (results.length === 0 || !rec.inject) continue
    rec.injected = true
    await saveSpawnBatch(rec)
    enqueueInjection(formatToolResults(results), rec.inject)
  }
}

// Test-only: reset module state between cases.
export function __spawnBatchStateForTest(): {
  live: Set<string>
  finished: Map<string, ToolResult[]>
  reset: () => void
} {
  return {
    live: liveSpawnBatches,
    finished: finishedSpawnBatches,
    reset: () => {
      liveSpawnBatches.clear()
      finishedSpawnBatches.clear()
      if (spawnKeepAliveTimer) {
        clearInterval(spawnKeepAliveTimer)
        spawnKeepAliveTimer = null
      }
    },
  }
}

// runIsolatedConversation drives one sub-agent turn loop: it streams the model,
// executes any non-spawn tools, recurses on its own tool output, and returns the
// accumulated assistant text. It deliberately does NOT spawn further agents
// beyond MAX_AGENT_DEPTH (enforced by runSubAgent before entry).
async function runIsolatedConversation(params: {
  platform: string
  message: string
  model?: string
  depth: number
  agentId: string
  abortSignal?: AbortSignal
  /** Tab that spawned this agent (content route) — streams also go to its StatusPanel. */
  originTabId?: number
  /** Resume state from a previous service-worker life (recoverable batches). */
  resume?: AgentCheckpoint
  /** Called after each completed turn with the state needed to resume it. */
  onCheckpoint?: (cp: AgentCheckpoint) => Promise<void> | void
}): Promise<string> {
  const { platform, agentId, abortSignal } = params
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`未知平台: ${platform}`)

  let chatId: string | null = params.resume?.chatId || null
  let parentId: string | null = params.resume ? params.resume.parentId : null
  let message = params.resume ? params.resume.message : params.message
  let lastText = ''

  for (let turn = params.resume?.turn ?? 0; turn < MAX_TOOL_DEPTH; turn++) {
    if (abortSignal?.aborted) break

    const auth = await getAuth(platform)
    if ('error' in auth) throw new Error(auth.error)

    if (!chatId) {
      chatId = config.createConversation
        ? await config.createConversation(auth.token, params.model || 'default')
        : crypto.randomUUID()
    }
    const ctx = { chatId, model: params.model }
    const url = auth.url || config.getUrl(ctx)
    if (!url) throw new Error(`${config.name} API URL 未配置`)

    const response = await platformFetch(
      config,
      url,
      { method: 'POST', headers: await config.buildHeaders(auth.token), body: config.buildBody(message, parentId, ctx) },
      true,
      abortSignal,
    )
    if (!response.ok) {
      const t = await response.text().catch(() => '')
      throw new Error(`${config.name} ${response.status}: ${t.slice(0, 120)}`)
    }

    const sse = await processSSEStream(
      response,
      config,
      (chunk) => broadcastAgentLifecycle({ type: 'CHAT_AGENT_STREAM', agentId, chunk }, params.originTabId),
      abortSignal,
    )
    lastText = sse.content
    parentId = sse.responseId

    const calls = extractToolCalls(sse.content)
    const { spawns, normal } = partitionSpawnCalls(calls)  // sub-agents don't spawn further
    if (normal.length === 0 && spawns.length === 0) break

    const results: ToolResult[] = []
    // Inline spawn from a sub-agent: refuse with explicit feedback instead of
    // silently dropping the call (which cut the conversation short and handed
    // the parent a half-finished result). The AI sees a failed tool result and
    // finishes the task itself.
    for (const tc of spawns) {
      results.push({
        call_id: tc.call_id,
        name: tc.name,
        output: '(子 agent 不能再派生子 agent：已达嵌套边界。请不要再调用 spawn_agent，直接自己完成任务，然后用纯文本汇报结果。)',
        success: false,
      })
    }
    for (const tc of normal) {
      if (abortSignal?.aborted) break
      // question needs the sidebar user, who belongs to the MAIN conversation.
      // Routing it to server /exec broadcasts to page WS clients the sidebar
      // never sees → the worker hangs to timeout. Reject with feedback so the
      // autonomous worker decides for itself and finishes.
      if (tc.name === 'question') {
        results.push({
          call_id: tc.call_id,
          name: tc.name,
          output: '(子 agent 无法向用户提问。请基于任务说明自行决策，完成任务后用纯文本汇报结果与所做的假设。)',
          success: false,
        })
        continue
      }
      results.push(await execTool(tc.name, tc.args))
    }
    message = results.map(r => `### ${r.name} #${r.call_id}\n\n${r.output}`).join('\n\n')

    // Checkpoint AFTER the turn's tools ran and the next message is built: a
    // SW death between checkpoints redoes at most one turn (its tools rerun).
    if (chatId && params.onCheckpoint) {
      try {
        await params.onCheckpoint({ chatId, parentId, message, turn: turn + 1 })
      } catch {
        // Persistence failure must not kill the conversation.
      }
    }
  }

  return lastText
}

// ── Broadcast Helper ───────────────────────────────────────────────────────

function broadcast(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners (sidebar closed) — silent
  })
}

// broadcastAgentLifecycle delivers a sub-agent SPAWN/DONE event to the sidebar
// (runtime.sendMessage, like broadcast) and, for content-route sub-agents, to
// their ORIGIN tab only (tabs.sendMessage). runtime.sendMessage does not reach
// content scripts, so a content-route StatusPanel sees its own agents via the
// origin tab. When originTabId is undefined (sidebar route), it stays sidebar-
// only — no all-tabs fan-out, so other AI tabs don't show foreign agent rows.
// Every event carries `origin` so each UI renders only its own agents: the
// sidebar drops 'tab' events (the runtime broadcast still reaches it for
// content-route agents), and a tab's StatusPanel only ever receives its own.
function broadcastAgentLifecycle(msg: Record<string, unknown>, originTabId?: number) {
  const tagged = { ...msg, origin: originTabId != null ? 'tab' : 'sidebar' }
  broadcast(tagged) // sidebar (runtime.sendMessage)
  if (originTabId != null) {
    chrome.tabs.sendMessage(originTabId, tagged).catch(() => {})
  }
}

// ── Message Handler Registration ───────────────────────────────────────────

export function registerChatApiHandler() {
  // Runs at every SW start (background/index.ts top level): any wake — content
  // status poll, user message, WS traffic — resumes batches a killed SW left.
  void resumeOrphanedSpawnBatches()

  // Passive listen channel: receive teed chat-API SSE streams from content and
  // feed them through the same processSSEStream/broadcast pipeline as the active
  // fetch path. Shares this module's broadcast() so sidebar messages match. On
  // each completed stream, continueListenTurn runs any tool calls and injects
  // the results back into the driven tab (closing the loop).
  installApiListenReceiver(broadcast, (platform, result) => continueListenTurn(platform, result.content))

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHAT_REQUEST') {
      handleChatRequest({
        platform: msg.platform,
        message: msg.message || '',
        chatId: msg.chatId || null,
        parentId: msg.parentId || null,
        model: msg.model,
        systemPrompt: msg.systemPrompt,
        reasoning: msg.reasoning,
      }).catch(error => {
          broadcast({
            type: 'CHAT_ERROR',
            error: error instanceof Error ? error.message : String(error),
          })
        })
      sendResponse({ ok: true })
      return false
    }

    if (msg.type === 'CHAT_CANCEL') {
      if (currentAbort) {
        currentAbort.abort()
        currentAbort = null
      }
      sendResponse({ ok: true })
      return false
    }

    if (msg.type === 'CHAT_AGENT_ABORT') {
      agentAborts.get(String(msg.agentId || ''))?.abort()
      sendResponse({ ok: true })
      return false
    }

    if (msg.type === 'CONTENT_SPAWN_AGENT') {
      const spawns = (msg.spawns || []) as ToolCall[]
      const platform = String(msg.platform || '')
      const model = msg.model ? String(msg.model) : undefined
      const originTabId = sender.tab?.id
      if (msg.batchKey) {
        // Recoverable mode: ack synchronously and run detached. A long-open
        // sendResponse channel is what triggered the MV3 5-min SW kill; the
        // result is delivered by push (CONTENT_SPAWN_RESULT) + status poll.
        void startRecoverableSpawnBatch(String(msg.batchKey), spawns, platform, model, originTabId)
        sendResponse({ ok: true, accepted: true })
        return false
      }
      // Legacy single-channel mode (no batchKey): kept for old content scripts.
      runSubAgentBatch(spawns, platform, model, 0, originTabId)
        .then(results => sendResponse({ ok: true, results }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }))
      return true // keep the message channel open for async sendResponse
    }

    if (msg.type === 'CONTENT_SPAWN_STATUS') {
      const batchKey = String(msg.batchKey || '')
      const mem = finishedSpawnBatches.get(batchKey)
      if (mem) {
        sendResponse({ state: 'done', results: mem })
        return false
      }
      if (liveSpawnBatches.has(batchKey)) {
        sendResponse({ state: 'running' })
        return false
      }
      loadSpawnBatch(batchKey)
        .then(rec => {
          if (!rec) {
            sendResponse({ state: 'unknown' })
            return
          }
          if (rec.done) {
            const results = rec.agents.map(a => a.result).filter((r): r is ToolResult => !!r)
            sendResponse({ state: 'done', results })
            return
          }
          // Orphan found by the poll (SW restarted between polls): resume now.
          void runSpawnBatchRecord(rec)
          sendResponse({ state: 'running' })
        })
        .catch(() => sendResponse({ state: 'unknown' }))
      return true
    }

    if (msg.type === 'CHAT_QUESTION_ANSWER') {
      const pending = pendingQuestions.get(msg.call_id)
      if (pending) {
        pendingQuestions.delete(msg.call_id)
        pending.resolve(msg.answer || '')
      }
      sendResponse({ ok: true })
      return false
    }

    return false
  })
}
