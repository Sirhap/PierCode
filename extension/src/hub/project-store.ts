// project-store: the pure model behind the Hub v2 project canvas. A "project" is
// one canvas holding AI nodes; a node is one embedded AI site (its iframe) at a
// logical (x,y) on the canvas. Main agents are root nodes the user adds; spawned
// sub-agents are child nodes wired under their parent. Free of DOM / chrome /
// React so it is unit-testable; the React + storage layers build on it.

import { PROVIDERS_BY_ID } from './pane-manager';

export interface Viewport {
  x: number; // canvas pan offset (screen px), applied as translate
  y: number;
  zoom: number; // canvas scale, 1 = 100%
}

export interface CanvasNode {
  id: string; // unique node id
  providerId: string; // qwen/claude/... (key into PROVIDERS)
  agentId?: string; // set for sub-agent (worker) nodes; carried into the iframe src
  parentNodeId?: string; // the node that spawned this one; drives the edge drawn
  x: number; // logical canvas coordinates (pre-zoom)
  y: number;
  w: number; // logical size
  h: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  nodes: CanvasNode[];
  viewport: Viewport;
}

export const DEFAULT_NODE_W = 420;
export const DEFAULT_NODE_H = 320;
export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

// Vertical/horizontal spacing used when auto-placing a spawned child below its
// parent. Kept here (not the React layer) so placement is deterministic + tested.
const CHILD_DROP_Y = DEFAULT_NODE_H + 80;
const CHILD_SPREAD_X = DEFAULT_NODE_W + 40;

let idSeq = 0;
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

export function createProject(name: string): Project {
  return {
    id: uid('proj'),
    name: name.trim() || '未命名项目',
    createdAt: Date.now(),
    nodes: [],
    viewport: { ...DEFAULT_VIEWPORT },
  };
}

export function renameProject(projects: Project[], projectId: string, name: string): Project[] {
  return projects.map(p => (p.id === projectId ? { ...p, name: name.trim() || p.name } : p));
}

export function deleteProject(projects: Project[], projectId: string): Project[] {
  return projects.filter(p => p.id !== projectId);
}

function mapProject(projects: Project[], projectId: string, fn: (p: Project) => Project): Project[] {
  return projects.map(p => (p.id === projectId ? fn(p) : p));
}

// addNode adds a root (main-agent) node for a provider at a position. Unknown
// providers are ignored (returns the list unchanged).
export function addNode(
  projects: Project[],
  projectId: string,
  providerId: string,
  pos?: { x: number; y: number },
): Project[] {
  if (!PROVIDERS_BY_ID[providerId]) return projects;
  return mapProject(projects, projectId, p => {
    const node: CanvasNode = {
      id: uid('node'),
      providerId,
      x: pos?.x ?? nextRootX(p.nodes),
      y: pos?.y ?? 40,
      w: DEFAULT_NODE_W,
      h: DEFAULT_NODE_H,
    };
    return { ...p, nodes: [...p.nodes, node] };
  });
}

// addChildNode wires a spawned sub-agent under an existing node. `parentAgentId`
// is empty for a first-level spawn (parent is a main-agent root) — in that case
// the child attaches to `fallbackParentNodeId` (the project's active/root node).
// Returns the list unchanged if the project or provider is unknown, or if a node
// for this agentId already exists (spawn is idempotent on reconnect).
export function addChildNode(
  projects: Project[],
  projectId: string,
  args: { agentId: string; parentAgentId?: string; providerId: string; fallbackParentNodeId?: string },
): Project[] {
  if (!PROVIDERS_BY_ID[args.providerId]) return projects;
  return mapProject(projects, projectId, p => {
    if (p.nodes.some(n => n.agentId === args.agentId)) return p; // already placed
    const parentNode = args.parentAgentId
      ? p.nodes.find(n => n.agentId === args.parentAgentId)
      : (args.fallbackParentNodeId ? p.nodes.find(n => n.id === args.fallbackParentNodeId) : undefined);
    const siblingCount = parentNode
      ? p.nodes.filter(n => n.parentNodeId === parentNode.id).length
      : 0;
    const base = parentNode ?? { x: 40, y: 40 };
    const node: CanvasNode = {
      id: uid('node'),
      providerId: args.providerId,
      agentId: args.agentId,
      parentNodeId: parentNode?.id,
      x: base.x + siblingCount * CHILD_SPREAD_X,
      y: base.y + CHILD_DROP_Y,
      w: DEFAULT_NODE_W,
      h: DEFAULT_NODE_H,
    };
    return { ...p, nodes: [...p.nodes, node] };
  });
}

