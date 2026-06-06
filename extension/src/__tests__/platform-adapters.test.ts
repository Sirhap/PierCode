import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chatGPTAdapter,
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

describe('chatgpt adapter extraction', () => {
  it('preserves piercode-agent-result code fences for worker callbacks', () => {
    const el = {
      tagName: 'CODE',
      getAttribute: (name: string) => name === 'class' ? 'language-piercode-agent-result' : '',
      textContent: '{"version":1,"agent_id":"agent-1","status":"blocked","summary":"x","result":"y"}',
    } as unknown as Element;

    const buf: string[] = [];
    expect(chatGPTAdapter.extractText?.(el, buf)).toBe(true);
    expect(buf.join('')).toContain('```piercode-agent-result');
    expect(buf.join('')).toContain('"agent_id":"agent-1"');
  });
});
