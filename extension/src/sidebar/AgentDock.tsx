import { useState } from 'react'
import {
  type SubAgent,
  type AgentToolCall,
  parseAgentToolCalls,
  agentTranscript,
  truncateSummary,
} from './subagent-ui'

// AgentDock — 右上角子 agent 浮标 + 抽屉。
//
// 折叠态：右上角小浮标（▸▸ N agents 运行中），有活跃 agent 时显示。
// 展开态：浮标下方抽屉，每个 agent 一行：运行中显示当前工具调用预览（脉冲 ●），
// 完成显示「完成 · N 工具调用」，错误显示错误摘要。点行展开该 agent 的完整
// 工具调用树（Claude Code 风格 ⏺/⎿）。运行中的行带 ✕ 单独取消。
//
// 数据全部来自 CHAT_AGENT_SPAWN/STREAM/DONE 驱动的 agents 数组；工具调用树由
// parseAgentToolCalls 从累计 transcript 即时解析（流中的未闭合 fence 解析为空）。

const STATUS_MARK: Record<SubAgent['status'], { mark: string; cls: string }> = {
  running: { mark: '▸▸', cls: 'text-amber-400' },
  done: { mark: '✓', cls: 'glow-text' },
  error: { mark: '✗', cls: 'text-red-400' },
}

function statusLine(agent: SubAgent, calls: AgentToolCall[]): string {
  if (agent.status === 'running') {
    const cur = calls[calls.length - 1]
    return cur ? `${cur.name} ${cur.preview}`.trim() : agent.task.slice(0, 40)
  }
  if (agent.status === 'error') {
    return agent.error || truncateSummary(agentTranscript(agent)) || '失败'
  }
  return `完成 · ${calls.length} 工具调用`
}

function AgentRow({ agent, expanded, onToggle, onAbort }: {
  agent: SubAgent
  expanded: boolean
  onToggle: () => void
  onAbort: (id: string) => void
}) {
  const s = STATUS_MARK[agent.status]
  const calls = parseAgentToolCalls(agentTranscript(agent))
  const abort = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onAbort(agent.id)
  }
  return (
    <div className={`border-b last:border-b-0${agent.fading ? ' agent-fading' : ''}`} style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer" onClick={onToggle} title={agent.task}>
        <span className={`${s.cls} ${agent.status === 'running' ? 'animate-pulse-dot' : ''} flex-shrink-0`}>{s.mark}</span>
        <span className="glow-text flex-shrink-0">@{agent.label}</span>
        <span className="truncate flex-1 flex items-center gap-1" style={{ color: 'var(--dim)' }}>
          {agent.status === 'running' && <span className="flex-shrink-0" style={{ color: 'var(--dim)' }}>⎿</span>}
          <span className="truncate">{statusLine(agent, calls)}</span>
          {agent.status === 'running' && <span className="animate-pulse-dot text-amber-400 flex-shrink-0">●</span>}
        </span>
        {agent.status === 'running' && (
          <button onClick={abort} title="停止此子 agent" className="px-1 cursor-pointer flex-shrink-0" style={{ color: 'var(--dim)' }}>✕</button>
        )}
        <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--dim)' }}>{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="px-2 pb-2 space-y-0.5 max-h-48 overflow-y-auto chat-scroll">
          <div className="flex items-start gap-1">
            <span className={s.cls}>⏺</span>
            <span className="whitespace-pre-wrap break-all" style={{ color: 'var(--txt)' }}>{agent.task.slice(0, 120)}</span>
          </div>
          {calls.length === 0 && (
            <div className="pl-3" style={{ color: 'var(--dim)' }}>（暂无工具调用）</div>
          )}
          {calls.map((c, i) => (
            <div key={i} className="pl-3 flex items-start gap-1">
              <span style={{ color: 'var(--dim)' }}>⎿</span>
              <span className="glow-text flex-shrink-0">{c.name}</span>
              <span className="truncate" style={{ color: 'var(--dim)' }}>{c.preview}</span>
            </div>
          ))}
          {agent.status !== 'running' && (
            <div className="pl-3 flex items-start gap-1">
              <span style={{ color: 'var(--dim)' }}>⎿</span>
              <span className="whitespace-pre-wrap break-all" style={{ color: 'var(--dim)' }}>
                {truncateSummary(agentTranscript(agent)) || '(无输出)'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function AgentDock({ agents, onAbort }: {
  agents: SubAgent[]
  onAbort: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  if (agents.length === 0) return null

  const running = agents.filter(a => a.status === 'running').length
  const errored = agents.filter(a => a.status === 'error').length
  const badge = running > 0
    ? `▸▸ ${running} agent${running > 1 ? 's' : ''} 运行中`
    : errored > 0
      ? `✗ ${errored} agent${errored > 1 ? 's' : ''} 出错`
      : `✓ ${agents.length} agent${agents.length > 1 ? 's' : ''} 完成`

  return (
    <div className="absolute top-10 right-2 z-[60] text-[11px]" data-testid="agent-dock">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-1 rounded-sm border cursor-pointer shadow-lg"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        title="子 agent 状态"
      >
        <span className={running > 0 ? 'text-amber-400 animate-pulse-dot' : errored > 0 ? 'text-red-400' : 'glow-text'}>
          {badge}
        </span>
      </button>
      {open && (
        <div
          className="mt-1 w-72 max-h-80 overflow-y-auto chat-scroll rounded-sm border shadow-lg"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          {agents.map(a => (
            <AgentRow
              key={a.id}
              agent={a}
              expanded={expandedId === a.id}
              onToggle={() => setExpandedId(id => (id === a.id ? null : a.id))}
              onAbort={onAbort}
            />
          ))}
        </div>
      )}
    </div>
  )
}