export function removeNode(projects: Project[], projectId: string, nodeId: string): Project[] {
  return mapProject(projects, projectId, p => ({
    ...p,
    // Removing a node also detaches its children's parent link so no edge dangles.
    nodes: p.nodes
      .filter(n => n.id !== nodeId)
      .map(n => (n.parentNodeId === nodeId ? { ...n, parentNodeId: undefined } : n)),
  }));
}

export function moveNode(projects: Project[], projectId: string, nodeId: string, x: number, y: number): Project[] {
  return mapProject(projects, projectId, p => ({
    ...p,
    nodes: p.nodes.map(n => (n.id === nodeId ? { ...n, x, y } : n)),
  }));
}

// resizeNode sets a node's logical width/height (clamped to a sane minimum so a
// pane can't be shrunk to nothing). Used by the node card's resize handle; w/h
// are persisted on the node so the layout survives reload.
const MIN_NODE_W = 240;
const MIN_NODE_H = 180;
export function resizeNode(projects: Project[], projectId: string, nodeId: string, w: number, h: number): Project[] {
  const nw = Math.max(MIN_NODE_W, Math.round(w));
  const nh = Math.max(MIN_NODE_H, Math.round(h));
  return mapProject(projects, projectId, p => ({
    ...p,
    nodes: p.nodes.map(n => (n.id === nodeId ? { ...n, w: nw, h: nh } : n)),
  }));
}

// findNodeByAgentId locates the node carrying an agent id across ALL projects,
// returning which project + node it lives in (or undefined). The Hub uses it so a
// spawned worker's pane lands in the project of its PARENT agent — not whichever
// project the user happens to be viewing when the spawn arrives.
export function findNodeByAgentId(
  projects: Project[],
  agentId: string,
): { projectId: string; nodeId: string } | undefined {
  if (!agentId) return undefined;
  for (const p of projects) {
    const node = p.nodes.find(n => n.agentId === agentId);
    if (node) return { projectId: p.id, nodeId: node.id };
  }
  return undefined;
}

export function setViewport(projects: Project[], projectId: string, viewport: Viewport): Project[] {
  return mapProject(projects, projectId, p => ({ ...p, viewport }));
}

// nextRootX lays new root nodes out left-to-right so they don't stack.
function nextRootX(nodes: CanvasNode[]): number {
  const roots = nodes.filter(n => !n.parentNodeId);
  return 40 + roots.length * CHILD_SPREAD_X;
}

// Legacy migration: v1 stored a flat `hubPanes` list (one AI per column, no
// canvas). On first v2 load with panes but no projects, fold them into one
// "默认项目" as root nodes so the user doesn't lose their layout.
export function migrateLegacyPanes(panes: Array<{ providerId: string; agentId?: string }>): Project[] {
  const project = createProject('默认项目');
  let i = 0;
  for (const pane of panes) {
    if (!PROVIDERS_BY_ID[pane.providerId]) continue;
    project.nodes.push({
      id: uid('node'),
      providerId: pane.providerId,
      agentId: pane.agentId,
      x: 40 + i * CHILD_SPREAD_X,
      y: 40,
      w: DEFAULT_NODE_W,
      h: DEFAULT_NODE_H,
    });
    i += 1;
  }
  return [project];
}
