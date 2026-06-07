import { describe, expect, it } from 'vitest';
import wsLinkerSource from '../content/ws-linker.ts?raw';
import contentSource from '../content/index.ts?raw';

describe('Qwen worker send focus behavior', () => {
  it('forces real window focus before server-driven inject and worker/Qwen send', () => {
    expect(wsLinkerSource).toContain('chrome.runtime.sendMessage({ type: "FOCUS_SELF", forceFocus: true })');
    expect(wsLinkerSource).not.toContain('chrome.runtime.sendMessage({ type: "FOCUS_SELF", forceFocus: false })');
    expect(contentSource).toContain("chrome.runtime.sendMessage({ type: 'FOCUS_SELF', forceFocus: true })");
    expect(contentSource).not.toContain("chrome.runtime.sendMessage({ type: 'FOCUS_SELF', forceFocus: false })");
  });

  it('does not treat disabled visible Qwen send controls as actionable', () => {
    expect(wsLinkerSource).toContain('function isActionableSendButton');
    expect(wsLinkerSource).toContain('target.getAttribute("aria-disabled") === "true"');
    expect(wsLinkerSource).toContain('target.hasAttribute("disabled")');
    expect(wsLinkerSource).toContain('/\\bdisabled\\b/i.test(className)');
    expect(wsLinkerSource).toContain('querySendButtonFirst(config.sendBtn)');
    expect(wsLinkerSource).not.toContain('querySelectorFirst(config.sendBtn)');
  });
});
