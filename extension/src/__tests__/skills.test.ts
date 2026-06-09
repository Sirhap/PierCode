import { describe, expect, it } from 'vitest';
import { filterUserVisibleSkills, isPierCodeSkill } from '../skills';

describe('skill visibility helpers', () => {
  it('recognizes piercode-prefixed skills', () => {
    expect(isPierCodeSkill({ name: 'piercode-debug', description: '' })).toBe(true);
    expect(isPierCodeSkill({ name: ' PierCode-Safe-Shell ', description: '' })).toBe(true);
    expect(isPierCodeSkill({ name: 'deploy', description: '' })).toBe(false);
  });

  it('hides internal piercode-* skills, keeping user-created skills', () => {
    const visible = filterUserVisibleSkills([
      { name: 'piercode-self-dev', description: 'internal' },
      { name: 'brainstorming', description: 'user skill' },
      { name: 'deploy', description: 'user skill' },
      { name: 'piercode-code-review', description: 'internal' },
    ]);

    expect(visible.map(skill => skill.name)).toEqual(['brainstorming', 'deploy']);
  });
});
