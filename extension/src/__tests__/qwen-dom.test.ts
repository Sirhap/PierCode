/**
 * 集成测试：模拟 Qwen HTML DOM 结构，验证从 DOM 提取到 JSON 解析的完整链路
 *
 * 核心问题：
 * 1. Monaco Editor 用 &nbsp; 渲染空格 → textContent 变成 \u00A0 → JSON.parse 失败
 * 2. injected/index.ts 用 buffer.match(gi 正则) 丢失捕获组 → fenceMatch[1] 为 undefined
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { FENCE_RE, parseJsonFenceToolCall, tryParseToolJSON, parseAgentResultPacket } from '../parser';
import { extractMonacoText as extractPlatformMonacoText, findQwenToolBody, findQwenPierCodeBody, qwenAdapter } from '../platform-adapters';

// ── 模拟 Qwen Monaco Editor DOM 提取 ────────────────────────────────────────

/**
 * 模拟 content/index.ts 和 platform-adapters.ts 中的 extractMonacoText
 */
function extractMonacoText(container: Element): string {
  const viewLines = container.querySelector('.view-lines');
  if (!viewLines) return (container.textContent || '').replace(/\u00A0/g, ' ').trim();

  const lines: string[] = [];
  for (const viewLine of viewLines.querySelectorAll('.view-line')) {
    const text = viewLine.textContent || '';
    if (text.trim()) lines.push(text);
  }
  return lines.join('\n').replace(/\u00A0/g, ' ').trim();
}

/**
 * 模拟 content/index.ts 中的 getCleanText (简化版)
 */
function getCleanText(el: Element): string {
  const buf: string[] = [];
  extractText(el, buf);
  return buf.join('');
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'PRE', 'BLOCKQUOTE']);

function extractText(node: Node, buf: string[]): void {
  if (node.nodeType === 3) { // TEXT_NODE
    buf.push(node.textContent || '');
    return;
  }
  if (node.nodeType !== 1) return; // ELEMENT_NODE
  const el = node as Element;

  // 模拟平台适配器处理 qwen-markdown-code-body tool
  const classAttr = el.getAttribute('class') || '';
  if (classAttr.includes('qwen-markdown-code-body') && classAttr.includes('tool')) {
    const codeText = extractMonacoText(el);
    buf.push('\n```tool\n' + codeText + '\n```\n');
    return;
  }
  // 模拟平台适配器处理 pre.qwen-markdown-code 含 .tool 子元素
  if (el.tagName.toLowerCase() === 'pre' && classAttr.includes('qwen-markdown-code')) {
    const toolBody = el.querySelector('.qwen-markdown-code-body.tool');
    if (toolBody) {
      const codeText = extractMonacoText(toolBody);
      buf.push('\n```tool\n' + codeText + '\n```\n');
      return;
    }
  }

  if (BLOCK_TAGS.has(el.tagName)) buf.push('\n');
  for (const child of el.childNodes) {
    extractText(child, buf);
  }
}

/**
 * 模拟 scanText 中的 Phase 1 解析逻辑
 */
function scanTextPhase1(text: string): any[] {
  const lower = text.toLowerCase();
  const results: any[] = [];
  if (lower.includes('```piercode-tool') || lower.includes('```tool')) {
    FENCE_RE.lastIndex = 0;
    let fenceMatch;
    while ((fenceMatch = FENCE_RE.exec(text)) !== null) {
      const jsonStr = fenceMatch[1];
      const cleanedJsonStr = jsonStr.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
      // 流式渲染中：内容可能不完整，静默跳过
      if (!cleanedJsonStr.endsWith('}')) {
        continue;
      }
      const data = parseJsonFenceToolCall(cleanedJsonStr) || tryParseToolJSON(cleanedJsonStr);
      if (data) {
        results.push(data);
      }
    }
  }
  return results;
}

// ── Qwen HTML 模板 ──────────────────────────────────────────────────────────

