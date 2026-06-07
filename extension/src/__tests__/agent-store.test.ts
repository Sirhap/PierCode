import { describe, it, expect } from 'vitest';
import {
  AgentVM,
  mergeSummaries,
  replaceAll,
  reconcilePoll,
  sortAgents,
  computeStats,
  buildAgentTree,
  flattenTree,
} from '../hub/dashboard/agent-store';

function vm(id: string, status: string, created: string, extra: Partial<AgentVM> = {}): AgentVM {
  return { agent_id: id, status, created_at: created, ...extra };
}

describe('agent-store', () => {
  it('mergeSummaries keeps prior agents and lets incoming win by id', () => {
    const prev = [vm('a', 'running', '2026-06-07T00:00:00Z'), vm('b', 'pending', '2026-06-07T00:01:00Z')];
    const incoming = [vm('a', 'completed', '2026-06-07T00:00:00Z')];
    const merged = mergeSummaries(prev, incoming);
    const byId = Object.fromEntries(merged.map(m => [m.agent_id, m]));
    expect(byId['a'].status).toBe('completed'); // incoming won
    expect(byId['b'].status).toBe('pending'); // retained, not dropped
    expect(merged.length).toBe(2);
  });

  it('mergeSummaries ignores entries without an agent_id', () => {
    const merged = mergeSummaries([], [vm('a', 'running', 'x'), { status: 'running', created_at: 'x' } as AgentVM]);
    expect(merged.length).toBe(1);
  });

  it('replaceAll drops agents not in the authoritative batch', () => {
    const prevKnown = [vm('a', 'running', 'x'), vm('b', 'running', 'y')];
    // replaceAll only sees the batch; b is gone from the server roster.
    const next = replaceAll([prevKnown[0]]);
    expect(next.map(a => a.agent_id)).toEqual(['a']);
  });

  it('reconcilePoll keeps a just-pushed local agent the poll has not indexed yet', () => {
    const prev = [vm('a', 'running', 'x'), vm('fresh', 'pending', 'z')];
    // Poll only knows 'a'. 'fresh' was pushed via WS very recently → kept.
    const keep = reconcilePoll(prev, [vm('a', 'completed', 'x')], a => a.agent_id === 'fresh');
    expect(keep.map(a => a.agent_id).sort()).toEqual(['a', 'fresh']);
    // Poll record wins for 'a' (fresher status).
    expect(keep.find(a => a.agent_id === 'a')!.status).toBe('completed');
  });

  it('reconcilePoll drops a stale local agent the poll omits', () => {
    const prev = [vm('a', 'running', 'x'), vm('gone', 'completed', 'z')];
    const next = reconcilePoll(prev, [vm('a', 'running', 'x')], () => false);
    expect(next.map(a => a.agent_id)).toEqual(['a']);
  });

  it('sortAgents puts active (running/pending) first, then newest-first', () => {
    const list = [
      vm('done-old', 'completed', '2026-06-07T00:00:00Z'),
      vm('run-old', 'running', '2026-06-07T00:01:00Z'),
      vm('run-new', 'running', '2026-06-07T00:05:00Z'),
      vm('done-new', 'completed', '2026-06-07T00:06:00Z'),
    ];
    expect(sortAgents(list).map(a => a.agent_id)).toEqual([
      'run-new',
      'run-old',
      'done-new',
      'done-old',
    ]);
  });

  it('buildAgentTree nests children under parents by parent_agent_id', () => {
    const list = [
      vm('root', 'running', '2026-06-07T00:00:00Z'),
      vm('child-a', 'running', '2026-06-07T00:01:00Z', { parent_agent_id: 'root' }),
      vm('child-b', 'completed', '2026-06-07T00:02:00Z', { parent_agent_id: 'root' }),
      vm('grand', 'pending', '2026-06-07T00:03:00Z', { parent_agent_id: 'child-a' }),
    ];
    const tree = buildAgentTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent_id).toBe('root');
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children.map(c => c.agent_id)).toEqual(['child-a', 'child-b']);
    expect(tree[0].children[0].children[0].agent_id).toBe('grand');
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('buildAgentTree surfaces an orphan (parent filtered out) as a root', () => {
    const tree = buildAgentTree([vm('lonely', 'running', 'x', { parent_agent_id: 'gone' })]);
    expect(tree.map(t => t.agent_id)).toEqual(['lonely']);
    expect(tree[0].depth).toBe(0);
  });

  it('buildAgentTree is cycle-safe', () => {
    const tree = buildAgentTree([
      vm('a', 'running', 'x', { parent_agent_id: 'b' }),
      vm('b', 'running', 'x', { parent_agent_id: 'a' }),
    ]);
    // Both reference each other; must not infinite-loop and must terminate.
    expect(flattenTree(tree).length).toBeGreaterThan(0);
  });

  it('flattenTree yields pre-order (parent before children)', () => {
    const list = [
      vm('root', 'running', '2026-06-07T00:00:00Z'),
      vm('child', 'running', '2026-06-07T00:01:00Z', { parent_agent_id: 'root' }),
    ];
    expect(flattenTree(buildAgentTree(list)).map(n => n.agent_id)).toEqual(['root', 'child']);
  });

  it('computeStats counts each status bucket', () => {
    const stats = computeStats([
      vm('1', 'running', 'x'),
      vm('2', 'running', 'x'),
      vm('3', 'pending', 'x'),
      vm('4', 'completed', 'x'),
      vm('5', 'failed', 'x'),
      vm('6', 'blocked', 'x'),
      vm('7', 'stopped', 'x'),
    ]);
    expect(stats).toEqual({
      total: 7,
      running: 2,
      pending: 1,
      completed: 1,
      failed: 1,
      blocked: 1,
      stopped: 1,
    });
  });
});
