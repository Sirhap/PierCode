import { describe, it, expect } from 'vitest';
import {
  createProject,
  deleteProject,
  renameProject,
  addNode,
  addChildNode,
  removeNode,
  moveNode,
  migrateLegacyPanes,
  type Project,
} from '../hub/project-store';

function withRoot(): { projects: Project[]; pid: string; rootId: string } {
  let projects = [createProject('p')];
  const pid = projects[0].id;
  projects = addNode(projects, pid, 'qwen');
  const rootId = projects[0].nodes[0].id;
  return { projects, pid, rootId };
}

describe('project-store', () => {
  it('createProject yields an empty canvas with a default viewport', () => {
    const p = createProject('demo');
    expect(p.name).toBe('demo');
    expect(p.nodes).toEqual([]);
    expect(p.viewport.zoom).toBe(1);
  });

  it('rename/delete project', () => {
    let projects = [createProject('a'), createProject('b')];
    const id = projects[0].id;
    projects = renameProject(projects, id, 'renamed');
    expect(projects.find(p => p.id === id)!.name).toBe('renamed');
    projects = deleteProject(projects, id);
    expect(projects.find(p => p.id === id)).toBeUndefined();
  });

  it('addNode adds a root node for a known provider, ignores unknown', () => {
    let projects = [createProject('p')];
    const pid = projects[0].id;
    projects = addNode(projects, pid, 'qwen');
    projects = addNode(projects, pid, 'nope');
    expect(projects[0].nodes).toHaveLength(1);
    expect(projects[0].nodes[0].parentNodeId).toBeUndefined();
  });

  it('addChildNode wires a sub-agent under its parent agent', () => {
    let { projects, pid, rootId } = withRoot();
    // Give the root an agentId so a child can target it by parent_agent_id.
    projects = projects.map(p => ({
      ...p,
      nodes: p.nodes.map(n => (n.id === rootId ? { ...n, agentId: 'parent-agent' } : n)),
    }));
    projects = addChildNode(projects, pid, { agentId: 'child-1', parentAgentId: 'parent-agent', providerId: 'claude' });
    const child = projects[0].nodes.find(n => n.agentId === 'child-1')!;
    expect(child.parentNodeId).toBe(rootId);
    expect(child.y).toBeGreaterThan(projects[0].nodes.find(n => n.id === rootId)!.y);
  });

  it('addChildNode falls back to the project root for a first-level spawn', () => {
    const { projects, pid, rootId } = withRoot();
    const next = addChildNode(projects, pid, { agentId: 'c', providerId: 'claude', fallbackParentNodeId: rootId });
    expect(next[0].nodes.find(n => n.agentId === 'c')!.parentNodeId).toBe(rootId);
  });

  it('addChildNode is idempotent on an existing agentId', () => {
    const { projects, pid, rootId } = withRoot();
    let next = addChildNode(projects, pid, { agentId: 'c', providerId: 'claude', fallbackParentNodeId: rootId });
    next = addChildNode(next, pid, { agentId: 'c', providerId: 'claude', fallbackParentNodeId: rootId });
    expect(next[0].nodes.filter(n => n.agentId === 'c')).toHaveLength(1);
  });

  it('removeNode detaches its children parent link', () => {
    let { projects, pid, rootId } = withRoot();
    projects = projects.map(p => ({ ...p, nodes: p.nodes.map(n => n.id === rootId ? { ...n, agentId: 'pa' } : n) }));
    projects = addChildNode(projects, pid, { agentId: 'c', parentAgentId: 'pa', providerId: 'claude' });
    projects = removeNode(projects, pid, rootId);
    expect(projects[0].nodes.find(n => n.id === rootId)).toBeUndefined();
    expect(projects[0].nodes.find(n => n.agentId === 'c')!.parentNodeId).toBeUndefined();
  });

  it('moveNode updates coordinates', () => {
    const { projects, pid, rootId } = withRoot();
    const next = moveNode(projects, pid, rootId, 123, 456);
    expect(next[0].nodes[0]).toMatchObject({ x: 123, y: 456 });
  });

  it('migrateLegacyPanes folds flat panes into one default project', () => {
    const projects = migrateLegacyPanes([
      { providerId: 'qwen' },
      { providerId: 'claude', agentId: 'a1' },
      { providerId: 'bogus' }, // dropped
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0].nodes).toHaveLength(2);
    expect(projects[0].nodes[1].agentId).toBe('a1');
  });
});
