import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { chatGPTAdapter } from '../platform-adapters';

function extractWithChatGPTAdapter(el: Element): string {
  const buf: string[] = [];
  extractText(el, buf);
  return buf.join('');

  function extractText(node: Node, out: string[]): void {
    if (node.nodeType === 3) {
      out.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (chatGPTAdapter.extractText(child, out)) return;
    if (['P', 'DIV', 'BR', 'LI', 'PRE', 'BLOCKQUOTE'].includes(child.tagName)) out.push('\n');
    for (const next of child.childNodes) extractText(next, out);
  }
}

describe('ChatGPT DOM adapter', () => {
  it('matches the ChatGPT composer and assistant response selectors', () => {
    const dom = new JSDOM(`
      <div data-composer-surface="true">
        <textarea class="wcDTda_fallbackTextarea" name="prompt-textarea" style="display:none"></textarea>
        <div contenteditable="true" class="ProseMirror" id="prompt-textarea" role="textbox" aria-label="与 ChatGPT 聊天"></div>
      </div>
      <div data-message-author-role="assistant" data-message-id="msg-1">
        <div class="markdown prose">
          <p>你好！有什么我可以帮你的吗？</p>
        </div>
      </div>
    `);

    const editor = dom.window.document.querySelector('div#prompt-textarea.ProseMirror[contenteditable="true"]');
    const response = dom.window.document.querySelector(chatGPTAdapter.responseSelector);
    expect(editor).not.toBeNull();
    expect(response).not.toBeNull();
    expect(extractWithChatGPTAdapter(response!)).toContain('你好！有什么我可以帮你的吗？');
  });

  it('normalizes ChatGPT tool code blocks into openlink-tool fences', () => {
    const dom = new JSDOM(`
      <div data-message-author-role="assistant">
        <div class="markdown prose">
          <pre><code class="language-tool">{"name":"list_dir","call_id":"chatgpt1","args":{"path":"."}}</code></pre>
        </div>
      </div>
    `);

    const response = dom.window.document.querySelector(chatGPTAdapter.responseSelector)!;
    const text = extractWithChatGPTAdapter(response);
    expect(text).toContain('```openlink-tool');
    expect(text).toContain('"name":"list_dir"');
    expect(text).toContain('"path":"."');
  });
});
