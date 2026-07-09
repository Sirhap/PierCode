// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasBrowserAgentSentinel } from '../content/browser-agent-bridge';

// hasBrowserAgentSentinel must report ONLY the explicit ?piercode_browser_agent=
// sentinel (URL query or its persisted sessionStorage copy) — never a host
// fallback. This is the discriminator that separates the side-panel browser-agent
// qwen iframe (carries the sentinel) from the offscreen hidden qwen iframe (bare
// https://chat.qwen.ai/, no sentinel). isOffscreenHostedFrame() relies on it so
// the side-panel frame is NOT hijacked into the offscreen-relay role — the bug
// where the qwen browser-agent iframe showed no ⌁初始化 button / ran no bootstrap.
describe('hasBrowserAgentSentinel (offscreen vs side-panel qwen iframe discriminator)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    try { window.sessionStorage.clear(); } catch { /* no storage */ }
  });

  it('true when the sentinel is present in the URL query (side-panel AiFrame)', () => {
    vi.stubGlobal('location', { search: '?piercode_browser_agent=qwen' } as Location);
    expect(hasBrowserAgentSentinel()).toBe(true);
  });

  it('true when the sentinel was persisted to sessionStorage but stripped from the URL', () => {
    vi.stubGlobal('location', { search: '' } as Location);
    window.sessionStorage.setItem('piercode_browser_agent_platform', 'qwen');
    expect(hasBrowserAgentSentinel()).toBe(true);
  });

  it('false for a bare qwen URL with no sentinel anywhere (offscreen hidden iframe)', () => {
    vi.stubGlobal('location', { search: '' } as Location);
    expect(hasBrowserAgentSentinel()).toBe(false);
  });

  it('false when the query has unrelated params only', () => {
    vi.stubGlobal('location', { search: '?foo=bar&baz=1' } as Location);
    expect(hasBrowserAgentSentinel()).toBe(false);
  });
});
