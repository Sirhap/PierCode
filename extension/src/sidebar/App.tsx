import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import MessageView, { type ChatMessage, type ToolResult, type ThinkingStep } from './MessageView'
import Picker, { type PickerItem } from './Picker'
import TokenPanel from './token-panel'
import WorkerRadar, { type SubAgent } from './WorkerRadar'
import StatusHUD from './StatusHUD'
import { classifyCompletion } from './completions'
import { filterAgentTemplates } from './agent-templates'
import CommandPalette, { type SearchHit } from './CommandPalette'
import { type Command, fuzzyMatch } from './commands'
import { useGlow } from './use-glow'
import { GLOW_COLORS } from './glow'
import { levelsForPlatform, defaultReasoning, normalizeReasoning, REASONING_STORAGE_KEY } from './reasoning'
import {
  computeMeter,
  whenTokenizerReady,
  tokenizerState,
  type TokenMeter,
  type MeterMessage,
} from './token-count'
import {
  saveSession, loadSession, listSessions, deleteSession,
  getActiveSessionId, setActiveSessionId,
  type SessionMeta, type StoredSession,
} from './session-store'
import { accumulateBatch, AGENT_FADE_DELAY_MS, AGENT_FADE_DURATION_MS } from './subagent-ui'

// ── Types ──────────────────────────────────────────────────────────────────

type Platform = 'qwen' | 'chatgpt' | 'claude' | 'openai'

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

async function bgFetch(url: string, options?: RequestInit): Promise<{ ok: boolean; status: number; text: string; json(): any }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'FETCH', url, options },
      (result: { ok: boolean; status: number; body: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        resolve({
          ok: result.ok,
          status: result.status,
          text: result.body,
          json() {
            try { return JSON.parse(result.body) }
            catch { return { error: 'invalid JSON', raw: result.body.slice(0, 200) } }
          },
        })
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

// ── Sub-agent id helper ────────────────────────────────────────────────────

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

// ── Question Card (user interaction for question tool) ─────────────────────

function QuestionCard({ question, options, onAnswer }: {
  question: string
  options: string[]
  onAnswer: (answer: string) => void
}) {
  const [customInput, setCustomInput] = useState('')

  return (
    <div className="my-2 mx-1 rounded-sm border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="glow-text">?</span>
        <span className="text-sm font-medium glow-text">需要你的回答</span>
      </div>
      <p className="text-sm mb-3 whitespace-pre-wrap" style={{ color: 'var(--txt)' }}>{question}</p>

      {/* Option buttons */}
      {options.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswer(opt)}
              className="w-full text-left px-3 py-1.5 rounded-sm border text-sm transition-colors cursor-pointer hover:opacity-80"
              style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--txt)' }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* Custom input */}
      <div className="flex gap-2">
        <input
          value={customInput}
          onChange={e => setCustomInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && customInput.trim()) onAnswer(customInput.trim()) }}
          placeholder={options.length > 0 ? '或输入自定义回答...' : '输入回答...'}
          className="flex-1 rounded-sm border px-3 py-1.5 text-sm outline-none"
          style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--txt)' }}
        />
        <button
          onClick={() => customInput.trim() && onAnswer(customInput.trim())}
          disabled={!customInput.trim()}
          className="px-3 py-1.5 text-sm rounded-sm glow-border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'var(--glow)' }}
        >
          提交
        </button>
      </div>
    </div>
  )
}

// ── Sub-agent Card Component ───────────────────────────────────────────────

