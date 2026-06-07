import { useEffect, useRef, useState } from 'react';
import {
  PROVIDERS,
  PROVIDERS_BY_ID,
  DEFAULT_PANES,
  addPane,
  removePane,
  movePane,
  paneSrc,
  providerIdForPlatform,
  type Pane,
} from './pane-manager';
import Dashboard from './dashboard/Dashboard';
import { HubWsClient, fetchAgents, type HubAddPaneMessage } from './dashboard/hub-ws';
import { AgentVM, mergeSummaries, replaceAll } from './dashboard/agent-store';

const STORAGE_KEY = 'hubPanes';
const POLL_MS = 1500;

// loadPanes / savePanes persist the pane layout so the Hub reopens with the same
// set. chrome.storage.local is the same store the rest of the extension uses.
function loadPanes(): Promise<Pane[]> {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([STORAGE_KEY], r => {
        const saved = r?.[STORAGE_KEY];
        resolve(Array.isArray(saved) && saved.length ? (saved as Pane[]) : DEFAULT_PANES);
      });
    } catch {
      resolve(DEFAULT_PANES);
    }
  });
}

function savePanes(panes: Pane[]): void {
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: panes });
  } catch {
    /* storage unavailable */
  }
}

export default function App() {
  const [panes, setPanes] = useState<Pane[]>(DEFAULT_PANES);
  const [ready, setReady] = useState(false);
  const [agents, setAgents] = useState<AgentVM[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<HubWsClient | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadPanes().then(p => {
      setPanes(p);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) savePanes(panes);
  }, [panes, ready]);

  // Hub WS + agent polling: wire once on mount.
  useEffect(() => {
    const onAddPane = (msg: HubAddPaneMessage) => {
      const providerId = providerIdForPlatform(msg.platform);
      if (!providerId) {
        console.warn('[Hub] hub_add_pane for unsupported platform, ignored:', msg.platform);
        return;
      }
      setPanes(prev => addPane(prev, providerId, msg.agent_id));
    };
    const client = new HubWsClient({
      onAddPane,
      onAgentsUpdate: msg => {
        setAgents(prev => mergeSummaries(prev, (msg.agents as AgentVM[]) || []));
      },
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

  const update = (next: Pane[]) => setPanes(next);
  const availableToAdd = PROVIDERS.filter(p => !panes.some(pn => pn.providerId === p.id && !pn.agentId));

  // focusPane scrolls the worker pane for an agent into view and flashes it.
  const focusPane = (agentId: string) => {
    const grid = gridRef.current;
    if (!grid) return;
    const el = grid.querySelector(`[data-agent-id="${CSS.escape(agentId)}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    el.classList.add('hub-pane-flash');
    window.setTimeout(() => el.classList.remove('hub-pane-flash'), 1200);
  };

  const stopAgent = (agentId: string) => wsRef.current?.sendAgentControl('stop', agentId);
  const retryAgent = (agentId: string) => wsRef.current?.sendAgentControl('retry', agentId);

  return (
    <div className="hub-root">
      <div className="hub-bar">
        <span className="hub-title">PierCode 多 AI 工作台</span>
        <span className="hub-hint">所有面板同屏前台运行，互不抢焦点</span>
        <div className="hub-add">
          {availableToAdd.map(p => (
            <button key={p.id} className="hub-add-btn" onClick={() => update(addPane(panes, p.id))}>
              + {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hub-body">
        <Dashboard
          agents={agents}
          connected={connected}
          onFocusPane={focusPane}
          onStop={stopAgent}
          onRetry={retryAgent}
        />

        <div className="hub-grid" ref={gridRef}>
          {panes.map((pane, i) => {
            const provider = PROVIDERS_BY_ID[pane.providerId];
            return (
              <div className="hub-pane" key={pane.key} data-agent-id={pane.agentId ?? ''}>
                <div className="hub-pane-head">
                  <span className="hub-pane-name">
                    {provider?.label ?? pane.providerId}
                    {pane.agentId ? <span className="hub-pane-worker"> · worker {pane.agentId.slice(0, 12)}</span> : null}
                  </span>
                  <span className="hub-pane-ctrl">
                    <button title="左移" disabled={i === 0} onClick={() => update(movePane(panes, i, i - 1))}>◀</button>
                    <button title="右移" disabled={i === panes.length - 1} onClick={() => update(movePane(panes, i, i + 1))}>▶</button>
                    <button title="关闭" onClick={() => update(removePane(panes, pane.key))}>✕</button>
                  </span>
                </div>
                {/* Resident iframe: never keyed by index so reorder doesn't reload it. */}
                <iframe className="hub-pane-frame" src={paneSrc(pane)} title={pane.key} />
              </div>
            );
          })}
          {panes.length === 0 && <div className="hub-empty">用上方按钮添加 AI 面板</div>}
        </div>
      </div>
    </div>
  );
}
