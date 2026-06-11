import { describe, expect, it } from 'vitest';
import { genSsxmod } from '../background/qwen-ssxmod';

describe('genSsxmod', () => {
  it('produces both itna cookies with the 1- prefix', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect(ssxmod_itna.startsWith('1-')).toBe(true);
    expect(ssxmod_itna2.startsWith('1-')).toBe(true);
  });

  it('produces ASCII-only output', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect([...ssxmod_itna].every(c => c.charCodeAt(0) < 128)).toBe(true);
    expect([...ssxmod_itna2].every(c => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('produces itna longer than itna2 (37-field vs 18-field)', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect(ssxmod_itna.length).toBeGreaterThan(ssxmod_itna2.length);
    expect(ssxmod_itna.length).toBeGreaterThan(300);
  });

  it('varies across calls (random hash fields + timestamp)', () => {
    const a = genSsxmod();
    const b = genSsxmod();
    expect(a.ssxmod_itna).not.toBe(b.ssxmod_itna);
  });
});