function SubAgentCard({ agent }: { agent: SubAgent }) {
  const [open, setOpen] = useState(false)
  const mark = agent.status === 'running' ? '▸▸' : agent.status === 'error' ? '✗' : '✓'
  const markCls = agent.status === 'running' ? 'text-amber-400 animate-pulse-dot' : agent.status === 'error' ? 'text-red-400' : 'glow-text'
  const transcript = agent.messages.map(m => m.content).join('')
  const abortAgent = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    chrome.runtime.sendMessage({ type: 'CHAT_AGENT_ABORT', agentId: agent.id })
  }
  return (
    <div className={`rounded-sm border text-xs${agent.fading ? ' agent-fading' : ''}`} style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-2 px-2 py-1 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span className={markCls}>{mark}</span>
        <span className="glow-text text-[11px]">@{agent.label}</span>
        <span className="truncate flex-1" style={{ color: 'var(--dim)' }}>{agent.task.slice(0, 40)}</span>
        {agent.status === 'running' && (
          <button onClick={abortAgent} title="停止此子 agent" className="px-1 cursor-pointer" style={{ color: 'var(--dim)' }}>✕</button>
        )}
        <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <pre className="px-2 pb-2 text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-y-auto" style={{ color: 'var(--dim)' }}>
          {transcript || '(暂无输出)'}
        </pre>
      )}
    </div>
  )
}

// ── Token meter helper (shared role mapping) ──────────────────────────────

type AnyRole = 'user' | 'assistant' | 'tool_result' | 'system'

function toMeterRole(role: AnyRole): MeterMessage['role'] {
  if (role === 'assistant') return 'assistant'
  if (role === 'system') return 'system'
  return 'user'
}

// ── Main App ───────────────────────────────────────────────────────────────

interface PendingQuestion {
  callId: string
  question: string
  options: string[]
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [platform, setPlatform] = useState<Platform>('qwen')
  const [model, setModel] = useState(DEFAULT_MODELS.qwen)
  const [reasoning, setReasoning] = useState(defaultReasoning('qwen'))
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
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
  // Cache the fetched init/system prompt for the extension lifetime.
  const initPromptCacheRef = useRef<string | null>(null)

  // ── Picker state ──────────────────────────────────────────────────────
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([])
  const [pickerMode, setPickerMode] = useState<'skills' | 'files' | 'agents' | null>(null)
  const [pickerToken, setPickerToken] = useState('')  // the /query or @query being completed
  const skillsCacheRef = useRef<{ ts: number; items: PickerItem[] } | null>(null)

  // ── Sub-agent + session state ─────────────────────────────────────────
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const agentTimers = useRef<Set<number>>(new Set())
  // Per-batch summary accumulation: batchExpected = spawned count per batchId,
  // batchDone = final snapshots captured at finish time (independent of live-array
  // fade removal). Emit ONE summary card when accumulated >= expected, then clear.
  const batchExpected = useRef<Map<string, number>>(new Map())
  const batchDone = useRef<Map<string, SubAgent[]>>(new Map())
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const sessionIdRef = useRef<string>(genId())

  // ── Command palette ───────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false)

  // ── Theme glow color ──────────────────────────────────────────────────
  const [glow, setGlow] = useGlow()
  const [glowMenuOpen, setGlowMenuOpen] = useState(false)

  // ── Tokenizer-ready state (triggers re-render when tiktoken loads) ─────
  const [, setTokReady] = useState(tokenizerState)
  useEffect(() => {
    let alive = true
    whenTokenizerReady().then(() => { if (alive) setTokReady(tokenizerState()) })
    return () => { alive = false }
  }, [])

  // ── Clear pending sub-agent fade/remove timers on unmount ──────────────
  useEffect(() => () => {
    agentTimers.current.forEach(id => window.clearTimeout(id))
    agentTimers.current.clear()
    batchDone.current.clear()
    batchExpected.current.clear()
  }, [])

