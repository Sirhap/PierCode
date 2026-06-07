// hub-ws: the Hub page's own WebSocket client (role=hub). It is independent of
// the content-script ws-linker connections that live inside each AI iframe — this
// one represents the Hub workspace itself, so the server can push it pane and
// dashboard events (`hub_add_pane`, `agents_update`) and accept control actions
// (`agent_control`). Reconnects on drop; the dashboard's GET /agents poll covers
// the gap while reconnecting.

export interface HubAddPaneMessage {
  type: 'hub_add_pane';
  agent_id: string;
  parent_agent_id?: string;
  platform: string;
  description?: string;
}

export interface AgentsUpdateMessage {
  type: 'agents_update';
  agents: unknown[];
}

export interface HubRemovePaneMessage {
  type: 'hub_remove_pane';
  agent_id: string;
}

export interface HubWsHandlers {
  onAddPane?: (msg: HubAddPaneMessage) => void;
  onRemovePane?: (msg: HubRemovePaneMessage) => void;
  onAgentsUpdate?: (msg: AgentsUpdateMessage) => void;
  onStatus?: (connected: boolean) => void;
}

interface AuthInfo {
  apiUrl: string;
  token: string;
}

// A stable per-Hub-page client id, persisted so reconnects keep the same id.
function hubClientId(): string {
  try {
    const key = '__PIERCODE_HUB_CLIENT_ID__';
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const id = `hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getAuthInfo(): Promise<AuthInfo | null> {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['apiUrl', 'authToken', 'authPort'], result => {
        if (result.apiUrl && result.authToken) {
          resolve({ apiUrl: result.apiUrl, token: result.authToken });
        } else if (result.authPort && result.authToken) {
          resolve({ apiUrl: `http://127.0.0.1:${result.authPort}`, token: result.authToken });
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function toWsUrl(apiUrl: string, token: string, id: string): string | null {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.searchParams.set('token', token);
    url.searchParams.set('id', id);
    url.searchParams.set('client', 'hub');
    url.searchParams.set('role', 'hub');
    return url.toString();
  } catch {
    return null;
  }
}

export class HubWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  private readonly id = hubClientId();
  // Kept so stop() can remove the storage listener; otherwise repeated
  // start()/stop() cycles would leak a listener (and a connect) each time.
  private storageListener: ((changes: { [k: string]: chrome.storage.StorageChange }, namespace: string) => void) | null = null;

  constructor(private handlers: HubWsHandlers) {}

  start(): void {
    this.closed = false;
    void this.connect();
    // Reconnect when auth is configured/changed after the Hub opened.
    try {
      this.storageListener = (changes, namespace) => {
        if (namespace === 'local' && (changes.apiUrl || changes.authToken || changes.authPort)) {
          void this.connect();
        }
      };
      chrome.storage.onChanged.addListener(this.storageListener);
    } catch {
      // storage events unavailable; the poll fallback still works.
    }
  }

  stop(): void {
    this.closed = true;
    if (this.storageListener) {
      try { chrome.storage.onChanged.removeListener(this.storageListener); } catch { /* unavailable */ }
      this.storageListener = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
  }

  // sendAgentControl issues a dashboard control action (stop / retry) to the
  // server. The /ws channel was Bearer-authenticated at handshake, so the action
  // is trusted server-side. Returns false if the socket is not open.
  sendAgentControl(action: 'stop' | 'retry', agentId: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'agent_control', action, agent_id: agentId }));
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 3000);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const info = await getAuthInfo();
    if (!info) {
      this.handlers.onStatus?.(false);
      this.scheduleReconnect();
      return;
    }
    const wsUrl = toWsUrl(info.apiUrl, info.token, this.id);
    if (!wsUrl) {
      this.handlers.onStatus?.(false);
      return;
    }
    // Replace any prior socket cleanly.
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch { /* already closing */ }
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.handlers.onStatus?.(false);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onopen = () => this.handlers.onStatus?.(true);
    socket.onmessage = event => this.onMessage(event);
    socket.onclose = () => {
      if (this.ws === socket) this.ws = null;
      this.handlers.onStatus?.(false);
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch { /* already closing */ }
    };
  }

  private onMessage(event: MessageEvent): void {
    let msg: { type?: string };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'hub_add_pane') {
      this.handlers.onAddPane?.(msg as HubAddPaneMessage);
    } else if (msg.type === 'hub_remove_pane') {
      this.handlers.onRemovePane?.(msg as HubRemovePaneMessage);
    } else if (msg.type === 'agents_update') {
      this.handlers.onAgentsUpdate?.(msg as AgentsUpdateMessage);
    }
  }
}

// fetchAgents polls GET /agents for the full roster. Used for the first paint and
// as a fallback while the WS push channel reconnects. Returns [] on any failure
// (the dashboard shows an empty/disconnected state rather than throwing).
export async function fetchAgents(): Promise<unknown[]> {
  const info = await getAuthInfo();
  if (!info) return [];
  try {
    const url = `${info.apiUrl.replace(/\/+$/, '')}/agents`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${info.token}` } });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.agents) ? body.agents : [];
  } catch {
    return [];
  }
}
