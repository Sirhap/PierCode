import { useState } from 'react'
import ToolCard, { type ToolCall, type ToolResult } from './ToolCard'
import type { AgentSummaryItem } from './subagent-ui'

export type { ToolCall, ToolResult }

export interface ThinkingStep { title: string; thought: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  toolStreams?: Record<string, string[]>
  thinking?: ThinkingStep[]
  streaming?: boolean
  ts?: number
  pinned?: boolean
  agentSummary?: AgentSummaryItem[]
}

export function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  })
}

const TOOL_FENCE_RE = /```piercode-tool\s*\n[\s\S]*?\n```/gi
// A piercode-tool fence still streaming in — opening fence present, closing ```
// not yet arrived. Matches from the opener to end-of-string so the raw JSON
// never flashes as plain text before CHAT_TOOLS lands.
const TOOL_FENCE_OPEN_RE = /```piercode-tool[\s\S]*$/i

export function stripToolBlocks(text: string): string {
  return text
    .replace(TOOL_FENCE_RE, '')      // completed fences
    .replace(TOOL_FENCE_OPEN_RE, '') // a trailing unclosed fence (mid-stream)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Best-effort parse of tool calls out of the (possibly still-streaming) message
// text, so a placeholder ToolCard can render the instant a fence appears —
// before the background's CHAT_TOOLS (which only fires after the full SSE
// stream). Returns [] when nothing parses yet; the real toolCalls from
// CHAT_TOOLS supersede these once they arrive.
export function parsePartialToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = []
  // Closed fences first (complete JSON).
  const bodies: string[] = []
  for (const m of text.matchAll(/```piercode-tool\s*\n([\s\S]*?)\n```/gi)) {
    bodies.push(m[1])
  }
  // A trailing unclosed fence — try to parse whatever JSON has streamed in.
  const openIdx = text.search(/```piercode-tool/i)
  if (openIdx >= 0) {
    const tail = text.slice(openIdx)
    if (!/\n```/.test(tail)) {
      const nl = tail.indexOf('\n')
      if (nl >= 0) bodies.push(tail.slice(nl + 1))
    }
  }
  for (const body of bodies) {
    const parsed = parseLenientToolJSON(body)
    if (parsed) out.push(parsed)
  }
  return out
}

function parseLenientToolJSON(body: string): ToolCall | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  // Find the first balanced-looking JSON object; tolerate a truncated tail by
  // trying progressively shorter prefixes ending at a closing brace.
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  for (let end = trimmed.lastIndexOf('}'); end > start; end = trimmed.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1))
      if (obj && typeof obj.name === 'string') {
        return {
          name: obj.name,
          call_id: typeof obj.call_id === 'string' ? obj.call_id : '',
          args: (obj.args && typeof obj.args === 'object') ? obj.args : {},
        }
      }
    } catch { /* keep shrinking */ }
  }
  return null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function safeMarkdownHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return trimmed
  } catch {
    return null
  }
  return null
}

export function renderMarkdown(text: string): string {
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
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safeHref = safeMarkdownHref(href)
    return safeHref
      ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener">${label}</a>`
      : `${label} (${href})`
  })
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

