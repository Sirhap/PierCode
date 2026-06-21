import { attachCompletionDetection } from './completion';
import {
  extractMonacoText,
  hasPierCodeAgentResultClass,
  hasPierCodeToolClass,
  looksLikePierCodeAgentResultLanguage,
  looksLikePierCodeLanguage,
  pushPierCodeAgentResult,
  pushPierCodeTool
} from './shared';
import type { PlatformAdapter } from './types';

type QwenPierCodeKind = 'tool' | 'agent-result';

function qwenPierCodeKindFromText(text: string): QwenPierCodeKind | null {
  if (looksLikePierCodeAgentResultLanguage(text)) return 'agent-result';
  if (looksLikePierCodeLanguage(text)) return 'tool';
  return null;
}

function qwenPierCodeKindFromClass(classAttr: string): QwenPierCodeKind | null {
  if (hasPierCodeAgentResultClass(classAttr)) return 'agent-result';
  if (hasPierCodeToolClass(classAttr)) return 'tool';
  return null;
}

function pushQwenPierCodeBlock(buf: string[], kind: QwenPierCodeKind, text: string): boolean {
  return kind === 'agent-result'
    ? pushPierCodeAgentResult(buf, text)
    : pushPierCodeTool(buf, text);
}

export function findQwenPierCodeBody(pre: Element): { body: Element; kind: QwenPierCodeKind } | null {
  const directBody = pre.querySelector('.qwen-markdown-code-body');
  if (!directBody) return null;

  const bodyKind = qwenPierCodeKindFromClass(directBody.getAttribute('class') || '');
  if (bodyKind) return { body: directBody, kind: bodyKind };

  const headerText = pre.querySelector('.qwen-markdown-code-header, .qwen-markdown-code-header-wrapper')?.textContent || '';
  const headerKind = qwenPierCodeKindFromText(headerText);
  if (headerKind) return { body: directBody, kind: headerKind };

  return null;
}

export function findQwenToolBody(pre: Element): Element | null {
	const block = findQwenPierCodeBody(pre);
	return block?.kind === 'tool' ? block.body : null;
}

export const qwenAdapter: PlatformAdapter = {
  name: 'qwen',
  match: () => location.hostname.includes('qwen.ai') || location.hostname.includes('qwenlm.ai'),
  newSessionUrl: () => `${location.protocol}//${location.host}/`,
  // #15: Qwen keeps the stop button in the DOM after streaming (just disabled),
  // and Monaco virtualization makes text jitter — both invite false completion.
  // Use the shared stop-gone + settle + signature timing.
  ...attachCompletionDetection(),
  responseSelector: '.qwen-chat-message-assistant, .response-message-content.phase-answer',
  userSelector: '.qwen-chat-message-user, .user-message',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre' && classAttr.includes('qwen-markdown-code')) {
	      const block = findQwenPierCodeBody(el);
	      if (!block) return false;

	      const codeText = extractMonacoText(block.body);
	      pushQwenPierCodeBlock(buf, block.kind, codeText.text);
      return true;
    }

	    if (classAttr.includes('qwen-markdown-code-body')) {
	      const kind = qwenPierCodeKindFromClass(classAttr);
	      if (!kind) return false;
      const codeText = extractMonacoText(el);
	      pushQwenPierCodeBlock(buf, kind, codeText.text);
      return true;
    }

    return false;
  }
};