/**
 * 生成 Qwen Monaco Editor 单行代码块的 HTML
 * 模拟真实的 Qwen DOM 结构：span.mtk1 中包含 &nbsp; 表示空格
 */
function makeQwenMonacoLine(jsonStr: string): string {
  // Monaco 用 &nbsp; 代替空格
  const htmlContent = jsonStr.replace(/ /g, '&nbsp;');
  return `
    <div class="view-line">
      <span>
        <span class="mtk1">${htmlContent}</span>
      </span>
    </div>`;
}

function makeQwenCodeBlock(jsonStr: string): string {
  return `
    <pre class="qwen-markdown-code">
      <div class="qwen-markdown-code-header-wrapper">
        <div class="qwen-markdown-code-header"><div>tool</div></div>
      </div>
      <div class="qwen-markdown-code-body tool">
        <section>
          <div>
            <div class="monaco-editor vs-dark">
              <div class="monaco-scrollable-element">
                <div class="lines-content">
                  <div class="view-lines monaco-mouse-cursor-text">
                    ${makeQwenMonacoLine(jsonStr)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </pre>`;
}

function makeQwenResponseHtml(toolCalls: Array<{name: string, call_id: string, args: Record<string, string>}>): string {
  // 使用带空格的 JSON 格式（模拟真实 AI 输出）
  const blocks = toolCalls.map(tc =>
    makeQwenCodeBlock(JSON.stringify(tc).replace(/":"/g, '": "').replace(/","/g, '", "').replace(/":{/g, '": {').replace(/"}/g, '"}'))
  ).join('\n');

  return `
    <div class="qwen-chat-message qwen-chat-message-assistant">
      <div class="chat-response-message">
        <div class="response-message-content">
          <div class="custom-qwen-markdown">
            <div class="qwen-markdown">
              ${blocks}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// ── 模拟 injected/index.ts fetch 拦截的流式解析 ────────────────────────────

const INJECTED_FENCE_RE = /```tool\s*\n([\s\S]*?)\n```/gi;

/**
 * 模拟旧版本（有 bug）的 buffer.match 写法
 */
function parseBufferOldBuggy(buffer: string): { toolCalls: any[], errors: string[] } {
  const toolCalls: any[] = [];
  const errors: string[] = [];

  // BUG: 用 match + gi 正则，丢失捕获组
  let fenceMatch;
  while ((fenceMatch = buffer.match(INJECTED_FENCE_RE))) {
    const full = fenceMatch[0];
    const captured = fenceMatch[1]; // undefined!
    const toolCall = parseInjectedJsonFenceToolCallOld(captured);
    if (toolCall) {
      toolCalls.push(toolCall);
    } else {
      errors.push(full);
    }
    buffer = buffer.replace(full, '');
  }
  return { toolCalls, errors };
}

function parseInjectedJsonFenceToolCallOld(jsonStr: string): any | null {
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj.name || typeof obj.name !== 'string') return null;
    return { name: obj.name, callId: obj.call_id || null, args: obj.args || {} };
  } catch { return null; }
}

/**
 * 模拟新版本（修复后）的 exec 写法
 */
function parseBufferNewFixed(buffer: string): { toolCalls: any[], errors: string[] } {
  const toolCalls: any[] = [];
  const errors: string[] = [];

  INJECTED_FENCE_RE.lastIndex = 0;
  let fenceMatch;
  while ((fenceMatch = INJECTED_FENCE_RE.exec(buffer)) !== null) {
    const full = fenceMatch[0];
    const captured = fenceMatch[1];
    const cleanedJson = captured.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
    const toolCall = parseJsonFenceToolCall(cleanedJson) || tryParseToolJSON(cleanedJson);
    if (toolCall) {
      toolCalls.push(toolCall);
    } else {
      errors.push(full);
    }
    // 注意：实际代码中 buffer.replace 会重置 exec 的 lastIndex
    // 这里为简化测试，不用 replace
  }
  return { toolCalls, errors };
}

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('Qwen DOM 集成测试', () => {
  let dom: JSDOM;
  let document: Document;

  beforeAll(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
  });

  it('模拟 Qwen 单个工具调用：DOM 提取 → 解析', () => {
    const html = makeQwenResponseHtml([
      { name: 'read_file', call_id: 'd4e5f6', args: { path: 'README.md' } }
    ]);

    const container = document.createElement('div');
    container.innerHTML = html;

    // Phase 0: 直接从 DOM 提取
    const toolPres = container.querySelectorAll('pre.qwen-markdown-code');
    expect(toolPres.length).toBe(1);

    const toolBody = toolPres[0].querySelector('.qwen-markdown-code-body.tool');
    expect(toolBody).not.toBeNull();

    const codeText = extractMonacoText(toolBody!);
    // 验证 &nbsp; 被正确替换为普通空格
    expect(codeText).not.toContain('\u00A0');
    // JSON.stringify 不保留空格，所以只验证解析结果
    const data = parseJsonFenceToolCall(codeText);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('read_file');
    expect(data!.callId).toBe('d4e5f6');
    expect(data!.args.path).toBe('README.md');
  });

  it('模拟 Qwen 多个工具调用：3 个并行 tool call', () => {
    const html = makeQwenResponseHtml([
      { name: 'read_file', call_id: 'd4e5f6', args: { path: 'README.md' } },
      { name: 'glob', call_id: 'g7h8i9', args: { pattern: '**/*.{json,toml,yaml,yml}' } },
      { name: 'list_dir', call_id: 'j0k1l2', args: { path: 'src' } }
    ]);

    const container = document.createElement('div');
    container.innerHTML = html;

    // Phase 0: 直接从 DOM 提取
    const toolPres = container.querySelectorAll('pre.qwen-markdown-code');
    expect(toolPres.length).toBe(3);

    const results: any[] = [];
    for (const pre of toolPres) {
      const toolBody = pre.querySelector('.qwen-markdown-code-body.tool');
      expect(toolBody).not.toBeNull();
      const codeText = extractMonacoText(toolBody!);
      const data = parseJsonFenceToolCall(codeText);
      if (data) results.push(data);
    }

    expect(results).toHaveLength(3);
    expect(results[0].name).toBe('read_file');
    expect(results[1].name).toBe('glob');
    expect(results[2].name).toBe('list_dir');
    expect(results[1].args.pattern).toBe('**/*.{json,toml,yaml,yml}');
  });

  it('模拟 Qwen getCleanText → scanText Phase 1 完整链路', () => {
    const html = makeQwenResponseHtml([
      { name: 'exec_cmd', call_id: 'abc123', args: { command: 'ls -la' } }
    ]);

    const container = document.createElement('div');
    container.innerHTML = html;

    const text = getCleanText(container);
    // 验证 text 中包含 ```tool\n...\n```
    expect(text).toContain('```tool');
    expect(text).toContain('```');

    const results = scanTextPhase1(text);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('exec_cmd');
    expect(results[0].args.command).toBe('ls -la');
  });

  it('验证 &nbsp; → \\u00A0 的问题确实存在（未修复时失败）', () => {
    // 创建一个包含 &nbsp; 的 span
    const span = document.createElement('span');
    span.innerHTML = '{"name":&nbsp;"read_file",&nbsp;"args":&nbsp;{"path":&nbsp;"README.md"}}';

    // textContent 会把 &nbsp; 变成 \u00A0
    const rawText = span.textContent || '';
    expect(rawText).toContain('\u00A0');

    // 不做任何清理，直接 parse 会失败
    expect(() => JSON.parse(rawText)).toThrow();

    // 做了 NBSP 清理后可以解析
    const cleaned = rawText.replace(/\u00A0/g, ' ');
    const parsed = JSON.parse(cleaned);
    expect(parsed.name).toBe('read_file');
  });

  it('验证旧版 injected 脚本 buffer.match(gi) 的 bug', () => {
    const buffer = '```tool\n{"name":"read_file","call_id":"d4e5f6","args":{"path":"README.md"}}\n```';

    const oldResult = parseBufferOldBuggy(buffer);
    // 旧版本用 match + gi，fenceMatch[1] 为 undefined，所有调用都会失败
    expect(oldResult.toolCalls).toHaveLength(0);
    expect(oldResult.errors.length).toBeGreaterThan(0);
  });

  it('验证修复后 injected 脚本 exec 正确提取捕获组', () => {
    const buffer = '```tool\n{"name":"read_file","call_id":"d4e5f6","args":{"path":"README.md"}}\n```';

    const newResult = parseBufferNewFixed(buffer);
    expect(newResult.toolCalls).toHaveLength(1);
    expect(newResult.toolCalls[0].name).toBe('read_file');
    expect(newResult.toolCalls[0].callId).toBe('d4e5f6');
    expect(newResult.errors).toHaveLength(0);
  });

  it('模拟 injected 流式缓冲：多个 tool call 逐块到达', () => {
    // 模拟 SSE 流式传输，数据分块到达
    const chunk1 = '```tool\n{"name":"read_file","call_id":"d4e5f6","args":{"path":"README.md"}}\n```';
    const chunk2 = '\n```tool\n{"name":"glob","call_id":"g7h8i9","args":{"pattern":"**/*.json"}}\n```';

    // 完整 buffer
    const fullBuffer = chunk1 + chunk2;
    const result = parseBufferNewFixed(fullBuffer);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.toolCalls[1].name).toBe('glob');
  });

  it('模拟 injected 流式缓冲：NBSP 在流数据中', () => {
    // 假设流数据中包含 NBSP（虽然不太可能，但做防御性测试）
    const buffer = '```tool\n{"name":\u00A0"list_dir","call_id":\u00A0"j0k1l2","args":\u00A0{"path":\u00A0"src"}}\n```';
    const result = parseBufferNewFixed(buffer);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('list_dir');
    expect(result.toolCalls[0].args.path).toBe('src');
  });

  it('端到端：从 Qwen 真实 HTML DOM 结构提取并解析 3 个工具调用', () => {
    // 使用用户提供的真实 Qwen HTML 结构片段
    const realHtml = `
      <div class="qwen-chat-message qwen-chat-message-assistant">
        <div class="response-message-content">
          <div class="custom-qwen-markdown">
            <div class="qwen-markdown">
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header-wrapper">
                  <div class="qwen-markdown-code-header"><div>tool</div></div>
                </div>
                <div class="qwen-markdown-code-body tool">
                  <section>
                    <div class="monaco-editor vs-dark">
                      <div class="view-lines monaco-mouse-cursor-text">
                        <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"read_file",&nbsp;"call_id":&nbsp;"d4e5f6",&nbsp;"args":&nbsp;{"path":&nbsp;"README.md"}}</span></span></div>
                      </div>
                    </div>
                  </section>
                </div>
              </pre>
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header-wrapper">
                  <div class="qwen-markdown-code-header"><div>tool</div></div>
                </div>
                <div class="qwen-markdown-code-body tool">
                  <section>
                    <div class="monaco-editor vs-dark">
                      <div class="view-lines monaco-mouse-cursor-text">
                        <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"glob",&nbsp;"call_id":&nbsp;"g7h8i9",&nbsp;"args":&nbsp;{"pattern":&nbsp;"**/*.{json,toml,yaml,yml}"}}</span></span></div>
                      </div>
                    </div>
                  </section>
                </div>
              </pre>
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header-wrapper">
                  <div class="qwen-markdown-code-header"><div>tool</div></div>
                </div>
                <div class="qwen-markdown-code-body tool">
                  <section>
                    <div class="monaco-editor vs-dark">
                      <div class="view-lines monaco-mouse-cursor-text">
                        <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"list_dir",&nbsp;"call_id":&nbsp;"j0k1l2",&nbsp;"args":&nbsp;{"path":&nbsp;"src"}}</span></span></div>
                      </div>
                    </div>
                  </section>
                </div>
              </pre>
            </div>
          </div>
        </div>
      </div>`;

    const container = document.createElement('div');
    container.innerHTML = realHtml;

    // Phase 0: Qwen DOM 直接提取
    const toolPres = container.querySelectorAll('pre.qwen-markdown-code');
    expect(toolPres.length).toBe(3);

    const results: any[] = [];
    for (const pre of toolPres) {
      const toolBody = pre.querySelector('.qwen-markdown-code-body.tool');
      expect(toolBody).not.toBeNull();
      const codeText = extractMonacoText(toolBody!);
      const data = parseJsonFenceToolCall(codeText);
      if (data) results.push(data);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ name: 'read_file', callId: 'd4e5f6', args: { path: 'README.md' } });
    expect(results[1]).toEqual({ name: 'glob', callId: 'g7h8i9', args: { pattern: '**/*.{json,toml,yaml,yml}' } });
    expect(results[2]).toEqual({ name: 'list_dir', callId: 'j0k1l2', args: { path: 'src' } });
  });

  it('端到端：getCleanText 完整链路解析 3 个工具调用', () => {
    const realHtml = `
      <div class="qwen-chat-message qwen-chat-message-assistant">
        <div class="response-message-content">
          <div class="custom-qwen-markdown">
            <div class="qwen-markdown">
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header"><div>tool</div></div>
                <div class="qwen-markdown-code-body tool">
                  <div class="monaco-editor vs-dark">
                    <div class="view-lines">
                      <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"read_file",&nbsp;"call_id":&nbsp;"d4e5f6",&nbsp;"args":&nbsp;{"path":&nbsp;"README.md"}}</span></span></div>
                    </div>
                  </div>
                </div>
              </pre>
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header"><div>tool</div></div>
                <div class="qwen-markdown-code-body tool">
                  <div class="monaco-editor vs-dark">
                    <div class="view-lines">
                      <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"glob",&nbsp;"call_id":&nbsp;"g7h8i9",&nbsp;"args":&nbsp;{"pattern":&nbsp;"**/*.{json,toml,yaml,yml}"}}</span></span></div>
                    </div>
                  </div>
                </div>
              </pre>
              <pre class="qwen-markdown-code">
                <div class="qwen-markdown-code-header"><div>tool</div></div>
                <div class="qwen-markdown-code-body tool">
                  <div class="monaco-editor vs-dark">
                    <div class="view-lines">
                      <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"list_dir",&nbsp;"call_id":&nbsp;"j0k1l2",&nbsp;"args":&nbsp;{"path":&nbsp;"src"}}</span></span></div>
                    </div>
                  </div>
                </div>
              </pre>
            </div>
          </div>
        </div>
      </div>`;

    const container = document.createElement('div');
    container.innerHTML = realHtml;

    const text = getCleanText(container);
    const results = scanTextPhase1(text);

    expect(results).toHaveLength(3);
    expect(results[0].name).toBe('read_file');
    expect(results[1].name).toBe('glob');
    expect(results[2].name).toBe('list_dir');
  });

  it('流式渲染：不完整 JSON 静默跳过，完整后解析成功', () => {
    // 模拟 AI 正在流式输出，Monaco 只渲染了部分内容
    const incompleteHtml = `
      <div class="qwen-markdown-code-body tool">
        <div class="view-lines">
          <div class="view-line"><span><span class="mtk1">{"name":&nbsp;</span></span></div>
        </div>
      </div>`;

    const container = document.createElement('div');
    container.innerHTML = incompleteHtml;

    const codeText = extractMonacoText(container);
    // 不完整的 JSON 不以 } 结尾
    expect(codeText.trim().endsWith('}')).toBe(false);
    // 解析应该失败，但不应该弹 toast
    const data = parseJsonFenceToolCall(codeText);
    expect(data).toBeNull();

    // 模拟 AI 输出完成后，Monaco 渲染了完整内容
    const completeHtml = `
      <div class="qwen-markdown-code-body tool">
        <div class="view-lines">
          <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"list_dir",&nbsp;"call_id":&nbsp;"l0i1s2",&nbsp;"args":&nbsp;{"path":&nbsp;"src"}}</span></span></div>
        </div>
      </div>`;

    const container2 = document.createElement('div');
    container2.innerHTML = completeHtml;

    const codeText2 = extractMonacoText(container2);
    expect(codeText2.trim().endsWith('}')).toBe(true);
    const data2 = parseJsonFenceToolCall(codeText2);
    expect(data2).not.toBeNull();
    expect(data2!.name).toBe('list_dir');
  });

  it('流式渲染：Phase 1 scanText 跳过不以 } 结尾的 fence 内容', () => {
    // 模拟 getCleanText 提取出的流式中途文本
    const streamingText = '```tool\n{"name":\n```';
    const results = scanTextPhase1(streamingText);
    // fence 内容不以 } 结尾，应被跳过
    expect(results).toHaveLength(0);
  });

  it('Qwen Monaco 省略占位：识别 mtkoverflow 并避免把 Show more 当作代码', () => {
    const html = `
      <div class="qwen-markdown-code-body tool">
        <div class="monaco-editor vs-dark">
          <div class="view-lines">
            <div class="view-line">
              <span>
                <span class="mtk1">{"name":&nbsp;"write_file",&nbsp;"call_id":&nbsp;"u2v3w4",&nbsp;"args":&nbsp;{"content":&nbsp;"package tui\\n</span>
                <span class="mtkoverflow">Show more (670 chars)</span>
                <span class="mtk1">",&nbsp;"path":&nbsp;"internal/tui/model.go"}}</span>
              </span>
            </div>
          </div>
        </div>
      </div>`;

    const container = document.createElement('div');
    container.innerHTML = html;

    const result = extractPlatformMonacoText(container);
    expect(result.hasOverflow).toBe(true);
    expect(result.text).not.toContain('Show more');
    expect(parseJsonFenceToolCall(result.text)).toBeNull();
  });

  it('Qwen header 标记 piercode-tool 时，即使 body 没有 tool class 也能识别', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header-wrapper">
          <div class="qwen-markdown-code-header"><div>piercode-tool</div></div>
        </div>
        <div class="qwen-markdown-code-body">
          <div class="monaco-editor vs-dark">
            <div class="view-lines">
              <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"skill",&nbsp;"call_id":&nbsp;"pua9x2k",&nbsp;"args":&nbsp;{"skill":&nbsp;"pua"}}</span></span></div>
            </div>
          </div>
        </div>
      </pre>`;

    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;
    const toolBody = findQwenToolBody(pre);

    expect(toolBody).not.toBeNull();
    const data = parseJsonFenceToolCall(extractMonacoText(toolBody!));
    expect(data).toEqual({ name: 'skill', callId: 'pua9x2k', args: { skill: 'pua' } });
  });

  it('Qwen adapter 从 header-only piercode-tool 代码块提取 fence', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>piercode-tool</div></div>
        <div class="qwen-markdown-code-body">
          <div class="view-lines">
            <div class="view-line"><span><span class="mtk1">{"name":&nbsp;"list_dir",&nbsp;"call_id":&nbsp;"qwenh1",&nbsp;"args":&nbsp;{"path":&nbsp;"."}}</span></span></div>
          </div>
        </div>
      </pre>`;

    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;
    const buf: string[] = [];

    expect(qwenAdapter.extractText(pre, buf)).toBe(true);
    const results = scanTextPhase1(buf.join(''));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ name: 'list_dir', callId: 'qwenh1', args: { path: '.' } });
  });

  it('Qwen adapter 从 header-only piercode-agent-result 代码块保留 result fence', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>piercode-agent-result</div></div>
        <div class="qwen-markdown-code-body">
          <div class="view-lines">
            <div class="view-line"><span><span class="mtk1">{"version":"1","agent_id":"agent-test","status":"completed","summary":"ok","result":"2+3=5","evidence":["direct"],"files_changed":[]}</span></span></div>
          </div>
        </div>
      </pre>`;

    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;
    const buf: string[] = [];

    expect(qwenAdapter.extractText(pre, buf)).toBe(true);
    const text = buf.join('');
    expect(text).toContain('```piercode-agent-result');
    expect(text).toContain('"agent_id":"agent-test"');
    expect(text).not.toContain('```piercode-tool');
  });

  it('识别新版 Qwen response-message-content 容器里的 piercode-tool', () => {
    const html = `
      <div class="response-message-content t2t phase-answer">
        <div class="custom-qwen-markdown">
          <div class="qwen-markdown">
            <pre class="qwen-markdown-code">
              <div class="qwen-markdown-code-header-wrapper qwen-markdown-code-header-wrapper-sticky">
                <div class="qwen-markdown-code-header"><div>piercode-tool</div></div>
              </div>
              <div class="qwen-markdown-code-body piercode-tool">
                <div class="monaco-editor vs-dark">
                  <div class="view-lines monaco-mouse-cursor-text">
                    <div class="view-line"><span><span class="mtk1">{"name":"skill","call_id":"pua9x2k","args":{"skill</span><span class="mtk1">":"pua"}}</span></span></div>
                  </div>
                </div>
              </div>
            </pre>
          </div>
        </div>
      </div>`;

    const container = document.createElement('div');
    container.innerHTML = html;
    const response = container.querySelector(qwenAdapter.responseSelector)!;
    const text = getCleanText(response);
    const results = scanTextPhase1(text);

    expect(response).not.toBeNull();
    expect(results).toEqual([{ name: 'skill', callId: 'pua9x2k', args: { skill: 'pua' } }]);
  });
});

