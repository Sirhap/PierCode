import { describe, expect, it } from 'vitest';
import { classifyCompletion } from '../sidebar/completions';

describe('classifyCompletion', () => {
  it('classifies a trailing /skill token', () => {
    expect(classifyCompletion('do /rev')).toEqual({ mode: 'skills', token: '/rev', query: 'rev' });
  });

  it('classifies @@ before @ (agents, not files)', () => {
    expect(classifyCompletion('ping @@rev')).toEqual({ mode: 'agents', token: '@@rev', query: 'rev' });
  });

  it('classifies a bare @file token', () => {
    expect(classifyCompletion('open @src/a')).toEqual({ mode: 'files', token: '@src/a', query: 'src/a' });
  });

  it('returns null when no trailing trigger', () => {
    expect(classifyCompletion('hello world')).toBeNull();
  });

  it('empty @@ yields empty query', () => {
    expect(classifyCompletion('@@')).toEqual({ mode: 'agents', token: '@@', query: '' });
  });
});
