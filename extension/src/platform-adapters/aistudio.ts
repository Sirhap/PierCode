import { attachCompletionDetection } from './completion';
import { pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const aiStudioAdapter: PlatformAdapter = {
  name: 'aistudio',
  match: () => location.hostname.includes('aistudio.google.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/prompts/new_chat`,
  // #15: AI Studio's Run/Stop are the SAME button distinguished only by text,
  // so CSS can't express the stop state cleanly (see PLATFORM_SELECTORS) — a
  // settle + signature transition is the reliable completion signal.
  ...attachCompletionDetection(),
  responseSelector: 'ms-chat-turn',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (classAttr.includes('monaco-editor') &&
        (classAttr.includes('piercode-tool') || classAttr.includes('language-piercode-tool'))) {
      const text = el.textContent || '';
      if (text.includes('"name"') && text.includes('"args"')) {
        pushPierCodeTool(buf, text);
        return true;
      }
    }

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '');
    }

    return false;
  }
};
