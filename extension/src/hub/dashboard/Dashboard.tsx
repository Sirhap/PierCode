import { useState } from 'react';
import { AgentVM, AgentStats, computeStats, sortAgents } from './agent-store';

// Dashboard: the Hub's agent sidebar. Pure presentation — it renders from the
// agent roster passed in and raises intent (focus / stop / retry) via callbacks.
// No data fetching or WS here; App.tsx owns those and feeds `agents` down.

interface DashboardProps {
  agents: AgentVM[];
  connected: boolean;
  onFocusPane: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRetry: (agentId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  blocked: '阻塞',
  stopped: '已停止',
};

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="dash-stat" data-tone={tone}>
      <span className="dash-stat-value">{value}</span>
      <span className="dash-stat-label">{label}</span>
    </div>
  );
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

function AgentRow({
  agent,
  onFocusPane,
  onStop,
  onRetry,
}: {
  agent: AgentVM;
  onFocusPane: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = agent.status === 'running' || agent.status === 'pending';
  return (
    <div className="dash-agent" data-status={agent.status}>
      <div className="dash-agent-main" onClick={() => onFocusPane(agent.agent_id)}>
        <span className="dash-agent-platform">{agent.platform || '?'}</span>
        <span className="dash-agent-desc" title={agent.description || ''}>
          {agent.description || agent.agent_id}
        </span>
        <span className="dash-agent-status" data-status={agent.status}>
          {STATUS_LABEL[agent.status] || agent.status}
        </span>
        <span className="dash-agent-time">{relTime(agent.created_at)}</span>
      </div>
      <div className="dash-agent-actions">
        {active && (
          <button title="停止" onClick={() => onStop(agent.agent_id)}>▣</button>
        )}
        <button title="重试" onClick={() => onRetry(agent.agent_id)}>↻</button>
        <button
          title={expanded ? '收起' : '详情'}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded && (
        <div className="dash-agent-detail">
          {agent.last_ai_response && (
            <div>
              <b>最近回复</b>
              <pre>{agent.last_ai_response}</pre>
            </div>
          )}
          {agent.last_debug && (
            <div>
              <b>调试</b>
              <pre>{agent.last_debug}</pre>
            </div>
          )}
          <div className="dash-agent-id">{agent.agent_id}</div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ agents, connected, onFocusPane, onStop, onRetry }: DashboardProps) {
  const sorted = sortAgents(agents);
  const stats: AgentStats = computeStats(agents);
  return (
    <div className="dash-root">
      <div className="dash-head">
        <span className="dash-title">子 Agent</span>
        <span className="dash-conn" data-on={connected}>{connected ? '●' : '○'}</span>
      </div>
      <div className="dash-stats">
        <StatCard label="总数" value={stats.total} tone="total" />
        <StatCard label="运行" value={stats.running} tone="running" />
        <StatCard label="完成" value={stats.completed} tone="completed" />
        <StatCard label="失败" value={stats.failed + stats.blocked} tone="failed" />
      </div>
      <div className="dash-list">
        {sorted.length === 0 && <div className="dash-empty">暂无子 agent</div>}
        {sorted.map(a => (
          <AgentRow
            key={a.agent_id}
            agent={a}
            onFocusPane={onFocusPane}
            onStop={onStop}
            onRetry={onRetry}
          />
        ))}
      </div>
    </div>
  );
}
