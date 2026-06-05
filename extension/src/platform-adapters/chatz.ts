import { extractCodeMirror6Text, pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const chatZAdapter: PlatformAdapter = {
  name: 'chatz',
  match: () => location.hostname.includes('chat.z.ai'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  responseSelector: '#response-content-container',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (classAttr.includes('language-piercode-tool') || classAttr.includes('language-tool')) {
      const codeText = extractCodeMirror6Text(el);
      if (codeText) {
        pushPierCodeTool(buf, codeText);
        return true;
      }
    }

    if (classAttr.includes('cm-editor') || classAttr.includes('cm-content')) {
      return true;
    }

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    return false;
  }
};
