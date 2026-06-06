// pane-manager: the pure model behind the Hub grid. A "pane" is one embedded AI
// site (its iframe). This module owns the catalog and the pane list operations
// (add / remove / reorder); the React layer renders from it. Kept free of DOM /
// chrome.* so it is unit-testable.

export interface AIProvider {
  id: string;       // stable key, e.g. "qwen"
  label: string;    // display name
  url: string;      // home URL loaded in the iframe
  host: string;     // bare hostname (must be covered by AI_FRAME_HOSTS)
}

// Default catalog — the sites the Hub can embed. Hosts here must be a subset of
// background/frame-unlock AI_FRAME_HOSTS so the DNR rules actually unlock them.
export const PROVIDERS: AIProvider[] = [
  { id: 'qwen', label: 'Qwen', url: 'https://chat.qwen.ai/', host: 'chat.qwen.ai' },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/', host: 'claude.ai' },
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', host: 'chatgpt.com' },
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/', host: 'gemini.google.com' },
  { id: 'kimi', label: 'Kimi', url: 'https://www.kimi.com/', host: 'kimi.com' },
  { id: 'chatz', label: 'Chat Z', url: 'https://chat.z.ai/', host: 'chat.z.ai' },
];

export const PROVIDERS_BY_ID: Record<string, AIProvider> = Object.fromEntries(
  PROVIDERS.map(p => [p.id, p]),
);

// A pane instance in the grid. `key` is unique per pane (a provider can appear
// once in v1, but worker panes reuse the provider with a distinct agent id).
export interface Pane {
  key: string;
  providerId: string;
  agentId?: string; // set for worker panes — appended to the iframe src as ?piercode_agent
}

// paneSrc builds the iframe URL for a pane. Worker panes carry the agent id in
// the query exactly like a worker tab, so the existing workerAgentId() path binds
// it with zero changes.
export function paneSrc(pane: Pane): string {
  const provider = PROVIDERS_BY_ID[pane.providerId];
  if (!provider) return 'about:blank';
  if (!pane.agentId) return provider.url;
  const u = new URL(provider.url);
  u.searchParams.set('piercode_agent', pane.agentId);
  return u.toString();
}

// addPane appends a provider pane if not already present (v1: one pane per
// provider for non-worker panes). Worker panes (agentId set) are always added.
export function addPane(panes: Pane[], providerId: string, agentId?: string): Pane[] {
  if (!PROVIDERS_BY_ID[providerId]) return panes;
  if (!agentId && panes.some(p => p.providerId === providerId && !p.agentId)) return panes;
  const key = agentId ? `${providerId}:${agentId}` : providerId;
  if (panes.some(p => p.key === key)) return panes;
  return [...panes, { key, providerId, agentId }];
}

export function removePane(panes: Pane[], key: string): Pane[] {
  return panes.filter(p => p.key !== key);
}

// movePane shifts the pane at `from` to index `to`, clamping into range. Used by
// drag-reorder; resident iframes are not reloaded on reorder.
export function movePane(panes: Pane[], from: number, to: number): Pane[] {
  if (from < 0 || from >= panes.length) return panes;
  const clampedTo = Math.max(0, Math.min(panes.length - 1, to));
  if (from === clampedTo) return panes;
  const next = panes.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clampedTo, 0, moved);
  return next;
}

export const DEFAULT_PANES: Pane[] = [
  { key: 'qwen', providerId: 'qwen' },
  { key: 'claude', providerId: 'claude' },
  { key: 'chatgpt', providerId: 'chatgpt' },
];
