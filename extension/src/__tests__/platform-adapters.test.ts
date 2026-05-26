import { describe, expect, it } from 'vitest';
import { defaultAdapter, getAdapterProfileName, platformAdapters, qwenAdapter } from '../platform-adapters';

describe('platform adapter registry', () => {
  it('keeps adapter profile names explicit and default-safe', () => {
    expect(getAdapterProfileName(qwenAdapter)).toBe('qwen');
    expect(getAdapterProfileName({ ...defaultAdapter, profile: '' })).toBe('default');
  });

  it('keeps default adapter last because it always matches', () => {
    expect(platformAdapters[platformAdapters.length - 1]?.name).toBe('default');
  });
});
