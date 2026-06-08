import { describe, expect, it } from 'vitest';
import {
  partitionSpawnCalls,
  buildSubAgentMessage,
  shapeSubAgentResult,
} from '../background/chat-api';

describe('sub-agent helpers', () => {
  it('partitions spawn_agent calls from normal tool calls', () => {
    const calls = [
      { name: 'read_file', args: { path: 'a' }, call_id: '1' },
      { name: 'spawn_agent', args: { task: 'review', label: 'rev' }, call_id: '2' },
    ];
    const { spawns, normal } = partitionSpawnCalls(calls);
    expect(spawns.map(c => c.call_id)).toEqual(['2']);
    expect(normal.map(c => c.call_id)).toEqual(['1']);
  });

  it('builds a worker message from prompt + task', () => {
    const msg = buildSubAgentMessage('WORKER PROMPT', 'do the thing');
    expect(msg).toContain('WORKER PROMPT');
    expect(msg).toContain('do the thing');
  });

  it('shapes a sub-agent final text into a tool result', () => {
    const r = shapeSubAgentResult({ name: 'spawn_agent', args: { label: 'rev' }, call_id: '2' }, 'done: 3 bugs');
    expect(r.call_id).toBe('2');
    expect(r.success).toBe(true);
    expect(r.output).toContain('done: 3 bugs');
  });
});
