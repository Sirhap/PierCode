import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const kimiAdapter: PlatformAdapter = {
  name: 'kimi',
  match: () => location.hostname.includes('kimi.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  responseSelector: '.segment-assistant',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (classAttr.includes('toolcall-container')) {
      return true;
    }

    if (classAttr.includes('kimi-m-code-block') &&
        (classAttr.includes('piercode-tool') || /\btool\b/.test(classAttr))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    return false;
  }
};
