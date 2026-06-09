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
