// agent-store: the pure model behind the Hub dashboard. It holds the roster of
// dispatched worker agents and derives stats / ordering for the sidebar. Free of
// DOM / chrome / React so it is unit-testable. Two inputs flow in: full snapshots
// from GET /agents polling and incremental pushes from the WS `agents_update`
// message — both go through mergeSummaries, keyed by agent_id, last-writer-wins.

// AgentVM mirrors the server's AgentSummary (internal/tool/agent_registry.go).
// snake_case fields match the JSON wire format verbatim so summaries drop in
// without remapping.
export interface AgentVM {
  agent_id: string;
  dispatcher_client_id?: string;
  dispatcher_conversation_url?: string;
  worker_client_id?: string;
  platform?: string;
  description?: string;
  status: string;
  created_at: string;
  bound_at?: string;
  ended_at?: string;
  seeded?: boolean;
  last_debug?: string;
  last_debug_at?: string;
  last_ai_response?: string;
  last_ai_response_at?: string;
}

export type AgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'stopped';

export interface AgentStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  stopped: number;
}

// mergeSummaries folds an incoming batch (full poll or incremental push) into the
// previous roster, keyed by agent_id. The incoming record wins, so a fresher
// status/last-response replaces the stale one. Agents only present in `prev`
// (e.g. a push that carried just one agent) are retained — a push must never drop
// agents the poll knows about. Returns a new array; does not mutate `prev`.
export function mergeSummaries(prev: AgentVM[], incoming: AgentVM[]): AgentVM[] {
  const byId = new Map<string, AgentVM>();
  for (const a of prev) byId.set(a.agent_id, a);
  for (const a of incoming) {
    if (!a || !a.agent_id) continue;
    byId.set(a.agent_id, a);
  }
  return Array.from(byId.values());
}

// replaceAll treats the batch as the authoritative full set (GET /agents). Unlike
// mergeSummaries it drops agents not in the batch, so the dashboard reflects the
// server's current roster exactly. Used for the poll; pushes use mergeSummaries.
export function replaceAll(incoming: AgentVM[]): AgentVM[] {
  const byId = new Map<string, AgentVM>();
  for (const a of incoming) {
    if (!a || !a.agent_id) continue;
    byId.set(a.agent_id, a);
  }
  return Array.from(byId.values());
}

const ACTIVE_STATUSES = new Set<string>(['running', 'pending']);

// sortAgents orders active agents (running/pending) first, then by created_at
// descending (newest first) within each group, so in-flight work sits at the top.
export function sortAgents(vms: AgentVM[]): AgentVM[] {
  return vms.slice().sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    // created_at is RFC3339; lexicographic compare is chronological. Reverse for
    // newest-first.
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

export function computeStats(vms: AgentVM[]): AgentStats {
  const stats: AgentStats = {
    total: vms.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    stopped: 0,
  };
  for (const a of vms) {
    switch (a.status) {
      case 'pending': stats.pending++; break;
      case 'running': stats.running++; break;
      case 'completed': stats.completed++; break;
      case 'failed': stats.failed++; break;
      case 'blocked': stats.blocked++; break;
      case 'stopped': stats.stopped++; break;
    }
  }
  return stats;
}
