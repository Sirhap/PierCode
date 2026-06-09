import type { SubAgent } from './WorkerRadar'

export interface AgentSummaryItem {
  label: string
  status: 'done' | 'error'
  summary: string
  output: string
}

// truncateSummary returns the first non-empty trimmed line, capped at 60 chars.
// Mirrors chat-api's firstLine so card summary matches the broadcast summary.
export function truncateSummary(text: string): string {
  const line = (text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return line.length > 60 ? line.slice(0, 59) + '…' : line
}

// buildAgentSummary maps a batch of terminal sub-agents into summary-card items.
// output = concatenated transcript; summary = its first line.
export function buildAgentSummary(agents: SubAgent[]): AgentSummaryItem[] {
  return agents.map(a => {
    const output = a.messages.map(m => m.content).join('')
    return {
      label: a.label,
      status: a.status === 'error' ? 'error' : 'done',
      summary: truncateSummary(output),
      output,
    }
  })
}

// Delay (ms) before a done sub-agent card fades out and is removed.
export const AGENT_FADE_DELAY_MS = 2500
// Fade-out animation duration (ms) — must match index.css .agent-fading.
export const AGENT_FADE_DURATION_MS = 400
