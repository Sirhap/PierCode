import { useEffect, useRef, useState, useCallback } from 'react'
import Picker, { type PickerItem } from './Picker'
import TokenPanel from './token-panel'
import { classifyCompletion } from './completions'
import { filterAgentTemplates } from './agent-templates'
import {
  saveSession, loadSession, listSessions, deleteSession,
  getActiveSessionId, setActiveSessionId,
  type SessionMeta, type StoredSession,
} from './session-store'

// ── Types ──────────────────────────────────────────────────────────────────

type Platform = 'qwen' | 'chatgpt' | 'claude' | 'openai'

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

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  toolStreams?: Record<string, string[]>  // call_id → stream chunks
  streaming?: boolean
  ts?: number
}

const PLATFORMS: { key: Platform; label: string; icon: string; tip: string }[] = [
  { key: 'qwen', label: 'Qwen', icon: '🔮', tip: '需要已登录 chat.qwen.ai' },
  { key: 'chatgpt', label: 'ChatGPT', icon: '💬', tip: '需要已登录 chatgpt.com' },
  { key: 'claude', label: 'Claude', icon: '🟣', tip: '需要已登录 claude.ai' },
  { key: 'openai', label: 'OpenAI 兼容', icon: '🔗', tip: '需要在 storage 配置 API Key' },
]

const DEFAULT_MODELS: Record<Platform, string> = {
  qwen: 'qwen3.7-plus',
  chatgpt: 'gpt-4o',
  claude: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
}

interface ModelInfo { id: string; name: string }

// ── Helpers ────────────────────────────────────────────────────────────────

async function getQwenToken(): Promise<string | null> {
  return new Promise(resolve => {
    chrome.cookies.get({ url: 'https://chat.qwen.ai/', name: 'token' }, cookie => {
      resolve(cookie?.value || null)
    })
  })
}

async function bgFetch(url: string, options?: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'FETCH', url, options },
      (result: { ok: boolean; status: number; body: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        resolve({ ok: result.ok, status: result.status, text: result.body })
      },
    )
  })
}

async function getAuth(): Promise<{ apiUrl: string; token: string } | null> {
  return new Promise(resolve => {
    chrome.storage.local.get(['apiUrl', 'authToken'], (result) => {
      if (result.apiUrl && result.authToken) {
        resolve({ apiUrl: result.apiUrl, token: result.authToken })
      } else {
        resolve(null)
      }
    })
  })
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  })
}

// ── Sub-agent types + id helper ────────────────────────────────────────────

interface SubAgent {
  id: string
  label: string
  task: string
  status: 'running' | 'done' | 'error'
  messages: ChatMessage[]
}

function genId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function appendAgentChunk(messages: ChatMessage[], chunk: string): ChatMessage[] {
  const next = [...messages]
  const last = next[next.length - 1]
  if (last && last.role === 'assistant' && last.streaming) {
    next[next.length - 1] = { ...last, content: last.content + chunk }
  } else {
    next.push({ role: 'assistant', content: chunk, streaming: true })
  }
  return next
}

