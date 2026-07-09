import { attachCompletionDetection } from './completion';
import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const defaultAdapter: PlatformAdapter = {
  name: 'default',
  match: () => true,
  // #15: batch a multi-tool turn's results into one reply — see claude.ts.
  ...attachCompletionDetection(),
  responseSelector: 'message-content, .prose, .chat-content',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    if (classAttr.includes('code') &&
        (classAttr.includes('piercode-tool') || /\btool\b/.test(classAttr)) &&
        !classAttr.includes('hljs')) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    return false;
  }
};
