import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { claudeAdapter } from '../platform-adapters';

function extractWithClaudeAdapter(el: Element): string {
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
    if (claudeAdapter.extractText(child, out)) return;
    if (['P', 'DIV', 'BR', 'LI', 'PRE', 'BLOCKQUOTE'].includes(child.tagName)) out.push('\n');
    for (const next of child.childNodes) extractText(next, out);
  }
}

describe('Claude DOM adapter', () => {
  it('matches the Claude response container selector', () => {
    const dom = new JSDOM(`
      <div data-is-streaming="false">
        <div class="font-claude-response relative leading-[1.65rem]">
          <div>
            <div class="standard-markdown grid-cols-1 grid standard-markdown">
              <p class="font-claude-response-body break-words whitespace-normal leading-[1.7]">你好！有什么我可以帮你的吗？</p>
            </div>
          </div>
        </div>
      </div>
    `);

    const response = dom.window.document.querySelector(claudeAdapter.responseSelector);
    expect(response).not.toBeNull();
    expect(extractWithClaudeAdapter(response!)).toContain('你好！有什么我可以帮你的吗？');
  });

  it('normalizes Claude tool code blocks into piercode-tool fences', () => {
    const dom = new JSDOM(`
      <div class="font-claude-response">
        <div class="standard-markdown">
          <pre><code class="language-tool">{"name":"read_file","call_id":"claude1","args":{"path":"README.md"}}</code></pre>
        </div>
      </div>
    `);

    const response = dom.window.document.querySelector(claudeAdapter.responseSelector)!;
    const text = extractWithClaudeAdapter(response);
    expect(text).toContain('```piercode-tool');
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"path":"README.md"');
  });

  it('normalizes Claude language-piercode blocks into piercode-tool fences', () => {
    const dom = new JSDOM(`
      <div class="font-claude-response">
        <div class="standard-markdown grid-cols-1 grid standard-markdown">
          <div role="group" aria-label="piercode code">
            <div class="text-text-500 font-small p-3.5 pb-0">piercode</div>
            <div class="overflow-x-auto">
              <pre class="code-block__code"><code class="language-piercode"><span><span>{"name":"list_dir","call_id":"m3k9p","args":{"path":"."}}</span></span></code></pre>
            </div>
          </div>
        </div>
      </div>
    `);

    const response = dom.window.document.querySelector(claudeAdapter.responseSelector)!;
    const text = extractWithClaudeAdapter(response);
    expect(text).toContain('```piercode-tool');
    expect(text).toContain('"name":"list_dir"');
    expect(text).toContain('"path":"."');
  });

  it('normalizes multiple Claude language-piercode blocks', () => {
    const dom = new JSDOM(`
      <div class="font-claude-response">
        <div class="standard-markdown grid-cols-1 grid standard-markdown">
          <div role="group" aria-label="piercode code">
            <pre class="code-block__code"><code class="language-piercode"><span><span>{"name":"list_dir","call_id":"claudea","args":{"path":"."}}</span></span></code></pre>
          </div>
          <p>then inspect go files</p>
          <div role="group" aria-label="piercode code">
            <pre class="code-block__code"><code class="language-piercode"><span><span>{"name":"glob","call_id":"claudeb","args":{"path":".","pattern":"**/*.go"}}</span></span></code></pre>
          </div>
        </div>
      </div>
    `);

    const response = dom.window.document.querySelector(claudeAdapter.responseSelector)!;
    const text = extractWithClaudeAdapter(response);
    expect(text.match(/```piercode-tool/g)).toHaveLength(2);
    expect(text).toContain('"call_id":"claudea"');
    expect(text).toContain('"name":"list_dir"');
    expect(text).toContain('"call_id":"claudeb"');
    expect(text).toContain('"name":"glob"');
  });
});
