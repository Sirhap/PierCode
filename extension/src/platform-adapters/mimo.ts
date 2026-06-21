import { attachCompletionDetection } from './completion';
import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const mimoAdapter: PlatformAdapter = {
  name: 'mimo',
  match: () => location.hostname.includes('aistudio.xiaomimimo.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  // #15: Mimo's send and stop share one button (told apart only by an inner SVG
  // viewBox), so completion is easy to misjudge — gate on the stop control going
  // away plus the shared settle + signature.
  ...attachCompletionDetection(),
  responseSelector: '.markdown-prose',
  extractText: (el: Element, buf: string[]): boolean => {
    const pre = el.closest('pre[data-testid="shiki-container"]') || (el.tagName.toLowerCase() === 'pre' ? el : null);
    if (pre) {
      const label = pre.querySelector('.languageLabel');
      if (label && (label.textContent || '').trim().toLowerCase() === 'piercode') {
        const code = pre.querySelector('code');
        const text = code ? (code.textContent || '').trim() : (pre.textContent || '').trim();
        if (text) {
          pushPierCodeTool(buf, text);
          return true;
        }
      }
    }

    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();
    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '', true);
    }

    return false;
  }
};
