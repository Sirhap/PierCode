import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const geminiAdapter: PlatformAdapter = {
  name: 'gemini',
  match: () => location.hostname.includes('gemini.google.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/app`,
  responseSelector: 'message-content, .model-response-text',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    return false;
  }
};
