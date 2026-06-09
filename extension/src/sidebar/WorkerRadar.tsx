import type { ChatMessage } from './MessageView'

export interface SubAgent {
  id: string
  label: string
  task: string
  status: 'running' | 'done' | 'error'
  messages: ChatMessage[]
  fading?: boolean
}

const STATUS_MARK: Record<SubAgent['status'], { mark: string; cls: string }> = {
  running: { mark: '▸▸', cls: 'text-amber-400' },
  done: { mark: '✓', cls: 'glow-text' },
  error: { mark: '✗', cls: 'text-red-400' },
}

export default function WorkerRadar({ agents, onJump }: {
  agents: SubAgent[]
  onJump: (id: string) => void
}) {
  if (agents.length === 0) return null
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-b overflow-x-auto flex-shrink-0 text-[11px]"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
      <span className="select-none" style={{ color: 'var(--dim)' }}>radar:</span>
      {agents.map(a => {
        const s = STATUS_MARK[a.status]
        return (
          <button key={a.id} onClick={() => onJump(a.id)}
            title={a.task}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm whitespace-nowrap cursor-pointer border"
            style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
            <span className="glow-text">@{a.label}</span>
            <span className={`${s.cls} ${a.status === 'running' ? 'animate-pulse-dot' : ''}`}>{s.mark}</span>
          </button>
        )
      })}
    </div>
  )
}
