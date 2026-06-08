import { useEffect, useRef, useState, useCallback } from 'react';
import { PROVIDERS, PROVIDERS_BY_ID, providerIdForPlatform, paneSrc, type Pane } from './pane-manager';
import {
  Project,
  createProject,
  deleteProject,
  addNode,
  addChildNode,
  removeNode,
  findNodeByAgentId,
  migrateLegacyPanes,
  normalizeProjects,
} from './project-store';
import OverviewBar from './dashboard/OverviewBar';
import ProjectDrawer from './dashboard/ProjectDrawer';
import { HubWsClient, fetchAgents, type HubAddPaneMessage } from './dashboard/hub-ws';
import { AgentVM, mergeSummaries, reconcilePoll } from './dashboard/agent-store';

const PROJECTS_KEY = 'hubProjects';
const LEGACY_PANES_KEY = 'hubPanes';
const POLL_MS = 1500;

// loadProjects reads persisted projects, migrating the v1 flat `hubPanes` layout
// into a default project on first v2 run. Always returns at least one project.
function loadProjects(): Promise<Project[]> {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([PROJECTS_KEY, LEGACY_PANES_KEY], r => {
        const saved = r?.[PROJECTS_KEY];
        if (Array.isArray(saved) && saved.length) {
          resolve(normalizeProjects(saved as Project[]));
          return;
        }
        const legacy = r?.[LEGACY_PANES_KEY];
        if (Array.isArray(legacy) && legacy.length) {
          resolve(migrateLegacyPanes(legacy));
          return;
        }
        resolve([createProject('我的项目')]);
      });
    } catch {
      resolve([createProject('我的项目')]);
    }
  });
}

