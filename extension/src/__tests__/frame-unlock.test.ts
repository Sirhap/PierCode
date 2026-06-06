import { describe, it, expect } from 'vitest';
import { AI_FRAME_HOSTS, buildFrameUnlockRules } from '../background/frame-unlock';

describe('buildFrameUnlockRules', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop'; // extension hostname (id)

  it('strips X-Frame-Options and CSP on AI sub_frame responses', () => {
    const rules = buildFrameUnlockRules(AI_FRAME_HOSTS, EXT, 130);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const removed = (rule.action.responseHeaders || []).filter(h => h.operation === 'remove').map(h => h.header.toLowerCase());
      expect(removed).toContain('x-frame-options');
      expect(removed).toContain('content-security-policy');
      expect(rule.condition.resourceTypes).toContain('sub_frame');
    }
  });

  it('disguises the request as a top-level document navigation', () => {
    const [rule] = buildFrameUnlockRules(['claude.ai'], EXT, 130);
    const set = (rule.action.requestHeaders || []).filter(h => h.operation === 'set');
    const byName = Object.fromEntries(set.map(h => [h.header.toLowerCase(), h.value]));
    expect(byName['sec-fetch-dest']).toBe('document');
    expect(byName['sec-fetch-site']).toBe('same-origin');
  });

  it('SECURITY: scopes rules to the extension initiator only, never broadly', () => {
    const rules = buildFrameUnlockRules(['claude.ai', 'chatgpt.com'], EXT, 130);
    for (const rule of rules) {
      // Must be scoped so a user browsing the AI site normally keeps XFO/CSP.
      expect(rule.condition.initiatorDomains).toEqual([EXT]);
      expect(rule.condition.requestDomains).toBeDefined();
    }
  });

  it('targets the given AI hosts via requestDomains', () => {
    const rules = buildFrameUnlockRules(['claude.ai', 'chatgpt.com'], EXT, 130);
    const domains = rules.flatMap(r => r.condition.requestDomains || []);
    expect(domains).toContain('claude.ai');
    expect(domains).toContain('chatgpt.com');
  });

  it('assigns unique positive rule ids', () => {
    const rules = buildFrameUnlockRules(AI_FRAME_HOSTS, EXT, 130);
    const ids = rules.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBeGreaterThan(0);
  });

  it('Firefox legacy (<101): also sets condition.domains for the initiator', () => {
    const [ff] = buildFrameUnlockRules(['claude.ai'], EXT, 100);
    expect(ff.condition.domains).toEqual([EXT]);
    const [modern] = buildFrameUnlockRules(['claude.ai'], EXT, 130);
    expect(modern.condition.domains).toBeUndefined();
  });

  it('AI_FRAME_HOSTS lists the bare hostnames of supported sites', () => {
    expect(AI_FRAME_HOSTS).toContain('claude.ai');
    expect(AI_FRAME_HOSTS).toContain('chatgpt.com');
    expect(AI_FRAME_HOSTS).toContain('chat.qwen.ai');
    // bare hostnames, not match patterns
    for (const h of AI_FRAME_HOSTS) expect(h).not.toMatch(/[*:/]/);
  });
});
