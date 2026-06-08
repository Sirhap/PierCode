import { AgentVM, computeStats } from './agent-store';

// OverviewBar: the always-on top bar with global KPIs across all projects.
// Frosted-glass with neon accents. Also hosts project tabs + the drawer toggle.

interface OverviewBarProps {
  agents: AgentVM[];          // all agents (global), for the KPIs
  projectCount: number;
  projectTabs: { id: string; name: string }[];
  activeProjectId: string | null;
  connected: boolean;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  onToggleDrawer: () => void;
}

function Kpi({ icon, value, label, tone }: { icon: string; value: number | string; label: string; tone?: string }) {
  return (
    <span className="ov-kpi" data-tone={tone}>
      <span className="ov-kpi-icon">{icon}</span>
      <span className="ov-kpi-value">{value}</span>
      <span className="ov-kpi-label">{label}</span>
    </span>
  );
}

export default function OverviewBar(props: OverviewBarProps) {
  const stats = computeStats(props.agents);
  return (
    <div className="ov-bar">
      <span className="ov-brand">◈ PierCode 工作台</span>

      <span className="ov-kpis">
        <Kpi icon="◉" value={props.projectCount} label="项目" />
        <Kpi icon="⚡" value={stats.running + stats.pending} label="活跃" tone="running" />
        <Kpi icon="✓" value={stats.completed} label="完成" tone="completed" />
        <Kpi icon="✕" value={stats.failed + stats.blocked} label="失败" tone="failed" />
      </span>

      <span className="ov-projects">
        {props.projectTabs.map(p => (
          <span
            key={p.id}
            className="ov-proj-tab"
            data-active={p.id === props.activeProjectId}
            onClick={() => props.onSelectProject(p.id)}
          >
            {p.name}
            <button
              className="ov-proj-del"
              title="删除项目"
              onClick={e => {
                e.stopPropagation();
                // Confirm: deleting a project drops its canvas, all its panes and
                // their agents — easy to do by a stray click, hard to undo.
                if (window.confirm(`删除项目「${p.name}」？\n该项目的所有 AI 面板会一并关闭。`)) {
                  props.onDeleteProject(p.id);
                }
              }}
            >×</button>
          </span>
        ))}
        <button className="ov-proj-new" title="新建项目" onClick={props.onNewProject}>+ 项目</button>
      </span>

      <span className="ov-right">
        <span
          className={`ov-conn${props.connected ? ' dot-live' : ''}`}
          data-on={props.connected}
          title={props.connected ? '已连接' : '未连接'}
        />
        <button className="ov-drawer-toggle" title="子 agent 详情" onClick={props.onToggleDrawer}>⌗</button>
      </span>
    </div>
  );
}