// ── 子 agent 回传 result packet 解析 ─────────────────────────────────────────
// 真实缺陷：Qwen worker 把 piercode-agent-result JSON 渲染进 Monaco（单行长 JSON），
// 溢出截断后 maybeForwardAgentResult 的正则永远匹配不到 → coordinator 收不到回调。
// parseAgentResultPacket 把"解析 + 完整性判定"抽成纯函数，给 Phase-0 Monaco 恢复
// 路径和通用 fence 兜底共用。
describe('parseAgentResultPacket', () => {
  it('解析完整 packet', () => {
    const json = '{"version":1,"agent_id":"agent-1","status":"completed","summary":"done","result":"2+3=5"}';
    expect(parseAgentResultPacket(json)).toEqual({
      agentId: 'agent-1',
      status: 'completed',
      summary: 'done',
      result: '2+3=5',
    });
  });

  it('status 缺省回退 completed，summary/result 缺省为空串', () => {
    const json = '{"agent_id":"agent-2"}';
    expect(parseAgentResultPacket(json)).toEqual({
      agentId: 'agent-2',
      status: 'completed',
      summary: '',
      result: '',
    });
  });

  it('failed / blocked 状态透传', () => {
    expect(parseAgentResultPacket('{"agent_id":"a","status":"failed"}')?.status).toBe('failed');
    expect(parseAgentResultPacket('{"agent_id":"a","status":"blocked"}')?.status).toBe('blocked');
  });

  it('截断（未闭合 / 不以 } 结尾）返回 null —— Monaco 溢出与流式中途场景', () => {
    // mtkoverflow 删占位后留下的半截 JSON
    expect(parseAgentResultPacket('{"agent_id":"a","status":"completed","result":"package tui')).toBeNull();
    // 仍在流式
    expect(parseAgentResultPacket('{"agent_id":"a","status":"comp')).toBeNull();
  });

  it('彻底无法解析返回 null', () => {
    expect(parseAgentResultPacket('not json}')).toBeNull();
    expect(parseAgentResultPacket('')).toBeNull();
  });

  it('U+00A0 (Monaco &nbsp;) 与零宽字符被归一后仍可解析', () => {
    const json = '{"agent_id":"a", "status":"completed",​"summary":"ok"}';
    expect(parseAgentResultPacket(json)?.summary).toBe('ok');
  });
});

