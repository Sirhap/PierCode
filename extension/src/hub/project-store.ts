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
  contentZoom?: number; // iframe content zoom (1 = 100%); enlarges the AI page's
                        // own text/buttons inside the pane. Default DEFAULT_CONTENT_ZOOM.
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  nodes: CanvasNode[];
  viewport: Viewport;
}

// Default node size — sized for an embedded AI chat UI to be usable, not cramped.
export const DEFAULT_NODE_W = 560;
export const DEFAULT_NODE_H = 520;
// Minimum a node can be dragged/preset down to (keeps a pane usable).
export const MIN_NODE_W = 320;
export const MIN_NODE_H = 240;
// One-click size presets shown in the node header.
export const NODE_SIZE_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: 'sm', label: '小', w: 460, h: 420 },
  { id: 'md', label: '中', w: 640, h: 560 },
  { id: 'lg', label: '大', w: 900, h: 760 },
];
// AI sites render their desktop layout small inside a ~560px pane; bump the
// embedded content zoom so text/buttons are comfortable by default.
export const DEFAULT_CONTENT_ZOOM = 1.25;
export const MIN_CONTENT_ZOOM = 0.6;
export const MAX_CONTENT_ZOOM = 2;
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
    // Store the node as-is; tree mode lays it out live on render, free mode keeps
    // this position.
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
    // Store as-is; tree mode (default) lays the spawned worker out live under its
    // parent on render, free mode keeps this fallback position.
    return { ...p, nodes: [...p.nodes, node] };
  });
}

// ── tree auto-layout ────────────────────────────────────────────────────────
// Horizontal gap between sibling subtrees and vertical gap between tree levels,
// in logical px. Generous so panes don't touch.
const TREE_H_GAP = 60;
const TREE_V_GAP = 120;

// layoutTree assigns tidy top-down tree coordinates to every node from the
// parentNodeId forest. Each subtree is packed left→right by its own width, and a
// parent is centered over its children. Cycles/missing parents degrade to roots
// so nothing is lost. Pure: returns new nodes, does not mutate.
export function layoutTree(nodes: CanvasNode[]): CanvasNode[] {
  if (nodes.length === 0) return nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const childrenOf = new Map<string, CanvasNode[]>();
  const roots: CanvasNode[] = [];
  for (const n of nodes) {
    const pid = n.parentNodeId;
    if (pid && byId.has(pid) && pid !== n.id) {
      (childrenOf.get(pid) ?? childrenOf.set(pid, []).get(pid)!).push(n);
    } else {
      roots.push(n);
    }
  }
  const pos = new Map<string, { x: number; y: number }>();
  const seen = new Set<string>();
  // place returns the total subtree width; lays out children then centers the node.
  const place = (node: CanvasNode, left: number, depth: number): number => {
    if (seen.has(node.id)) { pos.set(node.id, { x: left, y: depth * 0 }); return node.w; }
    seen.add(node.id);
    const kids = (childrenOf.get(node.id) ?? []).filter(k => !seen.has(k.id));
    const y = depth * (DEFAULT_NODE_H + TREE_V_GAP) + 40;
    if (kids.length === 0) {
      pos.set(node.id, { x: left, y });
      return node.w;
    }
    let cursor = left;
    const childCenters: number[] = [];
    for (const k of kids) {
      const w = place(k, cursor, depth + 1);
      childCenters.push(cursor + w / 2);
      cursor += w + TREE_H_GAP;
    }
    const subtreeW = cursor - TREE_H_GAP - left;
    // Center this node over the span of its children's centers.
    const cx = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
    pos.set(node.id, { x: cx - node.w / 2, y });
    return Math.max(subtreeW, node.w);
  };
  let rootLeft = 40;
  for (const r of roots) {
    const w = place(r, rootLeft, 0);
    rootLeft += w + TREE_H_GAP * 2;
  }
  return nodes.map(n => {
    const p = pos.get(n.id);
    return p ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n;
  });
}

// applyTreeLayout writes tidy tree coordinates into the stored nodes. Tree mode
// computes positions live on render, so this is only needed to RESET free-mode
// positions back to a tidy tree (the 「整理」button in free mode).
export function applyTreeLayout(projects: Project[], projectId: string): Project[] {
  return mapProject(projects, projectId, p => ({ ...p, nodes: layoutTree(p.nodes) }));
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
  // Only meaningful in free-layout mode (tree mode ignores stored x/y and lays
  // out live); the drag itself is gated to free mode in Canvas.
  return mapProject(projects, projectId, p => ({
    ...p,
    nodes: p.nodes.map(n => (n.id === nodeId ? { ...n, x, y } : n)),
  }));
}

// resizeNode sets a node's logical width/height, clamped to a usable minimum so a
// pane can't be shrunk to nothing. w/h persist on the node so layout survives
// reload. Used by both the corner drag handle and the header size presets.
export function resizeNode(projects: Project[], projectId: string, nodeId: string, w: number, h: number): Project[] {
  const nw = Math.max(MIN_NODE_W, Math.round(w));
  const nh = Math.max(MIN_NODE_H, Math.round(h));
  return mapProject(projects, projectId, p => ({
    ...p,
    nodes: p.nodes.map(n => (n.id === nodeId ? { ...n, w: nw, h: nh } : n)),
  }));
}

// normalizeProjects heals persisted data: fills missing/invalid w/h/x/y on nodes
// (older builds stored nodes without w/h) so geometry math (fitView, centerOnNode)
// never sees undefined → NaN → blank canvas. Pure; returns a cleaned copy.
export function normalizeProjects(projects: Project[]): Project[] {
  const fix = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return projects.map(p => ({
    ...p,
    viewport: {
      x: fix(p.viewport?.x, 0),
      y: fix(p.viewport?.y, 0),
      zoom: fix(p.viewport?.zoom, 1),
    },
    nodes: (p.nodes ?? []).map(n => ({
      ...n,
      x: fix(n.x, 0),
      y: fix(n.y, 0),
      w: fix(n.w, DEFAULT_NODE_W),
      h: fix(n.h, DEFAULT_NODE_H),
    })),
  }));
}

// setContentZoom adjusts a node's embedded-content zoom (clamped). Used by the
// node header A−/A+ buttons to enlarge/shrink the AI page inside the pane.
export function setContentZoom(projects: Project[], projectId: string, nodeId: string, zoom: number): Project[] {
  const z = Math.min(MAX_CONTENT_ZOOM, Math.max(MIN_CONTENT_ZOOM, Math.round(zoom * 100) / 100));
  return mapProject(projects, projectId, p => ({
    ...p,
    nodes: p.nodes.map(n => (n.id === nodeId ? { ...n, contentZoom: z } : n)),
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
