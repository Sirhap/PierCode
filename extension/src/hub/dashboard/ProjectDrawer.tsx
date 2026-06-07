import { useState } from 'react';
import { AgentVM, AgentTreeNode, buildAgentTree, flattenTree } from './agent-store';

// ProjectDrawer: the right slide-out showing the current project's agent tree
// (indented by spawn depth), each agent's status + last reply, and stop/retry
// controls. Glassmorphic. Pure presentation — raises intent via callbacks.

interface ProjectDrawerProps {
  open: boolean;
  agents: AgentVM[];          // scoped to the current project
  onClose: () => void;
  onFocusAgent: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onRetry: (agentId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '等待', running: '运行中', completed: '完成',
  failed: '失败', blocked: '阻塞', stopped: '已停止',
};

function TreeRow({
  node, onFocusAgent, onStop, onRetry,
}: {
  node: AgentTreeNode;
  onFocusAgent: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = node.status === 'running' || node.status === 'pending';
  return (
    <div className="dr-agent" data-status={node.status}>
      <div className="dr-agent-main" style={{ paddingLeft: 8 + node.depth * 16 }}>
        {node.depth > 0 && <span className="dr-twig">└</span>}
        <span className="dr-platform">{node.platform || '?'}</span>
        <span className="dr-desc" title={node.description || ''} onClick={() => onFocusAgent(node.agent_id)}>
          {node.description || node.agent_id}
        </span>
        <span className="dr-status" data-status={node.status}>{STATUS_LABEL[node.status] || node.status}</span>
        <span className="dr-actions">
          {active && <button title="停止" onClick={() => onStop(node.agent_id)}>▣</button>}
          <button title="重试" onClick={() => onRetry(node.agent_id)}>↻</button>
          <button title={open ? '收起' : '详情'} onClick={() => setOpen(v => !v)}>{open ? '▾' : '▸'}</button>
        </span>
      </div>
      {open && (
        <div className="dr-detail" style={{ marginLeft: 8 + node.depth * 16 }}>
          {node.last_ai_response && (<><b>最近回复</b><pre>{node.last_ai_response}</pre></>)}
          {node.last_debug && (<><b>调试</b><pre>{node.last_debug}</pre></>)}
          <div className="dr-id">{node.agent_id}</div>
        </div>
      )}
    </div>
  );
}

export default function ProjectDrawer({ open, agents, onClose, onFocusAgent, onStop, onRetry }: ProjectDrawerProps) {
  const tree = flattenTree(buildAgentTree(agents));
  return (
    <div className="dr-root" data-open={open}>
      <div className="dr-head">
        <span className="dr-title">子 Agent 树</span>
        <button className="dr-close" title="收起" onClick={onClose}>›</button>
      </div>
      <div className="dr-list">
        {tree.length === 0 && <div className="dr-empty">本项目暂无子 agent</div>}
        {tree.map(node => (
          <TreeRow key={node.agent_id} node={node} onFocusAgent={onFocusAgent} onStop={onStop} onRetry={onRetry} />
        ))}
      </div>
    </div>
  );
}
