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

import { FENCE_RE, parseFenceToolCalls, formatToolResults } from '../parser'

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

interface PlatformConfig {
  name: string
  cookieName: string
  cookieDomain: string
  /** Create a new conversation on the server, return its ID. */
  createConversation?(token: string, model: string): Promise<string>
  getUrl(ctx?: { chatId?: string; model?: string }): string
  buildHeaders(token: string): Record<string, string>
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

// ── Platform Configs ───────────────────────────────────────────────────────
// Note: `getUrl()` is a function, not a mutable field, to avoid module-level
// state mutation that would cause races if two requests run concurrently.

// Exported for unit tests (buildBody reasoning mapping). Not used elsewhere.
export const PLATFORMS: Record<string, PlatformConfig> = {
  qwen: {
    name: 'Qwen',
    cookieName: 'token',
    cookieDomain: 'chat.qwen.ai',
    async createConversation(token, model) {
      const res = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://chat.qwen.ai',
          'Referer': 'https://chat.qwen.ai/',
          'version': '0.2.63',
          'source': 'web',
          'x-request-id': crypto.randomUUID(),
          'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
          'bx-v': '2.5.36',
        },
        body: JSON.stringify({
          title: '新建对话',
          models: [model],
          chat_mode: 'normal',
          chat_type: 't2t',
          timestamp: Math.floor(Date.now() / 1000),
          project_id: '',
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`创建会话失败 ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      if (!data.success || !data.data?.id) {
        throw new Error(`创建会话失败: ${JSON.stringify(data)}`)
      }
      return data.data.id
    },
    getUrl(ctx) {
      const chatId = ctx?.chatId || crypto.randomUUID()
      return `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`
    },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'bx-v': '2.5.36',
      }
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
  },

  chatgpt: {
    name: 'ChatGPT',
    cookieName: '__Secure-next-auth.session-token',
    cookieDomain: 'chatgpt.com',
    // content.parts[0] is a cumulative snapshot per in_progress event, not a delta.
    isSnapshot: true,
    getUrl() { return 'https://chatgpt.com/backend-api/conversation' },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
      }
    },
    buildBody(message, _parentId, ctx) {
      // ChatGPT picks reasoning by MODEL SLUG, not a separate flag: from the
      // captured /backend-api/models response, thinking models carry
      // reasoning_type:"reasoning" + thinking_efforts (standard|extended), and
      // /settings/user.last_used_model_config stores the effort as a "juice".
      // 'think' → a thinking slug; 'auto' (default) → the auto-routing model.
      // TODO(reasoning): the whole ChatGPT send path is currently NON-FUNCTIONAL
      // — chatgpt.com gates /conversation behind sentinel + turnstile
      // (/backend-api/sentinel/chat-requirements/prepare) which this bare POST
      // does not satisfy. Slug/juice mapping below is unverified end-to-end and
      // only takes effect once the send path is fixed.
      const slug = ctx?.reasoning === 'think' ? 'gpt-5-5-thinking' : 'auto'
      return JSON.stringify({
        action: 'next',
        messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [message] } }],
        model: slug,
        stream: true,
      })
    },
    parseChunk(data) {
      const msg = data.message
      if (!msg) return null
      if (msg.content?.parts?.length > 0) {
        return msg.status === 'in_progress' ? msg.content.parts[0] : null
      }
      if (msg.delta?.content?.parts?.length > 0) {
        return msg.delta.content.parts[0]
      }
      return null
    },
  },

  claude: {
    name: 'Claude',
    cookieName: 'sessionKey',
    cookieDomain: 'claude.ai',
    supportsSystem: true,
    getUrl() {
      // Claude API requires org + conversation. This is resolved per-request
      // in getAuth() and stashed in session storage — no module mutation.
      return '' // placeholder; real URL passed via getAuth result
    },
    buildHeaders(token) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://claude.ai',
        'Referer': 'https://claude.ai/',
      }
    },
    buildBody(message, _parentId, ctx) {
      const body: Record<string, unknown> = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: message }],
        stream: true,
      }
      if (ctx?.systemPrompt) body.system = ctx.systemPrompt
      // TODO(reasoning): claude.ai's web endpoint is reverse-engineered and we
      // have NOT confirmed it accepts the public-API extended-thinking field.
      // Shape below mirrors the documented API; verify against a real claude.ai
      // request before relying on it. 'off' (default) sends nothing.
      if (ctx?.reasoning === 'think') {
        body.thinking = { type: 'enabled', budget_tokens: 4096 }
      }
      return JSON.stringify(body)
    },
    parseChunk(data) {
      if (data.type === 'content_block_delta' && data.delta?.text) {
        return data.delta.text
      }
      return null
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

  // Claude：需要额外获取 org ID
  if (platform === 'claude') {
    const token = await getCookieToken(config.cookieDomain, config.cookieName)
    if (!token) return { error: '未找到 Claude sessionKey cookie，请先登录 claude.ai' }
    try {
      const res = await fetch('https://claude.ai/api/organizations', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (res.ok) {
        const orgs = await res.json()
        if (Array.isArray(orgs) && orgs.length > 0) {
          const url = `https://claude.ai/api/organizations/${orgs[0].uuid}/chat_conversations`
          return { token, url }
        }
      }
    } catch {}
    return { error: '无法获取 Claude 组织信息，请确认已登录' }
  }

