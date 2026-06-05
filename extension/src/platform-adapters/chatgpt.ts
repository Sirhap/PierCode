import { extractAllToolCalls, pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const chatGPTAdapter: PlatformAdapter = {
  name: 'chatgpt',
  match: () => location.hostname.includes('chatgpt.com') || location.hostname.includes('chat.openai.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  responseSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]',
  userSelector: '[data-message-author-role="user"]',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre' || tag === 'code' || tag === 'span' || tag === 'div' || tag === 'section') {
      const text = el.textContent || '';
      if (text.includes('"name"') && text.includes('"args"')) {
        const count = extractAllToolCalls(text, buf);
        if (count > 0) return true;
      }
    }

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '', true);
    }

    return false;
  }
};
