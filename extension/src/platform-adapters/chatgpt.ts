import { attachCompletionDetection } from './completion';
import { extractAllToolCalls, pushPierCodeAgentResult, pushPierCodeTool } from './shared';
import type { PlatformAdapter } from './types';

export const chatGPTAdapter: PlatformAdapter = {
  name: 'chatgpt',
  match: () => location.hostname.includes('chatgpt.com') || location.hostname.includes('chat.openai.com'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  // #15: ChatGPT streams token-by-token with frequent micro-pauses; the stop
  // button toggles to a send button on completion. Settle + signature avoids
  // firing on a mid-stream pause.
  ...attachCompletionDetection(),
  responseSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]',
  userSelector: '[data-message-author-role="user"]',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre' || tag === 'code') {
      const text = el.textContent || '';
      if (text.includes('"name"') && text.includes('"args"')) {
        const count = extractAllToolCalls(text, buf);
        if (count > 0) return true;
      }
    }

    if ((tag === 'pre' || tag === 'code') && classAttr.includes('language-piercode-agent-result')) {
      return pushPierCodeAgentResult(buf, el.textContent || '', true);
    }

    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-piercode-tool') || classAttr.includes('language-piercode') || classAttr.includes('language-tool'))) {
      return pushPierCodeTool(buf, el.textContent || '', true);
    }

    return false;
  }
};
