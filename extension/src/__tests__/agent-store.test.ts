import { describe, it, expect } from 'vitest';
import {
  AgentVM,
  mergeSummaries,
  replaceAll,
  sortAgents,
  computeStats,
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
