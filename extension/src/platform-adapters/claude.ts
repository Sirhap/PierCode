import { pushPierCodeAgentResult, pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const claudeAdapter: PlatformAdapter = {
  name: 'claude',
  match: () => location.hostname.includes('claude.ai') || location.hostname.includes('free.easychat.top'),
  newSessionUrl: () => `${location.protocol}//${location.host}/new`,
  responseSelector: '.font-claude-response, .standard-markdown',
  userSelector: '[data-testid="user-message"], .font-user-message',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre') {
      // Check for agent-result first (more specific)
      const agentResultCode = el.querySelector('code[class*="language-piercode-agent-result"]');
      if (agentResultCode) {
        return pushPierCodeAgentResult(buf, agentResultCode.textContent || '');
      }
      const code = el.querySelector('code[class*="language-piercode-tool"], code[class*="language-piercode"], code[class*="language-tool"]');
      if (!code) return false;
      pushPierCodeTool(buf, code.textContent || '');
      return true;
    }

    if (tag === 'code') {
      if (classAttr.includes('language-piercode-agent-result')) {
        return pushPierCodeAgentResult(buf, el.textContent || '');
      }
      if (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool')) {
        return pushPierCodeTool(buf, el.textContent || '');
      }
    }

    return false;
  }
};
