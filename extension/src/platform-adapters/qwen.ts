import { extractMonacoText, hasPierCodeToolClass, looksLikePierCodeLanguage, pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export function findQwenToolBody(pre: Element): Element | null {
  const directBody = pre.querySelector('.qwen-markdown-code-body');
  if (!directBody) return null;

  const bodyClass = directBody.getAttribute('class') || '';
  if (hasPierCodeToolClass(bodyClass)) return directBody;

  const headerText = pre.querySelector('.qwen-markdown-code-header, .qwen-markdown-code-header-wrapper')?.textContent || '';
  if (looksLikePierCodeLanguage(headerText)) return directBody;

  return null;
}

export const qwenAdapter: PlatformAdapter = {
  name: 'qwen',
  match: () => location.hostname.includes('qwen.ai') || location.hostname.includes('qwenlm.ai'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  responseSelector: '.qwen-chat-message-assistant, .response-message-content.phase-answer',
  userSelector: '.qwen-chat-message-user, .user-message',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre' && classAttr.includes('qwen-markdown-code')) {
      const toolBody = findQwenToolBody(el);
      if (!toolBody) return false;

      const codeText = extractMonacoText(toolBody);
      pushPierCodeTool(buf, codeText.text);
      return true;
    }

    if (classAttr.includes('qwen-markdown-code-body') &&
        hasPierCodeToolClass(classAttr)) {
      const codeText = extractMonacoText(el);
      pushPierCodeTool(buf, codeText.text);
      return true;
    }

    return false;
  }
};