// ── Markdown renderer ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderMarkdown(text: string): string {
  if (!text) return ''
  let src = text.replace(/\r\n/g, '\n')

  const codeBlocks: string[] = []
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\x00CODE${idx}\x00`
  })

  src = escapeHtml(src)
  src = src.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  src = src.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  src = src.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  src = src.replace(/^---+$/gm, '<hr/>')
  src = src.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
  src = src.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, header, _sep, body) => {
    const ths = header.split('|').filter(Boolean).map((c: string) => `<th>${c.trim()}</th>`).join('')
    const rows = body.trim().split('\n').map((row: string) => {
      const tds = row.split('|').filter(Boolean).map((c: string) => `<td>${c.trim()}</td>`).join('')
      return `<tr>${tds}</tr>`
    }).join('')
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`
  })
  src = src.replace(/^[\s]*[-*+] (.+)$/gm, '<li>$1</li>')
  src = src.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  src = src.replace(/^[\s]*\d+\. (.+)$/gm, '<li>$1</li>')
  src = src.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  src = src.replace(/\*(.+?)\*/g, '<em>$1</em>')
  src = src.replace(/~~(.+?)~~/g, '<del>$1</del>')
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  src = src.replace(/`([^`]+)`/g, '<code>$1</code>')
  src = src.replace(/\n\n+/g, '</p><p>')
  src = src.replace(/\n/g, '<br/>')
  src = `<p>${src}</p>`
  src = src.replace(/<p>\s*<\/p>/g, '')
  src = src.replace(/<p>(<(?:h[1-3]|ul|ol|pre|blockquote|hr|table))/g, '$1')
  src = src.replace(/(<\/(?:h[1-3]|ul|ol|pre|blockquote|hr|table)>)<\/p>/g, '$1')
  src = src.replace(/<p>(<hr\/?>)/g, '$1')
  src = src.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)] || '')
  return src
}

// ── Destructive command detection ──────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r)/, label: 'rm -rf（递归强制删除）' },
  { pattern: /rm\s+-rf\s+\//, label: 'rm -rf /（删除根目录）' },
  { pattern: /git\s+reset\s+--hard/, label: 'git reset --hard（不可逆重置）' },
  { pattern: /git\s+clean\s+-fd/, label: 'git clean -fd（强制清理）' },
  { pattern: /git\s+push\s+.*--force/, label: 'git push --force（强制推送）' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, label: 'DROP TABLE/DATABASE（删除数据库对象）' },
  { pattern: /DELETE\s+FROM.*WHERE\s+1\s*=\s*1/i, label: 'DELETE FROM（清空表数据）' },
  { pattern: /mkfs/, label: 'mkfs（格式化磁盘）' },
  { pattern: /dd\s+if=/, label: 'dd（低级磁盘写入）' },
  { pattern: />\s*\/dev\/sd[a-z]/, label: '写入磁盘设备' },
]

function getDestructiveWarning(args: Record<string, unknown>): string | null {
  const cmd = String(args.command || args.cmd || '')
  if (!cmd) return null
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) return label
  }
  return null
}

// ── Tool Card Component ────────────────────────────────────────────────────

function ToolCard({ tool, result, streams }: {
  tool: ToolCall
  result?: ToolResult
  streams?: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  const statusIcon = result ? (result.success ? '✅' : '❌') : '⏳'
  const warning = getDestructiveWarning(tool.args)

  return (
    <div className="tool-card">
      {/* Destructive warning */}
      {warning && (
        <div className="px-2 py-1 bg-red-900/40 border-b border-red-800/40 text-[10px] text-red-300 flex items-center gap-1">
          <span>⚠️</span><span>危险操作: {warning}</span>
        </div>
      )}
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <span>{statusIcon}</span>
        <span className="text-blue-400 font-mono text-[11px]">{tool.name}</span>
        {tool.call_id && <span className="text-gray-600 font-mono text-[9px]">#{tool.call_id.slice(-8)}</span>}
        {!result && <span className="text-gray-500 animate-pulse-dot text-[11px]">执行中</span>}
        <span className="ml-auto text-gray-600 text-[10px]">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="tool-card-body">
          {Object.keys(tool.args).length > 0 && (
            <div className="mb-2">
              <div className="text-gray-500 mb-1">参数:</div>
              <pre className="text-gray-300">{JSON.stringify(tool.args, null, 2)}</pre>
            </div>
          )}
          {/* Live stream output */}
          {streams && streams.length > 0 && (
            <div className="mb-2">
              <div className="text-gray-500 mb-1">输出流:</div>
              <pre className="text-emerald-300 max-h-24 overflow-y-auto">{streams.join('')}</pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-gray-500 mb-1">结果:</div>
              <pre className={result.success ? 'text-gray-300' : 'text-red-300'}>{result.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Message Bubble Component ───────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  const isTool = msg.role === 'tool_result'

  if (isTool) {
    return (
      <div className="msg-row px-3 py-1">
        <div className="rounded-lg bg-gray-800/50 border border-gray-800 p-2 text-xs text-gray-400">
          <span className="text-gray-500">📎 工具结果</span>
          <pre className="mt-1 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {msg.content.slice(0, 500)}{msg.content.length > 500 ? '...' : ''}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className={`msg-row px-3 py-1 ${isUser ? 'flex justify-end' : ''}`}>
      <div className="relative group max-w-[92%]">
        <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed ${isUser ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100'}`}>
          {msg.toolCalls?.map((tc, i) => (
            <ToolCard
              key={tc.call_id || i}
              tool={tc}
              result={msg.toolResults?.find(r => r.call_id === tc.call_id)}
              streams={msg.toolStreams?.[tc.call_id]}
            />
          ))}
          {msg.content && (
            <div
              className={`msg-content ${msg.toolCalls?.length ? 'mt-2' : ''}`}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
            />
          )}
          {msg.streaming && (
            <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse-dot ml-0.5 align-text-bottom" />
          )}
        </div>
        <div className={`flex items-center gap-2 mt-0.5 ${isUser ? 'justify-end' : ''}`}>
          {msg.ts && <span className="text-[10px] text-gray-600">{formatTime(msg.ts)}</span>}
          {msg.content && !msg.streaming && (
            <button onClick={() => copyToClipboard(msg.content)} className="copy-btn text-[10px] text-gray-600 hover:text-gray-400 cursor-pointer" title="复制消息">📋</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Connection Status Component ────────────────────────────────────────────

function ConnectionInfo({ connected }: { connected: boolean }) {
  const [details, setDetails] = useState<{ version: string; rootDir: string }>({ version: '', rootDir: '' })

  useEffect(() => {
    if (!connected) return
    chrome.storage.local.get(['apiUrl', 'authToken'], (result) => {
      if (!result.apiUrl || !result.authToken) return
      const headers = { Authorization: `Bearer ${result.authToken}` }
      Promise.all([
        fetch(`${result.apiUrl}/health`, { headers }).then(r => r.json()).catch(() => null),
        fetch(`${result.apiUrl}/config`, { headers }).then(r => r.json()).catch(() => null),
      ]).then(([health, config]) => {
        setDetails({ version: health?.version || '', rootDir: config?.rootDir || '' })
      })
    })
  }, [connected])

  if (!connected) return null

  return (
    <div className="px-3 py-1.5 border-b border-gray-800/40 text-[10px] text-gray-600 flex items-center gap-3 overflow-hidden">
      {details.version && <span>v{details.version}</span>}
      {details.rootDir && <span className="truncate flex-1" title={details.rootDir}>📁 {details.rootDir}</span>}
    </div>
  )
}

// ── Sub-agent Card Component ───────────────────────────────────────────────

function SubAgentCard({ agent }: { agent: SubAgent }) {
  const [open, setOpen] = useState(false)
  const icon = agent.status === 'running' ? '⏳' : agent.status === 'error' ? '❌' : '✅'
  const transcript = agent.messages.map(m => m.content).join('')
  return (
    <div className="rounded-md border border-gray-800 bg-gray-900/60 text-xs">
      <div className="flex items-center gap-2 px-2 py-1 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span>{icon}</span>
        <span className="text-purple-300 font-mono text-[11px]">@{agent.label}</span>
        <span className="text-gray-600 truncate flex-1">{agent.task.slice(0, 40)}</span>
        <span className="text-gray-600 text-[10px]">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <pre className="px-2 pb-2 text-[10px] text-gray-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {transcript || '(暂无输出)'}
        </pre>
      )}
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [platform, setPlatform] = useState<Platform>('qwen')
  const [model, setModel] = useState(DEFAULT_MODELS.qwen)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [streaming, setStreaming] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [tokenThreshold, setTokenThreshold] = useState<number | undefined>()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const currentAssistantIdx = useRef(-1)
  const chatIdRef = useRef<string | null>(null)
  const lastResponseIdRef = useRef<string | null>(null)

  // ── Picker state ──────────────────────────────────────────────────────
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([])
  const [pickerMode, setPickerMode] = useState<'skills' | 'files' | 'agents' | null>(null)
  const [pickerToken, setPickerToken] = useState('')  // the /query or @query being completed
  const skillsCacheRef = useRef<{ ts: number; items: PickerItem[] } | null>(null)

  // ── Sub-agent + session state ─────────────────────────────────────────
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const sessionIdRef = useRef<string>(genId())

  // ── Connection check ──────────────────────────────────────────────────
  useEffect(() => {
    const check = () => {
      chrome.storage.local.get(['authToken', 'apiUrl'], (result) => {
        if (result.authToken && result.apiUrl) {
          fetch(`${result.apiUrl}/health`).then(r => r.ok ? setConnected(true) : setConnected(false)).catch(() => setConnected(false))
        } else {
          setConnected(false)
        }
      })
    }
    check()
    const timer = setInterval(check, 10000)
    return () => clearInterval(timer)
  }, [])

  // ── Restore the last active session on mount; populate the session list ─
  useEffect(() => {
    (async () => {
      setSessions(await listSessions())
      const activeId = await getActiveSessionId()
      if (!activeId) return
      const s = await loadSession(activeId)
      if (!s) return
      sessionIdRef.current = s.id
      setMessages(s.messages as ChatMessage[])
      setPlatform(s.platform as Platform)
      setModel(s.model)
      chatIdRef.current = s.chatId
      lastResponseIdRef.current = s.lastResponseId
    })()
  }, [])

  // ── Persist the current session (debounced) whenever it changes ────────
  useEffect(() => {
    if (messages.length === 0) return
    const id = sessionIdRef.current
    const handle = setTimeout(() => {
      const payload: StoredSession = {
        id,
        platform,
        model,
        chatId: chatIdRef.current,
        lastResponseId: lastResponseIdRef.current,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        ts: Date.now(),
      }
      saveSession(payload).then(() => { setActiveSessionId(id); listSessions().then(setSessions) })
    }, 300)
    return () => clearTimeout(handle)
  }, [messages, platform, model])

  // ── Load model + token threshold from storage ─────────────────────────
  useEffect(() => {
    const key = `${platform}Model`
    chrome.storage.local.get([key, 'contextCompressionConfig'], (result) => {
      if (typeof result[key] === 'string') setModel(result[key])
      else setModel(DEFAULT_MODELS[platform] || 'gpt-4o')
      // Token threshold
      const cfg = result.contextCompressionConfig
      if (cfg?.perPlatformThresholds?.[platform]) {
        setTokenThreshold(cfg.perPlatformThresholds[platform])
      } else if (cfg?.defaultMaxContextTokens) {
        setTokenThreshold(cfg.defaultMaxContextTokens)
      }
    })
    // Fetch Qwen models
    if (platform === 'qwen') {
      getQwenToken().then(token => {
        if (!token) { setModels([]); return }
        fetch('https://chat.qwen.ai/api/v2/models', {
          headers: { 'Authorization': `Bearer ${token}`, 'version': '0.2.63', 'source': 'web' },
          redirect: 'follow',
        }).then(r => r.json()).then(data => {
          if (data.success && Array.isArray(data.data?.data)) {
            setModels(data.data.data.map((m: any) => ({ id: m.id, name: m.name })))
          }
        }).catch(() => setModels([]))
      })
    } else {
      setModels([])
    }
  }, [platform])

  const handleModelChange = (value: string) => {
    setModel(value)
    chrome.storage.local.set({ [`${platform}Model`]: value })
  }

  // ── Streaming message listener ────────────────────────────────────────
  useEffect(() => {
    const CHAT_TYPES = new Set(['CHAT_STREAM', 'CHAT_TOOLS', 'CHAT_TOOL_DONE', 'CHAT_TOOL_STREAM', 'CHAT_DONE', 'CHAT_ERROR', 'CHAT_AGENT_SPAWN', 'CHAT_AGENT_STREAM', 'CHAT_AGENT_DONE'])
    const listener = (msg: any) => {
      if (!msg?.type || !CHAT_TYPES.has(msg.type)) return
      if (msg.type === 'CHAT_STREAM') {
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) {
            next[idx] = { ...next[idx], content: next[idx].content + (msg.chunk || ''), streaming: true }
          }
          return next
        })
      } else if (msg.type === 'CHAT_TOOLS') {
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) {
            const existing = next[idx]
            next[idx] = { ...existing, toolCalls: [...(existing.toolCalls || []), ...(msg.tools || [])] }
          }
          return next
        })
      } else if (msg.type === 'CHAT_TOOL_STREAM') {
        // Live stream output from tool execution
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) {
            const existing = next[idx]
            const streams = { ...(existing.toolStreams || {}) }
            const callId = msg.call_id || 'unknown'
            streams[callId] = [...(streams[callId] || []), msg.text || '']
            next[idx] = { ...existing, toolStreams: streams }
          }
          return next
        })
      } else if (msg.type === 'CHAT_TOOL_DONE') {
        const result: ToolResult = msg.result
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) {
            const existing = next[idx]
            next[idx] = { ...existing, toolResults: [...(existing.toolResults || []), result] }
          }
          return next
        })
      } else if (msg.type === 'CHAT_DONE') {
        if (msg.chatId) chatIdRef.current = msg.chatId
        if (msg.responseId) lastResponseIdRef.current = msg.responseId
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) next[idx] = { ...next[idx], streaming: false }
          return next
        })
        setStreaming(false)
      } else if (msg.type === 'CHAT_AGENT_SPAWN') {
        setSubAgents(prev => [...prev, { id: msg.agentId, label: msg.label, task: msg.task, status: 'running', messages: [] }])
      } else if (msg.type === 'CHAT_AGENT_STREAM') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId
          ? { ...a, messages: appendAgentChunk(a.messages, msg.chunk || '') }
          : a))
      } else if (msg.type === 'CHAT_AGENT_DONE') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId ? { ...a, status: msg.status === 'error' ? 'error' : 'done' } : a))
      } else if (msg.type === 'CHAT_ERROR') {
        setError(msg.error || '未知错误')
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) next[idx] = { ...next[idx], streaming: false }
          return next
        })
        setStreaming(false)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // ── Auto-scroll ───────────────────────────────────────────────────────
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  // ── Auto-resize textarea ──────────────────────────────────────────────
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [input])

  useEffect(() => { inputRef.current?.focus() }, [])

  // ── /skills, @files, @@agents autocomplete ────────────────────────────
  const updateCompletions = useCallback(async (text: string) => {
    const match = classifyCompletion(text)
    if (!match) {
      setPickerMode(null)
      setPickerItems([])
      return
    }
    setPickerToken(match.token)

    if (match.mode === 'skills') {
      setPickerMode('skills')
      // Fetch skills (cached 30s)
      const now = Date.now()
      if (skillsCacheRef.current && now - skillsCacheRef.current.ts < 30_000) {
        setPickerItems(skillsCacheRef.current.items.filter(
          item => item.label.includes(match.query) || (item.sub || '').includes(match.query)))
        return
      }
      const auth = await getAuth()
      if (!auth) return
      try {
        const res = await bgFetch(`${auth.apiUrl}/skills`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
        const data = JSON.parse(res.text)
        const skills: PickerItem[] = (data.skills || [])
          .filter((s: any) => !s.name?.startsWith('piercode-'))
          .map((s: any) => ({ label: s.name, sub: s.description, value: s.name }))
        skillsCacheRef.current = { ts: now, items: skills }
        setPickerItems(skills.filter(item => item.label.includes(match.query) || (item.sub || '').includes(match.query)))
      } catch {
        setPickerItems([])
      }
      return
    }

    if (match.mode === 'agents') {
      setPickerMode('agents')
      const active: PickerItem[] = subAgents
        .filter(a => a.status === 'running')
        .map(a => ({ label: `@${a.label}`, sub: `运行中 · ${a.task.slice(0, 24)}`, value: `@${a.label} ` }))
      const templates = filterAgentTemplates(match.query)
      setPickerItems([...active, ...templates])
      return
    }

    // files
    setPickerMode('files')
    const auth = await getAuth()
    if (!auth) return
    try {
      const res = await bgFetch(`${auth.apiUrl}/files?q=${encodeURIComponent(match.query)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const data = JSON.parse(res.text)
      const files: string[] = data.files || []
      setPickerItems(files.slice(0, 20).map(f => ({ label: f, value: f })))
    } catch {
      setPickerItems([])
    }
  }, [subAgents])

  const handlePickerSelect = useCallback(async (item: PickerItem) => {
    if (pickerMode === 'skills') {
      // Load skill content and insert into input
      const auth = await getAuth()
      if (!auth) return
      try {
        const res = await bgFetch(`${auth.apiUrl}/exec`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ name: 'skill', call_id: `skill-${Date.now()}`, args: { skill: item.value } }),
        })
        const data = JSON.parse(res.text)
        const content = data.output || data.error || ''
        // Replace the /token with formatted skill insertion
        const insertion = `请加载并遵循下面的 PierCode skill。\n<skill name="${item.value}">\n${content}\n</skill>\n任务：`
        setInput(prev => prev.replace(new RegExp(escapeRegExp(pickerToken) + '$'), insertion))
      } catch {
        // Fallback: just insert the skill name
        setInput(prev => prev.replace(new RegExp(escapeRegExp(pickerToken) + '$'), `/${item.value} `))
      }
    } else if (pickerMode === 'files') {
      // Replace @token with file path
      setInput(prev => prev.replace(new RegExp(escapeRegExp(pickerToken) + '$'), item.value + ' '))
    } else if (pickerMode === 'agents') {
      // Replace @@token with the agent reference / task-template text
      setInput(prev => prev.replace(new RegExp(escapeRegExp(pickerToken) + '$'), item.value))
    }
    setPickerMode(null)
    setPickerItems([])
    inputRef.current?.focus()
  }, [pickerMode, pickerToken])

  const handlePickerClose = useCallback(() => {
    setPickerMode(null)
    setPickerItems([])
  }, [])

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // ── Input change handler ──────────────────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    updateCompletions(value)
  }

  // ── Send ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || streaming) return

    setError('')
    const now = Date.now()
    const userMsg: ChatMessage = { role: 'user', content: text, ts: now }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, ts: now }

    const newMessages = [...messages, userMsg, assistantMsg]
    currentAssistantIdx.current = newMessages.length - 1
    setMessages(newMessages)
    setInput('')
    setStreaming(true)
    setPickerMode(null)
    setPickerItems([])

    chrome.runtime.sendMessage({
      type: 'CHAT_REQUEST',
      platform,
      model,
      chatId: chatIdRef.current,
      parentId: lastResponseIdRef.current,
      message: text,
    })
  }, [input, messages, platform, model, streaming])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't send if picker is open (let Picker handle Enter)
    if (pickerItems.length > 0 && (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape')) {
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCancel = () => {
    chrome.runtime.sendMessage({ type: 'CHAT_CANCEL' })
    setStreaming(false)
    setMessages(prev => {
      const next = [...prev]
      const idx = currentAssistantIdx.current
      if (idx >= 0 && idx < next.length) next[idx] = { ...next[idx], streaming: false }
      return next
    })
  }

  const startNewSession = useCallback(() => {
    if (streaming) chrome.runtime.sendMessage({ type: 'CHAT_CANCEL' })
    sessionIdRef.current = genId()
    setMessages([])
    setSubAgents([])
    setError('')
    setStreaming(false)
    currentAssistantIdx.current = -1
    chatIdRef.current = null
    lastResponseIdRef.current = null
    setActiveSessionId(sessionIdRef.current)
    inputRef.current?.focus()
  }, [streaming])

  const switchSession = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) return
    const s = await loadSession(id)
    if (!s) return
    sessionIdRef.current = s.id
    setMessages(s.messages as ChatMessage[])
    setSubAgents([])
    setPlatform(s.platform as Platform)
    setModel(s.model)
    chatIdRef.current = s.chatId
    lastResponseIdRef.current = s.lastResponseId
    setActiveSessionId(s.id)
  }, [])

  const removeCurrentSession = useCallback(async () => {
    const id = sessionIdRef.current
    await deleteSession(id)
    const list = await listSessions()
    setSessions(list)
    if (list.length > 0) await switchSession(list[0].id)
    else startNewSession()
  }, [switchSession, startNewSession])

  // ── Init prompt ───────────────────────────────────────────────────────
  const handleInit = async () => {
    const auth = await getAuth()
    if (!auth) return
    try {
      const res = await bgFetch(`${auth.apiUrl}/prompt`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const text = res.text
      if (!text) return
      // Send as user message
      const now = Date.now()
      const userMsg: ChatMessage = { role: 'user', content: text, ts: now }
      const assistantMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, ts: now }
      const newMessages = [...messages, userMsg, assistantMsg]
      currentAssistantIdx.current = newMessages.length - 1
      setMessages(newMessages)
      setStreaming(true)
      chrome.runtime.sendMessage({
        type: 'CHAT_REQUEST',
        platform,
        model,
        chatId: chatIdRef.current,
        parentId: lastResponseIdRef.current,
        message: text,
      })
    } catch (err) {
      setError(`初始化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 font-sans">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 bg-gray-950 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">⚡</span>
          <span className="text-sm font-semibold text-white">PierCode Chat</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Init button — only when no messages */}
          {messages.length === 0 && connected && (
            <button
              onClick={handleInit}
              className="text-[10px] px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 border border-blue-600/40 hover:bg-blue-600/40 cursor-pointer transition-colors"
              title="发送初始化提示词"
            >
              ⚡ 初始化
            </button>
          )}
          {sessions.length > 0 && (
            <select
              value={sessionIdRef.current}
              onChange={e => switchSession(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-300 outline-none max-w-[120px]"
              title="切换会话"
            >
              {sessions.map(s => <option key={s.id} value={s.id}>{s.title || '新对话'}</option>)}
            </select>
          )}
          <button onClick={startNewSession} className="text-[10px] text-gray-600 hover:text-blue-400 cursor-pointer" title="新对话">➕</button>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-[10px] text-gray-500">{connected ? '已连接' : '未连接'}</span>
          {messages.length > 0 && (
            <button onClick={removeCurrentSession} className="text-[10px] text-gray-600 hover:text-red-400 cursor-pointer ml-1" title="删除当前对话">🗑️</button>
          )}
        </div>
      </div>

      {/* ── Connection details ──────────────────────────────────────────────── */}
      <ConnectionInfo connected={connected} />

      {/* ── Platform selector + model ───────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800/60 flex-shrink-0 overflow-x-auto">
        {PLATFORMS.map(p => (
          <button
            key={p.key}
            onClick={() => setPlatform(p.key)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-xs transition-colors cursor-pointer whitespace-nowrap ${
              platform === p.key
                ? 'bg-blue-600/20 text-blue-300 border border-blue-600/40'
                : 'text-gray-500 hover:text-gray-300 border border-transparent'
            }`}
          >
            <span>{p.icon}</span><span>{p.label}</span>
          </button>
        ))}
        {models.length > 0 ? (
          <select
            value={model}
            onChange={e => handleModelChange(e.target.value)}
            className="ml-auto w-40 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-gray-300 outline-none focus:border-blue-500 transition-colors cursor-pointer"
          >
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <input
            value={model}
            onChange={e => handleModelChange(e.target.value)}
            className="ml-auto w-36 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-[11px] text-gray-300 outline-none focus:border-blue-500 transition-colors"
            placeholder="模型名"
          />
        )}
      </div>

      {/* ── Messages ────────────────────────────────────────────────────────── */}
      <div ref={listRef} className="flex-1 overflow-y-auto chat-scroll py-2 space-y-1">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-xs gap-3 px-4">
            <span className="text-3xl">💬</span>
            <span className="text-gray-500 font-medium">选择平台，输入消息开始对话</span>
            <div className="text-center text-gray-700 space-y-1 max-w-[260px]">
              <p>⚡ 初始化 注入系统提示词</p>
              <p>/skills 自动补全技能</p>
              <p>@文件名 引用本地文件</p>
              <p>@@ 派发子 agent / 任务模板</p>
              <p>工具调用自动执行，结果注入对话</p>
              <p className="text-[10px] mt-2">Enter 发送 · Shift+Enter 换行</p>
            </div>
            {!connected && (
              <div className="mt-2 text-[10px] text-amber-600 text-center">
                ⚠️ 未连接 PierCode 服务<br/>请先在扩展弹窗中配置 Token
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
      </div>

      {/* ── Sub-agents ──────────────────────────────────────────────────────── */}
      {subAgents.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-800/40 bg-gray-950/60 flex-shrink-0 space-y-1 max-h-40 overflow-y-auto">
          {subAgents.map(a => (
            <SubAgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}

      {/* ── Error bar ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="px-3 py-1.5 bg-red-900/30 border-t border-red-800/40 text-xs text-red-300 flex items-center gap-2 flex-shrink-0">
          <span>⚠️</span>
          <span className="flex-1 truncate">{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300 cursor-pointer flex-shrink-0">✕</button>
        </div>
      )}

      {/* ── Token panel ─────────────────────────────────────────────────────── */}
      <TokenPanel messages={messages} threshold={tokenThreshold} platform={platform} />

      {/* ── Input ───────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-gray-950 p-2 relative">
        {/* Picker popup */}
        {pickerItems.length > 0 && (
          <Picker
            items={pickerItems}
            onSelect={handlePickerSelect}
            onClose={handlePickerClose}
          />
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={connected ? '输入消息... / @ 技能和文件' : '请先连接 PierCode 服务'}
            rows={1}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500 transition-colors resize-none overflow-hidden"
            style={{ maxHeight: '120px' }}
            disabled={streaming}
          />
          {streaming ? (
            <button onClick={handleCancel} className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors cursor-pointer flex-shrink-0" title="停止生成">■</button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || !connected} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0" title="发送 (Enter)">➤</button>
          )}
        </div>
      </div>
    </div>
  )
}
