import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_EXECUTE, resolveAutoExecute } from '../settings';

describe('resolveAutoExecute', () => {
  it('defaults auto execution off when unset', () => {
    expect(DEFAULT_AUTO_EXECUTE).toBe(false);
    expect(resolveAutoExecute(undefined)).toBe(false);
    expect(resolveAutoExecute(null)).toBe(false);
  });

  it('preserves explicit user choices', () => {
    expect(resolveAutoExecute(true)).toBe(true);
    expect(resolveAutoExecute(false)).toBe(false);
  });
});