function ThinkingBlock({ steps, streaming }: { steps: ThinkingStep[]; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const last = steps[steps.length - 1]
  return (
    <div className="mb-1.5 text-[11px]">
      <div
        className="flex items-center gap-1.5 cursor-pointer select-none"
        style={{ color: 'var(--dim)' }}
        onClick={() => setOpen(o => !o)}
      >
        <span>✻</span>
        <span className="italic truncate flex-1">{open ? '思考中…' : (last.title || '思考中…')}</span>
        {streaming && <span className="animate-pulse-dot">·</span>}
        <span style={{ color: 'var(--dim)' }}>{open ? '▾' : `${steps.length} 步 ▸`}</span>
      </div>
      {open && (
        <div className="mt-1 pl-4 border-l space-y-1.5" style={{ borderColor: 'var(--line)' }}>
          {steps.map((s, i) => (
            <div key={i}>
              {s.title && <div style={{ color: 'var(--dim)' }}>{s.title}</div>}
              {s.thought && <div className="whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--dim)' }}>{s.thought}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionBtn({ icon, title, onClick, active }: { icon: string; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-1 rounded-sm text-[11px] cursor-pointer cc-action-btn"
      style={{ color: active ? 'var(--glow)' : 'var(--dim)' }}
    >
      {icon}
    </button>
  )
}

function AgentSummaryRow({ item }: { item: AgentSummaryItem }) {
  const [open, setOpen] = useState(false)
  const mark = item.status === 'error' ? '✗' : '✓'
  const markColor = item.status === 'error' ? 'var(--red, #e06c75)' : 'var(--glow)'
  return (
    <div className="cc-result-row text-[11px]">
      <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿  </span>
      <div className="flex-1 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--glow)' }}>@{item.label}</span>{' '}
        <span style={{ color: markColor }}>{mark}</span>{' '}
        <span style={{ color: 'var(--dim)' }}>{item.summary || '(无输出)'}</span>
        {open && (
          <pre className="whitespace-pre-wrap break-all mt-1" style={{ color: 'var(--txt)', lineHeight: 1.35, margin: 0 }}>
            {item.output || '(无输出)'}
          </pre>
        )}
      </div>
    </div>
  )
}

export default function MessageView({ msg, onRegenerate, onTogglePin }: {
  msg: ChatMessage
  onRegenerate?: () => void
  onTogglePin?: () => void
}) {
  const isUser = msg.role === 'user'
  const isTool = msg.role === 'tool_result'
  // Hooks must run unconditionally on every render (Rules of Hooks) — declare the
  // tool_result expand state before any early return, even for non-tool messages.
  const [expanded, setExpanded] = useState(false)

  // tool_result: dim tree row ⎿ content
  if (isTool) {
    const preview = msg.content.slice(0, 500)
    const needsExpand = msg.content.length > 500
    return (
      <div className="msg-row px-4 py-0.5">
        <div
          className="cc-result-row text-[11px] cursor-pointer select-none"
          style={{ color: 'var(--dim)' }}
          onClick={() => needsExpand && setExpanded(e => !e)}
        >
          <span className="cc-corner">⎿  </span>
          <span>
            {expanded ? msg.content : preview}
            {needsExpand && !expanded ? '…' : ''}
          </span>
        </div>
      </div>
    )
  }

  if (msg.agentSummary && msg.agentSummary.length > 0) {
    return (
      <div className="msg-row px-4 py-2">
        <div className="cc-tool text-[12px]">
          <div className="flex items-baseline gap-1">
            <span style={{ color: 'var(--dim)', fontSize: '0.85em', lineHeight: 1 }}>⏺</span>
            <span className="font-medium" style={{ color: 'var(--txt)' }}>spawn_agent</span>
            <span style={{ color: 'var(--dim)' }}>×{msg.agentSummary.length}</span>
          </div>
          <div className="cc-result-tree">
            {msg.agentSummary.map((it, i) => <AgentSummaryRow key={i} item={it} />)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg-row px-4 py-2">
      <div className="relative group w-full">
        {isUser ? (
          /* User message: dim > prefix, plain left-aligned text */
          <div className="flex items-baseline gap-1.5 text-sm leading-relaxed">
            <span className="select-none shrink-0" style={{ color: 'var(--dim)', fontSize: '0.85em' }}>{'>'}</span>
            <div style={{ color: 'var(--txt)' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
          </div>
        ) : (
          /* Assistant message: thinking → tool cards → markdown content, no prefix, flowing */
          (() => {
            // Real tool calls (from CHAT_TOOLS, post-stream) take precedence;
            // while streaming, parse partial fences so a placeholder card shows
            // the instant a ```piercode-tool fence appears.
            const toolCards = msg.toolCalls?.length
              ? msg.toolCalls
              : (msg.streaming ? parsePartialToolCalls(msg.content) : [])
            // Always strip tool fences from the visible text so raw JSON never
            // flashes (covers both closed and still-streaming fences).
            const displayText = stripToolBlocks(msg.content)
            const hasCards = toolCards.length > 0
            // Hide the blinking cursor while tool cards are the active surface and
            // no continuation text is streaming — the card's own ⏺ shows progress.
            const showCursor = msg.streaming && !(hasCards && !displayText)
            return (
              <div className="text-sm leading-relaxed" style={{ color: 'var(--txt)' }}>
                {msg.thinking && msg.thinking.length > 0 && (
                  <ThinkingBlock steps={msg.thinking} streaming={msg.streaming && !msg.content} />
                )}
                {toolCards.map((tc, i) => (
                  <ToolCard key={tc.call_id || i} tool={tc}
                    result={msg.toolResults?.find(r => r.call_id === tc.call_id)}
                    streams={tc.call_id ? msg.toolStreams?.[tc.call_id] : undefined} />
                ))}
                {displayText && (
                  <div
                    className={`msg-content${hasCards ? ' mt-2' : ''}`}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(displayText) }}
                  />
                )}
                {showCursor && (
                  <span className="animate-pulse-dot ml-0.5" style={{ color: 'var(--dim)' }}>▍</span>
                )}
              </div>
            )
          })()
        )}

        {/* Footer: timestamp + action buttons */}
        <div className={`flex items-center gap-1 mt-1 ${isUser ? 'justify-end' : ''}`}>
          {msg.ts && (
            <span className="text-[10px] mr-1" style={{ color: 'var(--dim)' }}>{formatTime(msg.ts)}</span>
          )}
          <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
            {msg.content && !msg.streaming && (
              <ActionBtn icon="copy" title="复制" onClick={() => copyToClipboard(msg.content)} />
            )}
            {onTogglePin && !msg.streaming && (
              <ActionBtn icon={msg.pinned ? '★ unpin' : '☆ pin'} title="置顶" active={msg.pinned} onClick={onTogglePin} />
            )}
            {!isUser && !msg.streaming && onRegenerate && (
              <ActionBtn icon="regen" title="重新生成" onClick={onRegenerate} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