  // ── Lifted token meter (computed once, shared by TokenPanel + StatusHUD) ─
  const meter = useMemo<TokenMeter>(() => {
    const meterMsgs: MeterMessage[] = messages.map(m => ({ role: toMeterRole(m.role as AnyRole), content: m.content }))
    return computeMeter(meterMsgs, platform)
  }, [messages, platform])

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
        reasoning,
        chatId: chatIdRef.current,
        lastResponseId: lastResponseIdRef.current,
        messages: messages.map(m => ({
          role: m.role, content: m.content, pinned: m.pinned,
          toolCalls: m.toolCalls, toolResults: m.toolResults, toolStreams: m.toolStreams,
          thinking: m.thinking, ts: m.ts,
        })),
        ts: Date.now(),
      }
      saveSession(payload).then(() => { setActiveSessionId(id); listSessions().then(setSessions) })
    }, 300)
    return () => clearTimeout(handle)
  }, [messages, platform, model, reasoning])

  // ── Load model + token threshold from storage ─────────────────────────
  useEffect(() => {
    const key = `${platform}Model`
    const rkey = REASONING_STORAGE_KEY(platform)
    chrome.storage.local.get([key, rkey, 'contextCompressionConfig'], (result) => {
      if (typeof result[key] === 'string') setModel(result[key])
      else setModel(DEFAULT_MODELS[platform] || 'gpt-4o')
      setReasoning(normalizeReasoning(platform, result[rkey]))
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

  const handleReasoningChange = (value: string) => {
    setReasoning(value)
    chrome.storage.local.set({ [REASONING_STORAGE_KEY(platform)]: value })
  }

  // ── Streaming message listener ────────────────────────────────────────
  useEffect(() => {
    const CHAT_TYPES = new Set(['CHAT_STREAM', 'CHAT_THINKING', 'CHAT_TOOLS', 'CHAT_TOOL_DONE', 'CHAT_TOOL_STREAM', 'CHAT_DONE', 'CHAT_ERROR', 'CHAT_CONTINUING', 'CHAT_QUESTION', 'CHAT_AGENT_SPAWN', 'CHAT_AGENT_STREAM', 'CHAT_AGENT_DONE'])
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
      } else if (msg.type === 'CHAT_THINKING') {
        const step = msg.step as ThinkingStep | undefined
        if (step && (step.title || step.thought)) {
          setMessages(prev => {
            const next = [...prev]
            const idx = currentAssistantIdx.current
            if (idx >= 0 && idx < next.length) {
              const existing = next[idx]
              const steps = [...(existing.thinking || [])]
              const last = steps[steps.length - 1]
              // Qwen re-emits an accumulating summary; replace the last step when
              // its title matches (a growing thought), else append a new step.
              if (last && last.title === step.title) steps[steps.length - 1] = step
              else steps.push(step)
              next[idx] = { ...existing, thinking: steps }
            }
            return next
          })
        }
      } else if (msg.type === 'CHAT_TOOLS') {
        // Tools detected — text streaming is done for this message, stop cursor
        setMessages(prev => {
          const next = [...prev]
          const idx = currentAssistantIdx.current
          if (idx >= 0 && idx < next.length) {
            const existing = next[idx]
            next[idx] = {
              ...existing,
              streaming: false,
              toolCalls: [...(existing.toolCalls || []), ...(msg.tools || [])],
            }
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
      } else if (msg.type === 'CHAT_CONTINUING') {
        // Tool execution done, AI is continuing — create a fresh assistant message
        const now = Date.now()
        setMessages(prev => {
          const newMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, ts: now }
          const next = [...prev, newMsg]
          currentAssistantIdx.current = next.length - 1
          return next
        })
      } else if (msg.type === 'CHAT_QUESTION') {
        // Question tool needs user interaction — show UI
        setPendingQuestion({
          callId: msg.call_id,
          question: msg.question || '',
          options: Array.isArray(msg.options) ? msg.options.map(String) : [],
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
        batchExpected.current.set(msg.batchId, (batchExpected.current.get(msg.batchId) || 0) + 1)
        setSubAgents(prev => [...prev, { id: msg.agentId, label: msg.label, task: msg.task, status: 'running', messages: [], batchId: msg.batchId }])
      } else if (msg.type === 'CHAT_AGENT_STREAM') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId
          ? { ...a, messages: appendAgentChunk(a.messages, msg.chunk || '') }
          : a))
      } else if (msg.type === 'CHAT_AGENT_DONE') {
        const agentId = msg.agentId
        const isErr = msg.status === 'error'
        setSubAgents(prev => prev.map(a => a.id === agentId ? { ...a, status: isErr ? 'error' : 'done' } : a))
        // done (not error) cards fade out then get removed; errors stay for review.
        if (!isErr) {
          const fadeAt = window.setTimeout(() => {
            setSubAgents(prev => prev.map(a => a.id === agentId ? { ...a, fading: true } : a))
            const rmAt = window.setTimeout(() => {
              setSubAgents(prev => prev.filter(a => a.id !== agentId))
              agentTimers.current.delete(rmAt)
            }, AGENT_FADE_DURATION_MS)
            agentTimers.current.add(rmAt)
            agentTimers.current.delete(fadeAt)
          }, AGENT_FADE_DELAY_MS)
          agentTimers.current.add(fadeAt)
        }
        // Accumulate the finished agent's FINAL snapshot per batch (independent of
        // the live array's fade removal), and emit ONE summary card when the batch
        // is complete. This survives a fast sibling already removed (Bug1) and never
        // commingles a prior batch's agents (Bug2). delete-on-emit = emit-once.
        setSubAgents(prev => {
          const live = prev.find(a => a.id === agentId)
          if (live) {
            // Snapshot with the just-applied terminal status before accumulating.
            const snap = { ...live, status: (isErr ? 'error' : 'done') as SubAgent['status'] }
            const summary = accumulateBatch(batchDone.current, batchExpected.current, snap)
            if (summary) {
              setMessages(m => [...m, { role: 'assistant', content: '', agentSummary: summary, ts: Date.now() }])
            }
          }
          return prev
        })
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

  // ── Cmd/Ctrl+K → command palette ─────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
          item => fuzzyMatch(`${item.label} ${item.sub || ''}`, match.query)))
        return
      }
      const auth = await getAuth()
      if (!auth) return
      try {
        const res = await bgFetch(`${auth.apiUrl}/skills`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
        const data = res.json()
        const skills: PickerItem[] = (data.skills || [])
          .filter((s: any) => !s.name?.startsWith('piercode-'))
          .map((s: any) => ({ label: s.name, sub: s.description, value: s.name }))
        skillsCacheRef.current = { ts: now, items: skills }
        setPickerItems(skills.filter(item => fuzzyMatch(`${item.label} ${item.sub || ''}`, match.query)))
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
      const data = res.json()
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
        const data = res.json()
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

  // Fetch the init/system prompt once (cached). Empty string if unavailable.
  const fetchInitPrompt = useCallback(async (): Promise<string> => {
    if (initPromptCacheRef.current !== null) return initPromptCacheRef.current
    const auth = await getAuth()
    if (!auth) return ''
    try {
      const res = await bgFetch(`${auth.apiUrl}/prompt`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      initPromptCacheRef.current = res.text || ''
    } catch {
      initPromptCacheRef.current = ''
    }
    return initPromptCacheRef.current
  }, [])

  // ── Send ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
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

    // First message of a fresh conversation: auto-inject the init/system prompt.
    // The system prompt is NOT shown as a chat bubble; chat-api routes it into a
    // real system field (openai/claude) or prepends it to this message (qwen/chatgpt).
    const isFirstTurn = chatIdRef.current === null && messages.length === 0
    const systemPrompt = isFirstTurn ? await fetchInitPrompt() : undefined

    chrome.runtime.sendMessage({
      type: 'CHAT_REQUEST',
      platform,
      model,
      reasoning,
      chatId: chatIdRef.current,
      parentId: lastResponseIdRef.current,
      message: text,
      systemPrompt: systemPrompt || undefined,
    })
  }, [input, messages, platform, model, reasoning, streaming, fetchInitPrompt])

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

  const handleRegenerate = useCallback(() => {
    // Find the last user message and re-send it
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUserMsg || streaming) return

    // Remove the last assistant message
    setMessages(prev => {
      const next = [...prev]
      if (next.length > 0 && next[next.length - 1].role === 'assistant') {
        next.pop()
      }
      return next
    })

    setError('')
    const now = Date.now()
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, ts: now }
    setMessages(prev => {
      const next = [...prev, assistantMsg]
      currentAssistantIdx.current = next.length - 1  // assistant is at the end
      return next
    })
    setStreaming(true)

    chrome.runtime.sendMessage({
      type: 'CHAT_REQUEST',
      platform,
      model,
      reasoning,
      chatId: chatIdRef.current,
      parentId: null,  // reset parent for regenerate
      message: lastUserMsg.content,
    })
  }, [messages, platform, model, reasoning, streaming])

  const togglePin = useCallback((idx: number) => {
    setMessages(prev => prev.map((m, i) => i === idx ? { ...m, pinned: !m.pinned } : m))
  }, [])

  const jumpToAgent = useCallback((id: string) => {
    document.getElementById(`agent-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleQuestionAnswer = useCallback((answer: string) => {
    if (!pendingQuestion) return
    chrome.runtime.sendMessage({
      type: 'CHAT_QUESTION_ANSWER',
      call_id: pendingQuestion.callId,
      answer,
    })
    setPendingQuestion(null)
  }, [pendingQuestion])

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

  // ── Palette command list ───────────────────────────────────────────────
  const paletteCommands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'new', title: '新对话', hint: 'new', run: () => startNewSession() },
      { id: 'clear', title: '清空当前消息', hint: 'clear', run: () => {
      setMessages([])
      chatIdRef.current = null
      lastResponseIdRef.current = null
      currentAssistantIdx.current = -1
    } },
    ]
    for (const p of PLATFORMS) {
      list.push({ id: `plat-${p.key}`, title: `切换到 ${p.label}`, hint: 'platform', run: () => setPlatform(p.key) })
    }
    for (const s of sessions) {
      if (s.id === sessionIdRef.current) continue
      list.push({ id: `sess-${s.id}`, title: `会话: ${s.title || '新对话'}`, hint: 'switch', run: () => switchSession(s.id) })
    }
    return list
  }, [sessions, startNewSession, switchSession])

  // ── Palette search callbacks ───────────────────────────────────────────
  const searchMessages = useCallback((q: string): SearchHit[] => {
    const query = q.trim().toLowerCase()
    if (!query) return []
    const hits: SearchHit[] = []
    messages.forEach((m, index) => {
      if (m.content.toLowerCase().includes(query)) {
        const at = m.content.toLowerCase().indexOf(query)
        hits.push({ index, preview: m.content.slice(Math.max(0, at - 12), at + 40).replace(/\n/g, ' ') })
      }
    })
    return hits
  }, [messages])

  const scrollToMessage = useCallback((index: number) => {
    const el = listRef.current?.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.animate([{ background: 'var(--glow-soft)' }, { background: 'transparent' }], { duration: 1200 })
  }, [])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen crt-scanlines crt-grain" style={{ background: 'var(--bg)', color: 'var(--txt)' }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="boot boot-1 flex items-center justify-between px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="glow-text">⌁</span>
          <span className="text-sm font-medium glow-text">PIERCODE</span>
          <span className="text-[11px] truncate" style={{ color: 'var(--dim)' }}>
            //{sessions.find(s => s.id === sessionIdRef.current)?.title || 'new'}
          </span>
        </div>
        <div className="flex items-center gap-2 relative">
          {sessions.length > 0 && (
            <select
              value={sessionIdRef.current}
              onChange={e => switchSession(e.target.value)}
              className="rounded-sm px-1 py-0.5 text-[10px] outline-none max-w-[110px] border"
              style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }}
              title="切换会话"
            >
              {sessions.map(s => <option key={s.id} value={s.id}>{s.title || '新对话'}</option>)}
            </select>
          )}
          <button onClick={startNewSession} className="text-[12px] cursor-pointer" style={{ color: 'var(--dim)' }} title="新对话">＋</button>
          {/* glow picker */}
          <button onClick={() => setGlowMenuOpen(o => !o)} className="w-3 h-3 rounded-full border" style={{ background: 'var(--glow)', borderColor: 'var(--line)' }} title="主题色" />
          {glowMenuOpen && (
            <div className="absolute right-0 top-6 z-[55] rounded-sm border p-1 flex gap-1" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
              {GLOW_COLORS.map(g => (
                <button key={g.key} onClick={() => { setGlow(g.key); setGlowMenuOpen(false) }}
                  className={`w-4 h-4 rounded-full border ${glow === g.key ? 'glow-border' : ''}`}
                  style={{ background: g.hex, borderColor: 'var(--line)' }} title={g.label} />
              ))}
            </div>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'dot-live' : ''}`} style={{ background: connected ? undefined : '#7a2a2a' }} />
          <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{connected ? 'live' : 'off'}</span>
          {messages.length > 0 && (
            <button onClick={removeCurrentSession} className="text-[11px] cursor-pointer" style={{ color: 'var(--dim)' }} title="删除当前对话">✕</button>
          )}
        </div>
      </div>

      {/* ── Platform rail ───────────────────────────────────────────────────── */}
      <div className="boot boot-2 flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 overflow-x-auto text-xs" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
        {PLATFORMS.map(p => {
          const on = platform === p.key
          return (
            <button
              key={p.key}
              onClick={() => setPlatform(p.key)}
              className={`whitespace-nowrap cursor-pointer pb-0.5 border-b-2 ${on ? 'glow-text' : ''}`}
              style={{ borderColor: on ? 'var(--glow)' : 'transparent', color: on ? undefined : 'var(--dim)' }}
            >
              {on ? '> ' : ''}{p.label.toLowerCase()}
            </button>
          )
        })}
        {models.length > 0 ? (
          <select
            value={model}
            onChange={e => handleModelChange(e.target.value)}
            className="ml-auto w-40 rounded-sm px-1 py-0.5 text-[11px] outline-none border"
            style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }}
          >
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <input
            value={model}
            onChange={e => handleModelChange(e.target.value)}
            className="w-36 rounded-sm px-2 py-0.5 text-[11px] outline-none border ml-auto"
            style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }}
            placeholder="model"
          />
        )}
        {/* Thinking level — options vary per platform (sidebar/reasoning.ts) */}
        {levelsForPlatform(platform).length > 0 && (
          <select
            value={reasoning}
            onChange={e => handleReasoningChange(e.target.value)}
            title="思考程度"
            className={`${models.length > 0 ? '' : 'ml-1'} w-20 rounded-sm px-1 py-0.5 text-[11px] outline-none border`}
            style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }}
          >
            {levelsForPlatform(platform).map(l => (
              <option key={l.key} value={l.key}>{`🧠 ${l.label}`}</option>
            ))}
          </select>
        )}
      </div>

      {/* ── Worker radar ────────────────────────────────────────────────────── */}
      <WorkerRadar agents={subAgents} onJump={jumpToAgent} />

      {/* ── Pinned region ───────────────────────────────────────────────────── */}
      {messages.some(m => m.pinned) && (
        <div className="flex-shrink-0 px-3 py-1 border-b text-[11px] space-y-0.5 max-h-24 overflow-y-auto chat-scroll" style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
          {messages.map((m, i) => m.pinned ? (
            <button key={i} onClick={() => scrollToMessage(i)} className="block w-full text-left truncate cursor-pointer" style={{ color: 'var(--dim)' }}>
              <span className="glow-text">★</span> {m.content.slice(0, 50).replace(/\n/g, ' ')}
            </button>
          ) : null)}
        </div>
      )}

      {/* ── Messages ────────────────────────────────────────────────────────── */}
      <div ref={listRef} className="boot boot-3 flex-1 overflow-y-auto chat-scroll py-2 space-y-1">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-xs gap-3 px-4" style={{ color: 'var(--dim)' }}>
            <pre className="glow-text text-[10px] leading-tight select-none">{`  ___ _           ___         _
 | _ (_)___ _ _ / __|___  __| |___
 |  _/ / -_) '_| (__/ _ \\/ _\` / -_)
 |_| |_\\___|_|  \\___\\___/\\__,_\\___|`}</pre>
            <span>选择平台，输入命令开始</span>
            <div className="text-center space-y-1 max-w-[260px] text-[11px]">
              <p>⌁ 首条消息自动注入系统提示词</p>
              <p>/skills · @文件 · @@子agent</p>
              <p>Cmd/Ctrl+K 打开指令面板</p>
              <p className="text-[10px] mt-2">Enter 发送 · Shift+Enter 换行</p>
            </div>
            {!connected && (
              <div className="mt-2 text-[10px] text-amber-500 text-center">
                ⚠ 未连接 PierCode 服务<br/>请在扩展弹窗配置 Token
              </div>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageView
            key={i}
            msg={msg}
            onRegenerate={i === messages.length - 1 && msg.role === 'assistant' && !msg.streaming ? handleRegenerate : undefined}
            onTogglePin={() => togglePin(i)}
          />
        ))}
      </div>

      {/* ── Sub-agents ──────────────────────────────────────────────────────── */}
      {subAgents.length > 0 && (
        <div className="px-3 py-1.5 border-t flex-shrink-0 space-y-1 max-h-40 overflow-y-auto chat-scroll" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          {subAgents.map(a => (
            <div key={a.id} id={`agent-${a.id}`}>
              <SubAgentCard agent={a} />
            </div>
          ))}
        </div>
      )}

      {/* ── Question card (user interaction) ─────────────────────────────────── */}
      {pendingQuestion && (
        <div className="flex-shrink-0 px-3 py-1 border-t" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          <QuestionCard
            question={pendingQuestion.question}
            options={pendingQuestion.options}
            onAnswer={handleQuestionAnswer}
          />
        </div>
      )}

      {/* ── Error bar ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="px-3 py-1.5 border-t text-xs text-red-300 flex items-center gap-2 flex-shrink-0" style={{ borderColor: 'var(--line)', background: 'rgba(120,20,20,.2)' }}>
          <span>⚠</span>
          <span className="flex-1 truncate">{error}</span>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-200 cursor-pointer flex-shrink-0">✕</button>
        </div>
      )}

      {/* ── Token panel ─────────────────────────────────────────────────────── */}
      <TokenPanel meter={meter} threshold={tokenThreshold} platform={platform} />

      {/* ── Input ───────────────────────────────────────────────────────────── */}
      <div className="boot boot-4 flex-shrink-0 border-t p-2 relative" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
        {/* Picker popup */}
        {pickerItems.length > 0 && (
          <Picker
            items={pickerItems}
            onSelect={handlePickerSelect}
            onClose={handlePickerClose}
          />
        )}
        <div className="flex gap-2 items-end">
          <span className="glow-text pb-2 select-none">▌</span>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={connected ? 'type command…  / @ 技能文件' : '请先连接 PierCode 服务'}
            rows={1}
            className="flex-1 rounded-sm px-2 py-2 text-sm outline-none resize-none overflow-hidden border"
            style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)', maxHeight: '120px' }}
          />
          {streaming ? (
            <button onClick={handleCancel} className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 text-red-300 border border-red-800/50" title="停止生成">■</button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || !connected} className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 glow-border disabled:opacity-40 disabled:cursor-not-allowed" style={{ color: 'var(--glow)' }} title="发送 (Enter)">⏎</button>
          )}
        </div>
      </div>

      {/* ── Status HUD ──────────────────────────────────────────────────────── */}
      <StatusHUD
        connected={connected}
        meter={meter}
        platform={platform}
        threshold={tokenThreshold || 200_000}
        activeAgents={subAgents.filter(a => a.status === 'running').length}
      />

      {/* ── Command palette (Cmd+K) ──────────────────────────────────────────── */}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
          onSearch={searchMessages}
          onPickSearch={scrollToMessage}
        />
      )}
    </div>
  )
}
