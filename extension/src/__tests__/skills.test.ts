import { describe, expect, it } from 'vitest';
import { filterUserVisibleSkills, isBuiltInPierCodeSkill } from '../skills';

describe('skill visibility helpers', () => {
  it('treats piercode-prefixed skills as built in', () => {
    expect(isBuiltInPierCodeSkill({ name: 'piercode-debug', description: '' })).toBe(true);
    expect(isBuiltInPierCodeSkill({ name: ' PierCode-Safe-Shell ', description: '' })).toBe(true);
    expect(isBuiltInPierCodeSkill({ name: 'deploy', description: '' })).toBe(false);
  });

  it('hides built-in PierCode skills from the slash picker list', () => {
    const visible = filterUserVisibleSkills([
      { name: 'piercode-self-dev', description: 'internal' },
      { name: 'deploy', description: 'custom deploy workflow' },
      { name: 'docs', description: 'custom docs workflow' },
      { name: 'piercode-code-review', description: 'internal' },
    ]);

    expect(visible.map(skill => skill.name)).toEqual(['deploy', 'docs']);
  });
});
