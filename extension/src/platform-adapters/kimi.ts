import { attachCompletionDetection } from './completion';
import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const kimiAdapter: PlatformAdapter = {
  name: 'kimi',
  match: () => location.hostname.includes('kimi.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  // #15: batch a multi-tool turn's results into one reply — see claude.ts.
  ...attachCompletionDetection(),
  responseSelector: '.segment-assistant',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (classAttr.includes('toolcall-container')) {
      const text = el.textContent || '';
      if (text.trim()) pushPierCodeTool(buf, text);
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