  // Qwen / ChatGPT：cookie 认证
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
  const calls: ToolCall[] = []
  let match: RegExpExecArray | null
  FENCE_RE.lastIndex = 0
  while ((match = FENCE_RE.exec(content)) !== null) {
    for (const tc of parseFenceToolCalls(match[1])) {
      calls.push({
        name: tc.name,
        args: tc.args,
        call_id: tc.callId || `detected-${match.index}-${calls.length}`,
      })
    }
  }
  return calls
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
  return {
    call_id: call.call_id,
    name: call.name,
    output: finalText || '(子 agent 无输出)',
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

interface SSEResult {
  content: string
  responseId: string | null
}

async function processSSEStream(
  response: Response,
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

async function handleChatRequest(params: ChatRequestParams): Promise<void> {
  const { platform, depth = 0, systemPrompt, reasoning } = params
  let { chatId, parentId, model: modelOverride, message } = params

  const config = PLATFORMS[platform]
  if (!config) {
    broadcast({ type: 'CHAT_ERROR', error: `未知平台: ${platform}` })
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
  const headers = config.buildHeaders(auth.token)
  const body = config.buildBody(message, parentId, ctx)

  currentAbort = new AbortController()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: currentAbort.signal,
    })

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

    // Check for tool calls
    const toolCalls = extractToolCalls(sseResult.content)

    if (toolCalls.length > 0) {
      broadcast({ type: 'CHAT_TOOLS', tools: toolCalls })

      const { spawns, normal } = partitionSpawnCalls(toolCalls)
      const results: ToolResult[] = []

      // Separate question tools — they need user interaction, not server exec.
      const questions = normal.filter(tc => tc.name === 'question')
      const execTools = normal.filter(tc => tc.name !== 'question')

      // Question tools → ask sidebar to collect user answer.
      for (const tc of questions) {
        if (currentAbort.signal.aborted) break
        const answer = await askQuestion(tc)
        results.push(answer)
        broadcast({ type: 'CHAT_TOOL_DONE', result: answer })
      }

      // Normal tools → server /exec.
      for (const tc of execTools) {
        if (currentAbort.signal.aborted) break
        const result = await execTool(tc.name, tc.args, tc.call_id)
        results.push(result)
        broadcast({ type: 'CHAT_TOOL_DONE', result })
      }

      // spawn_agent → parallel sub-conversations (no tabs). Each runSubAgent
      // catches its own failures into a failed ToolResult, so Promise.all never
      // rejects on a single worker error. One batchId tags this whole batch so
      // the sidebar can build the summary card from exactly these agents.
      if (spawns.length > 0 && !currentAbort.signal.aborted) {
        const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const spawnResults = await Promise.all(
          spawns.map(tc => runSubAgent(tc, platform, modelOverride, depth, batchId)),
        )
        for (const r of spawnResults) {
          results.push(r)
          broadcast({ type: 'CHAT_TOOL_DONE', result: r })
        }
      }

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
): Promise<ToolResult> {
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const label = String(call.args.label || 'agent')
  const task = String(call.args.task || call.args.prompt || '')

  if (parentDepth >= MAX_AGENT_DEPTH) {
    return shapeSubAgentResult(call, `(子 agent 嵌套超过上限 ${MAX_AGENT_DEPTH}，已拒绝)`)
  }
  if (!task) {
    return shapeSubAgentResult(call, '(spawn_agent 缺少 task 参数)')
  }

  broadcast({ type: 'CHAT_AGENT_SPAWN', agentId, label, task, batchId })

  const workerPrompt = await fetchWorkerPrompt()
  const message = buildSubAgentMessage(workerPrompt, task)
  const { signal, cleanup } = mergedAgentSignal(agentId, currentAbort?.signal)

  try {
    const finalText = await runIsolatedConversation({
      platform,
      message,
      model,
      depth: parentDepth + 1,
      agentId,
      abortSignal: signal,
    })
    const cancelled = signal.aborted
    const output = cancelled ? `${finalText}\n\n(已取消)`.trim() : finalText
    broadcast({ type: 'CHAT_AGENT_DONE', agentId, status: cancelled ? 'error' : 'done' })
    return cancelled
      ? { call_id: call.call_id, name: call.name, output: output || '(已取消)', success: false }
      : shapeSubAgentResult(call, finalText)
  } catch (err) {
    const cancelled = signal.aborted
    const msg = cancelled ? '(已取消)' : `子 agent 失败: ${err instanceof Error ? err.message : String(err)}`
    broadcast({ type: 'CHAT_AGENT_DONE', agentId, status: 'error' })
    return { call_id: call.call_id, name: call.name, output: msg, success: false }
  } finally {
    cleanup()
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
}): Promise<string> {
  const { platform, agentId, abortSignal } = params
  let { message } = params
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`未知平台: ${platform}`)

  let chatId: string | null = null
  let parentId: string | null = null
  let lastText = ''

  for (let turn = 0; turn < MAX_TOOL_DEPTH; turn++) {
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

    const response = await fetch(url, {
      method: 'POST',
      headers: config.buildHeaders(auth.token),
      body: config.buildBody(message, parentId, ctx),
      signal: abortSignal,
    })
    if (!response.ok) {
      const t = await response.text().catch(() => '')
      throw new Error(`${config.name} ${response.status}: ${t.slice(0, 120)}`)
    }

    const sse = await processSSEStream(
      response,
      config,
      (chunk) => broadcast({ type: 'CHAT_AGENT_STREAM', agentId, chunk }),
      abortSignal,
    )
    lastText = sse.content
    parentId = sse.responseId

    const calls = extractToolCalls(sse.content)
    const { normal } = partitionSpawnCalls(calls)  // sub-agents don't spawn further
    if (normal.length === 0) break

    const results: ToolResult[] = []
    for (const tc of normal) {
      if (abortSignal?.aborted) break
      results.push(await execTool(tc.name, tc.args))
    }
    message = results.map(r => `### ${r.name} #${r.call_id}\n\n${r.output}`).join('\n\n')
  }

  return lastText
}

// ── Broadcast Helper ───────────────────────────────────────────────────────

function broadcast(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners (sidebar closed) — silent
  })
}

// ── Message Handler Registration ───────────────────────────────────────────

export function registerChatApiHandler() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
