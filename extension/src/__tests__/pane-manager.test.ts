import { describe, it, expect } from 'vitest';
import { addPane, removePane, movePane, paneSrc, PROVIDERS, type Pane } from '../hub/pane-manager';
import { AI_FRAME_HOSTS } from '../background/frame-unlock';

describe('pane-manager', () => {
  it('paneSrc returns the provider home url for a normal pane', () => {
    expect(paneSrc({ key: 'qwen', providerId: 'qwen' })).toBe('https://chat.qwen.ai/');
  });

  it('paneSrc appends ?piercode_agent for a worker pane', () => {
    const src = paneSrc({ key: 'qwen:a1', providerId: 'qwen', agentId: 'agent-1' });
    expect(new URL(src).searchParams.get('piercode_agent')).toBe('agent-1');
  });

  it('addPane is idempotent for a non-worker provider', () => {
    let panes: Pane[] = [];
    panes = addPane(panes, 'claude');
    panes = addPane(panes, 'claude');
    expect(panes.filter(p => p.providerId === 'claude')).toHaveLength(1);
  });

  it('addPane allows multiple worker panes of the same provider', () => {
    let panes: Pane[] = [];
    panes = addPane(panes, 'qwen', 'agent-1');
    panes = addPane(panes, 'qwen', 'agent-2');
    expect(panes).toHaveLength(2);
    expect(panes.map(p => p.agentId)).toEqual(['agent-1', 'agent-2']);
  });

  it('addPane ignores unknown providers', () => {
    expect(addPane([], 'nope')).toHaveLength(0);
  });

  it('removePane drops by key', () => {
    const panes: Pane[] = [{ key: 'a', providerId: 'qwen' }, { key: 'b', providerId: 'claude' }];
    expect(removePane(panes, 'a')).toEqual([{ key: 'b', providerId: 'claude' }]);
  });

  it('movePane reorders and clamps', () => {
    const panes: Pane[] = [{ key: 'a', providerId: 'qwen' }, { key: 'b', providerId: 'claude' }, { key: 'c', providerId: 'chatgpt' }];
    expect(movePane(panes, 0, 2).map(p => p.key)).toEqual(['b', 'c', 'a']);
    expect(movePane(panes, 2, 99).map(p => p.key)).toEqual(['a', 'b', 'c']); // clamp, no-op
    expect(movePane(panes, 5, 0)).toBe(panes); // out of range
  });

  it('every provider host is unlocked by the DNR frame rules', () => {
    for (const p of PROVIDERS) {
      expect(AI_FRAME_HOSTS).toContain(p.host);
    }
  });
});