// ── Phase 0 子 agent 回传：Monaco 提取 → parseAgentResultPacket 全链路 ─────────
// 复现真实缺陷：worker 把 result packet 渲染进 Monaco，scanText 的 Phase 0 必须
// 先用 findQwenPierCodeBody 识别 agent-result body、extractMonacoText 提取、再
// parseAgentResultPacket 解析。溢出截断时 extractMonacoText 标 hasOverflow，必须
// 走 requestMonacoModelText 恢复（本测试断言截断态解析失败，证明恢复不可省）。
describe('Qwen worker agent-result Phase 0 链路', () => {
  let dom: JSDOM;
  let document: Document;

  beforeAll(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
  });

  it('findQwenPierCodeBody 识别 header-only agent-result 块并标 kind', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-header"><div>piercode-agent-result</div></div>
        <div class="qwen-markdown-code-body">
          <div class="view-lines">
            <div class="view-line"><span><span class="mtk1">{"agent_id":"agent-x","status":"completed"}</span></span></div>
          </div>
        </div>
      </pre>`;
    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;

    const block = findQwenPierCodeBody(pre);
    expect(block?.kind).toBe('agent-result');
    const extracted = extractPlatformMonacoText(block!.body);
    expect(extracted.hasOverflow).toBe(false);
    const packet = parseAgentResultPacket(extracted.text);
    expect(packet).toEqual({ agentId: 'agent-x', status: 'completed', summary: '', result: '' });
  });

  it('多 span 渲染的 agent-result 拼接后可解析（&nbsp; 归一）', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-body piercode-agent-result">
          <div class="view-lines">
            <div class="view-line"><span><span class="mtk1">{"agent_id":&nbsp;"agent-y",&nbsp;"status":&nbsp;"completed",&nbsp;"summary":&nbsp;"done",&nbsp;</span><span class="mtk1">"result":&nbsp;"ok"}</span></span></div>
          </div>
        </div>
      </pre>`;
    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;
    const block = findQwenPierCodeBody(pre)!;
    const packet = parseAgentResultPacket(extractPlatformMonacoText(block.body).text);
    expect(packet).toEqual({ agentId: 'agent-y', status: 'completed', summary: 'done', result: 'ok' });
  });

  it('Monaco 溢出截断 → hasOverflow 且未恢复时解析失败（证明必须 requestMonacoModelText 恢复）', () => {
    const html = `
      <pre class="qwen-markdown-code">
        <div class="qwen-markdown-code-body piercode-agent-result">
          <div class="monaco-editor vs-dark">
            <div class="view-lines">
              <div class="view-line">
                <span>
                  <span class="mtk1">{"agent_id":&nbsp;"agent-z",&nbsp;"status":&nbsp;"completed",&nbsp;"result":&nbsp;"package tui\\n</span>
                  <span class="mtkoverflow">Show more (820 chars)</span>
                  <span class="mtk1">"}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </pre>`;
    const container = document.createElement('div');
    container.innerHTML = html;
    const pre = container.querySelector('pre.qwen-markdown-code')!;
    const block = findQwenPierCodeBody(pre)!;
    const extracted = extractPlatformMonacoText(block.body);
    expect(extracted.hasOverflow).toBe(true);
    expect(parseAgentResultPacket(extracted.text)).toBeNull();
  });
});