function saveProjects(projects: Project[]): void {
  try {
    chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  } catch {
    /* storage unavailable */
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [agents, setAgents] = useState<AgentVM[]>([]);
  const [connected, setConnected] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wsRef = useRef<HubWsClient | null>(null);
  // activeIdRef keeps the latest active project id available inside the WS
  // callback closure (set up once) without re-subscribing on every switch.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  // projectsRef keeps the latest projects list available inside the
  // removeProject's setActiveId updater, so it reads the post-deletion list
  // instead of a stale closure value.
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;

  useEffect(() => {
    loadProjects().then(p => {
      setProjects(p);
      setActiveId(p[0]?.id ?? null);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) saveProjects(projects);
  }, [projects, ready]);

  const active = projects.find(p => p.id === activeId) ?? null;

  // Hub WS + agent polling: wire once on mount.
  useEffect(() => {
    const onAddPane = (msg: HubAddPaneMessage) => {
      const providerId = providerIdForPlatform(msg.platform);
      if (!providerId) {
        console.warn('[Hub] hub_add_pane unsupported platform, ignored:', msg.platform);
        return;
      }
      setProjects(prev => {
        // Route the pane into the project that owns its PARENT agent, so spawning
        // in project A then switching to view B doesn't drop the new pane into B.
        // Top-level spawns (no parent node placed) fall back to the active project.
        const parentLoc = msg.parent_agent_id
          ? findNodeByAgentId(prev, msg.parent_agent_id)
          : undefined;
        const projectId = parentLoc?.projectId ?? activeIdRef.current;
        if (!projectId) return prev;
        return addChildNode(prev, projectId, {
          agentId: msg.agent_id,
          parentAgentId: msg.parent_agent_id,
          providerId,
          // First-level spawn (no parent agent): attach under the project's first
          // root node if there is one, else it becomes a free root.
          fallbackParentNodeId: rootNodeIdFor(prev, projectId),
        });
      });
    };
    // When the WS pushes a fresh roster, remember each agent id's push time. A poll
    // that races a brand-new push (server /agents index not yet updated) uses these
    // to retain just-pushed agents instead of dropping them for a cycle.
    const wsSeenAt = new Map<string, number>();
    const client = new HubWsClient({
      onAddPane,
      // Server auto-closes a finished worker's pane (so the coordinator never has
      // to call stop_agent for cleanup). Remove the node carrying that agent id,
      // wherever it lives. No stop is sent — the worker already reported terminal.
      onRemovePane: msg => {
        setProjects(prev => {
          const loc = findNodeByAgentId(prev, msg.agent_id);
          return loc ? removeNode(prev, loc.projectId, loc.nodeId) : prev;
        });
      },
      onAgentsUpdate: msg => {
        const incoming = (msg.agents as AgentVM[]) || [];
        const now = Date.now();
        for (const a of incoming) if (a?.agent_id) wsSeenAt.set(a.agent_id, now);
        setAgents(prev => mergeSummaries(prev, incoming));
      },
      onStatus: setConnected,
    });
    client.start();
    wsRef.current = client;

    let cancelled = false;
    const poll = async () => {
      const list = (await fetchAgents()) as AgentVM[];
      if (cancelled) return;
      const cutoff = Date.now() - POLL_MS * 2; // grace: keep agents pushed very recently
      setAgents(prev => reconcilePoll(prev, list, a => (wsSeenAt.get(a.agent_id) ?? 0) >= cutoff));
    };
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      client.stop();
      wsRef.current = null;
    };
  }, []);

  // ── project ops ──────────────────────────────────────────────────────────
  const newProject = () => {
    const p = createProject(`项目 ${projects.length + 1}`);
    setProjects(prev => [...prev, p]);
    setActiveId(p.id);
  };
  const removeProject = (id: string) => {
    const remaining = deleteProject(projectsRef.current, id);
    const next = remaining.length ? remaining : [createProject('我的项目')];
    setProjects(next);
    setActiveId(active =>
      active && next.some(p => p.id === active) ? active : (next[0]?.id ?? null),
    );
  };

  // ── pane ops (scoped to active project) ──────────────────────────────────
  const addAi = (providerId: string) => {
    if (!activeId) return;
    setProjects(prev => addNode(prev, activeId, providerId));
  };

  // closeNode stops the agent (if any) then removes the node. Replaces the old
  // onCloseNode which sent the same stop signal before canvas removal.
  const closeNode = useCallback((nodeId: string) => {
    const projectId = activeIdRef.current;
    if (!projectId) return;
    setProjects(prev => {
      const node = prev.find(p => p.id === projectId)?.nodes.find(n => n.id === nodeId);
      if (node?.agentId) wsRef.current?.sendAgentControl('stop', node.agentId);
      return removeNode(prev, projectId, nodeId);
    });
  }, []);

  // focusAgent scrolls the matching pane into view (drawer → pane grid).
  const focusAgent = (agentId: string) => {
    const loc = findNodeByAgentId(projectsRef.current, agentId);
    if (loc) document.getElementById(`pane-${loc.nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const stopAgent = (agentId: string) => wsRef.current?.sendAgentControl('stop', agentId);
  const retryAgent = (agentId: string) => wsRef.current?.sendAgentControl('retry', agentId);

  // Agents scoped to the active project (the drawer). Global `agents` feeds the
  // overview KPIs.
  const projectAgentIds = new Set((active?.nodes ?? []).map(n => n.agentId).filter(Boolean) as string[]);
  const drawerAgents = agents.filter(a => projectAgentIds.has(a.agent_id) || (active && a.project_id === active.id));

  const availableToAdd = PROVIDERS;

  return (
    <div className="hub-root">
      <OverviewBar
        agents={agents}
        projectCount={projects.length}
        projectTabs={projects.map(p => ({ id: p.id, name: p.name }))}
        activeProjectId={activeId}
        connected={connected}
        onSelectProject={setActiveId}
        onNewProject={newProject}
        onDeleteProject={removeProject}
        onToggleDrawer={() => setDrawerOpen(v => !v)}
      />

      <div className="hub-toolbar">
        <span className="hub-toolbar-label">+ AI</span>
        {availableToAdd.map(p => (
          <button key={p.id} className="hub-add-btn" onClick={() => addAi(p.id)}>{p.label}</button>
        ))}
      </div>

      <div className="hub-body">
        {active && active.nodes.length > 0 ? (
          <div className="hub-pane-grid">
            {active.nodes.map(n => {
              const pane: Pane = { key: n.id, providerId: n.providerId, agentId: n.agentId };
              return (
                <div key={n.id} id={`pane-${n.id}`} className="hub-pane">
                  <div className="hub-pane-bar">
                    <span className="hub-pane-title">{PROVIDERS_BY_ID[n.providerId]?.label ?? n.providerId}{n.agentId ? ` · @${n.agentId.slice(0, 6)}` : ''}</span>
                    <button className="hub-pane-close" onClick={() => closeNode(n.id)} title="关闭并停止 agent">✕</button>
                  </div>
                  <iframe className="hub-pane-frame" src={paneSrc(pane)} title={n.id} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="canvas-empty">用「+ AI」添加一个 AI 面板</div>
        )}
        <ProjectDrawer
          open={drawerOpen}
          agents={drawerAgents}
          onClose={() => setDrawerOpen(false)}
          onFocusAgent={focusAgent}
          onStop={stopAgent}
          onRetry={retryAgent}
        />
      </div>
    </div>
  );
}

// rootNodeIdFor returns the id of the project's first root node (a main agent),
// the default attach point for a first-level spawn whose parent agent is a main
// agent (no agent record to map to). Empty string if the project has no roots.
function rootNodeIdFor(projects: Project[], projectId: string): string | undefined {
  const p = projects.find(pr => pr.id === projectId);
  const root = p?.nodes.find(n => !n.parentNodeId);
  return root?.id;
}
