import { describe, expect, it } from 'vitest';
import { browserRelayWsUrl, isAiPageUrl } from '../background/browser-relay-utils';

describe('browser relay utils', () => {
  it('builds background browser relay websocket URLs', () => {
    const url = browserRelayWsUrl('http://127.0.0.1:39527', 'secret-token');
    expect(url).toBe('ws://127.0.0.1:39527/ws?token=secret-token&client=background&role=browser-relay&provider=Extension');
  });

  it('detects AI conversation pages', () => {
    expect(isAiPageUrl('https://chatgpt.com/c/123')).toBe(true);
    expect(isAiPageUrl('https://foo.claude.ai/chat')).toBe(true);
    expect(isAiPageUrl('https://github.com/Sirhap/PierCode')).toBe(false);
  });
});
