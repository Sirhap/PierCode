import { useEffect, useRef, useState, useCallback } from 'react';
import { PROVIDERS, providerIdForPlatform } from './pane-manager';
import {
  Project,
  Viewport,
  createProject,
  deleteProject,
  addNode,
  addChildNode,
  removeNode,
  moveNode,
  setViewport,
  migrateLegacyPanes,
} from './project-store';
import Canvas from './canvas/Canvas';
import OverviewBar from './dashboard/OverviewBar';
import ProjectDrawer from './dashboard/ProjectDrawer';
import { HubWsClient, fetchAgents, type HubAddPaneMessage } from './dashboard/hub-ws';
import { AgentVM, mergeSummaries, replaceAll } from './dashboard/agent-store';

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
          resolve(saved as Project[]);
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
      const projectId = activeIdRef.current;
      if (!projectId) return;
      setProjects(prev =>
        addChildNode(prev, projectId, {
          agentId: msg.agent_id,
          parentAgentId: msg.parent_agent_id,
          providerId,
          // First-level spawn (no parent agent): attach under the project's first
          // root node if there is one, else it becomes a free root.
          fallbackParentNodeId: rootNodeIdFor(prev, projectId),
        }),
      );
    };
    const client = new HubWsClient({
      onAddPane,
      onAgentsUpdate: msg => setAgents(prev => mergeSummaries(prev, (msg.agents as AgentVM[]) || [])),
      onStatus: setConnected,
    });
    client.start();
    wsRef.current = client;

    let cancelled = false;
    const poll = async () => {
      const list = (await fetchAgents()) as AgentVM[];
      if (!cancelled) setAgents(replaceAll(list));
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
    setProjects(prev => {
      const next = deleteProject(prev, id);
      return next.length ? next : [createProject('我的项目')];
    });
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = projects.filter(p => p.id !== id);
      return remaining[0]?.id ?? null;
    });
  };

  // ── canvas ops (scoped to active project) ────────────────────────────────
  const addAi = (providerId: string) => {
    if (!activeId) return;
    setProjects(prev => addNode(prev, activeId, providerId));
  };
  const onMoveNode = useCallback((nodeId: string, x: number, y: number) => {
    if (!activeIdRef.current) return;
    setProjects(prev => moveNode(prev, activeIdRef.current!, nodeId, x, y));
  }, []);
  const onSetViewport = useCallback((vp: Viewport) => {
    if (!activeIdRef.current) return;
    setProjects(prev => setViewport(prev, activeIdRef.current!, vp));
  }, []);
  const onCloseNode = useCallback((nodeId: string) => {
    if (!activeIdRef.current) return;
    setProjects(prev => removeNode(prev, activeIdRef.current!, nodeId));
  }, []);

  // Focus a canvas node by its agent id (from the drawer). Delegates to the
  // canvas via a custom event the Canvas listens for — keeps Canvas self-owned.
  const focusAgent = (agentId: string) => {
    window.dispatchEvent(new CustomEvent('piercode-hub-focus-agent', { detail: agentId }));
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
        {active ? (
          <Canvas
            key={active.id}
            project={active}
            statusByAgentId={Object.fromEntries(agents.map(a => [a.agent_id, a.status]))}
            onMoveNode={onMoveNode}
            onSetViewport={onSetViewport}
            onCloseNode={onCloseNode}
          />
        ) : (
          <div className="canvas-empty">用「+ 项目」新建一个项目</div>
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
