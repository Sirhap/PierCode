// project-store: the pure model behind the Hub grid. A "project" groups AI
// nodes (panes); a node is one embedded AI site (its iframe). Main agents are
// root nodes the user adds; spawned sub-agents are child nodes wired under
// their parent. Free of DOM / chrome / React so it is unit-testable; the
// React + storage layers build on it.

import { PROVIDERS_BY_ID } from './pane-manager';

export interface CanvasNode {
  id: string;         // unique node id
  providerId: string; // qwen/claude/... (key into PROVIDERS)
  agentId?: string;   // set for sub-agent (worker) nodes; carried into the iframe src
  parentNodeId?: string; // the node that spawned this one
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  nodes: CanvasNode[];
}

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

// addNode adds a root (main-agent) node for a provider. Unknown providers are
// ignored (returns the list unchanged).
export function addNode(
  projects: Project[],
  projectId: string,
  providerId: string,
): Project[] {
  if (!PROVIDERS_BY_ID[providerId]) return projects;
  return mapProject(projects, projectId, p => {
    const node: CanvasNode = {
      id: uid('node'),
      providerId,
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
    const node: CanvasNode = {
      id: uid('node'),
      providerId: args.providerId,
      agentId: args.agentId,
      parentNodeId: parentNode?.id,
    };
    return { ...p, nodes: [...p.nodes, node] };
  });
}

export function removeNode(projects: Project[], projectId: string, nodeId: string): Project[] {
  return mapProject(projects, projectId, p => ({
    ...p,
    // Removing a node also detaches its children's parent link so no dangling refs remain.
    nodes: p.nodes
      .filter(n => n.id !== nodeId)
      .map(n => (n.parentNodeId === nodeId ? { ...n, parentNodeId: undefined } : n)),
  }));
}

// normalizeProjects heals persisted data: strips any unrecognised fields and
// ensures required fields are present. Pure; returns a cleaned copy.
export function normalizeProjects(projects: Project[]): Project[] {
  return projects.map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    nodes: (p.nodes ?? []).map(n => ({
      id: n.id,
      providerId: n.providerId,
      ...(n.agentId !== undefined ? { agentId: n.agentId } : {}),
      ...(n.parentNodeId !== undefined ? { parentNodeId: n.parentNodeId } : {}),
    })),
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

// Legacy migration: v1 stored a flat `hubPanes` list (one AI per column, no
// canvas). On first v2 load with panes but no projects, fold them into one
// "默认项目" as root nodes so the user doesn't lose their layout.
export function migrateLegacyPanes(panes: Array<{ providerId: string; agentId?: string }>): Project[] {
  const project = createProject('默认项目');
  for (const pane of panes) {
    if (!PROVIDERS_BY_ID[pane.providerId]) continue;
    project.nodes.push({
      id: uid('node'),
      providerId: pane.providerId,
      ...(pane.agentId !== undefined ? { agentId: pane.agentId } : {}),
    });
  }
  return [project];
}
