import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  claudeAdapter,
  defaultAdapter,
  getAdapterNewSessionUrl,
  getAdapterProfileName,
  platformAdapters,
  qwenAdapter,
} from '../platform-adapters';

describe('platform adapter registry', () => {
  it('keeps adapter profile names explicit and default-safe', () => {
    expect(getAdapterProfileName(qwenAdapter)).toBe('qwen');
    expect(getAdapterProfileName({ ...defaultAdapter, profile: '' })).toBe('default');
  });

  it('keeps default adapter last because it always matches', () => {
    expect(platformAdapters[platformAdapters.length - 1]?.name).toBe('default');
  });
});

describe('adapter newSessionUrl', () => {
  // node 环境无全局 location，stub 一个固定 host 供 URL 拼接。
  beforeAll(() => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('uses adapter-specific path when defined', () => {
    expect(getAdapterNewSessionUrl(claudeAdapter)).toBe('http://localhost/new');
    expect(getAdapterNewSessionUrl(qwenAdapter)).toBe('http://localhost/');
  });

  it('every non-default adapter defines a newSessionUrl returning an absolute url', () => {
    for (const adapter of platformAdapters) {
      if (adapter.name === 'default') continue;
      expect(adapter.newSessionUrl, `${adapter.name} should define newSessionUrl`).toBeTypeOf('function');
      expect(getAdapterNewSessionUrl(adapter)).toMatch(/^https?:\/\//);
    }
  });

  it('falls back to host root when adapter has no newSessionUrl', () => {
    expect(getAdapterNewSessionUrl({})).toBe('http://localhost/');
  });
});
