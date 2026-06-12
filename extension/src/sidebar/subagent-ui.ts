import type { ChatMessage } from './MessageView'
import { extractFenceToolCalls } from '../parser'

export interface SubAgent {
  id: string
  label: string
  task: string
  status: 'running' | 'done' | 'error'
  messages: ChatMessage[]
  fading?: boolean
  batchId?: string
}

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

// ── Tool-call tree (AgentDock) ──────────────────────────────────────────────

export interface AgentToolCall {
  name: string
  /** Short human preview of the call's most telling argument. */
  preview: string
}

// summarizeToolArgs picks the most telling argument for a one-line preview:
// path/command-like keys first, then the first short string value.
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const PREFERRED = ['path', 'file_path', 'cmd', 'command', 'pattern', 'url', 'task', 'label', 'query']
  for (const key of PREFERRED) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return clip(v.trim())
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return clip(v.trim())
  }
  return ''
}

function clip(s: string): string {
  const line = s.split('\n')[0]
  return line.length > 40 ? line.slice(0, 39) + '…' : line
}

// parseAgentToolCalls extracts the tool calls a sub-agent emitted, in order,
// from its accumulated streamed transcript. Drives the AgentDock "current tool"
// preview (last entry while running) and the expanded call tree. Incomplete
// fences (still streaming) simply parse to nothing yet.
export function parseAgentToolCalls(transcript: string): AgentToolCall[] {
  return extractFenceToolCalls(transcript).map(tc => ({
    name: tc.name,
    preview: summarizeToolArgs(tc.args),
  }))
}

// agentTranscript concatenates a sub-agent's streamed assistant text.
export function agentTranscript(agent: SubAgent): string {
  return agent.messages.map(m => m.content).join('')
}

// Delay (ms) before a done sub-agent card fades out and is removed.
export const AGENT_FADE_DELAY_MS = 2500
// Fade-out animation duration (ms) — must match index.css .agent-fading.
export const AGENT_FADE_DURATION_MS = 400

// accumulateBatch records one finished sub-agent's final snapshot into a per-batch
// accumulator and decides whether the batch is now complete. It is the pure core
// of the summary-card emit logic in App.tsx: snapshotting at finish time (not from
// the churning live array) is what survives a fast sibling already faded out (Bug1),
// and keying by batchId is what keeps a prior batch's agents from commingling (Bug2).
//
// Mutates `done`/`expected` in place (they are the component's persistent maps) and,
// on completion, deletes the batch's entries so a late/duplicate DONE cannot re-emit
// (delete-on-emit = emit-once). Returns the summary items to emit, or null if the
// batch is not yet complete. Duplicate DONE for an already-recorded agent is ignored.
export function accumulateBatch(
  done: Map<string, SubAgent[]>,
  expected: Map<string, number>,
  finished: SubAgent,
): AgentSummaryItem[] | null {
  const bId = finished.batchId || ''
  const acc = done.get(bId) || []
  if (!acc.some(a => a.id === finished.id)) acc.push(finished)
  done.set(bId, acc)
  const want = expected.get(bId) || acc.length
  if (acc.length < want) return null
  const summary = buildAgentSummary(acc)
  done.delete(bId)
  expected.delete(bId)
  return summary
}
