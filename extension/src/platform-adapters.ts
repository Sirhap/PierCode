// 平台适配器 - 隔离不同 AI 平台的 DOM 解析逻辑

export interface PlatformAdapter {
  name: string;
  // 检测当前页面是否匹配该平台
  match: () => boolean;
  // 从 DOM 元素中提取文本（处理平台特定的代码块渲染）
  extractText: (el: Element, buf: string[]) => boolean;
  // 获取响应容器的选择器
  responseSelector: string;
}

export interface ExtractedCodeText {
  text: string;
  hasOverflow: boolean;
}

function normalizeCodeText(text: string): string {
  return text.replace(/\u00A0/g, ' ').trim();
}

// Kimi (kimi.moonshot.cn) 适配器
export const kimiAdapter: PlatformAdapter = {
  name: 'kimi',
  match: () => location.hostname.includes('kimi.com'),
  responseSelector: '.segment-assistant',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';

    // 跳过 Kimi 原生工具调用容器（不是 OpenLink 的 tool 代码块）
    if (classAttr.includes('toolcall-container')) {
      return true;
    }

    // Kimi 的工具代码块渲染为 <div class="kimi-m-code-block ... tool/openlink-tool">
    if (classAttr.includes('kimi-m-code-block') &&
        (classAttr.includes('openlink-tool') || /\btool\b/.test(classAttr))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    // Kimi 也可能用标准 Markdown 代码块
    if ((el.tagName.toLowerCase() === 'pre' || el.tagName.toLowerCase() === 'code') &&
        (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool'))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    return false;
  }
};

// Qwen (qwen.ai / qwenlm.ai) 适配器
export const qwenAdapter: PlatformAdapter = {
  name: 'qwen',
  match: () => location.hostname.includes('qwen.ai') || location.hostname.includes('qwenlm.ai'),
  responseSelector: '.qwen-chat-message-assistant',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    // 匹配最外层 <pre class="qwen-markdown-code"> 且子元素中有 .tool
    if (tag === 'pre' && classAttr.includes('qwen-markdown-code')) {
      const toolBody = el.querySelector('.qwen-markdown-code-body.openlink-tool, .qwen-markdown-code-body.tool');
      if (!toolBody) return false;

      const codeText = extractMonacoText(toolBody);
      buf.push('\n```openlink-tool\n' + codeText.text + '\n```\n');
      return true; // 跳过 pre 的所有 children
    }

    // 兜底：匹配 <div class="qwen-markdown-code-body tool/openlink-tool">
    if (classAttr.includes('qwen-markdown-code-body') &&
        (classAttr.includes('openlink-tool') || /\btool\b/.test(classAttr))) {
      const codeText = extractMonacoText(el);
      buf.push('\n```openlink-tool\n' + codeText.text + '\n```\n');
      return true;
    }

    return false;
  }
};

export function extractMonacoText(container: Element): ExtractedCodeText {
  const hasOverflow = !!container.querySelector('.mtkoverflow');

  // 优先：直接从 Monaco Editor 实例获取原始文本（最可靠）
  const monacoEl = container.querySelector('.monaco-editor');
  if (monacoEl) {
    try {
      // 尝试从全局 monaco 对象获取
      const monacoEditor = (window as any).monaco?.editor?.getEditors?.();
      if (monacoEditor && monacoEditor.length > 0) {
        // 找到当前容器内的 editor
        for (const editor of monacoEditor) {
          const editorDom = editor.getDomNode?.();
          if (editorDom && container.contains(editorDom)) {
            const modelValue = editor.getModel?.()?.getValue?.();
            if (typeof modelValue === 'string' && modelValue) {
              return { text: normalizeCodeText(modelValue), hasOverflow: false };
            }
          }
        }
      }
    } catch {}
  }

  // 回退：从 view-line 逐行提取（直接用 textContent 避免嵌套 span 重复）
  const viewLines = container.querySelector('.view-lines');
  if (!viewLines) return { text: normalizeCodeText(container.textContent || ''), hasOverflow };

  const lines: string[] = [];
  for (const viewLine of viewLines.querySelectorAll('.view-line')) {
    const lineClone = viewLine.cloneNode(true) as Element;
    lineClone.querySelectorAll('.mtkoverflow').forEach(el => el.remove());
    const text = lineClone.textContent || '';
    if (text.trim()) lines.push(text);
  }
  return { text: normalizeCodeText(lines.join('\n')), hasOverflow };
}

// CodeMirror6 文本提取辅助函数
function extractCodeMirror6Text(container: Element): string {
  // 优先：尝试从 CodeMirror6 的 cm-content 逐行提取
  const cmContent = container.querySelector('.cm-content');
  if (cmContent) {
    const lines: string[] = [];
    for (const line of cmContent.querySelectorAll('.cm-line')) {
      lines.push(line.textContent || '');
    }
    return lines.join('\n').replace(/\u00A0/g, ' ').trim();
  }

  // 回退：直接从容器 textContent 提取
  return (container.textContent || '').replace(/\u00A0/g, ' ').trim();
}

// Chat Z (chat.z.ai) 适配器
export const chatZAdapter: PlatformAdapter = {
  name: 'chatz',
  match: () => location.hostname.includes('chat.z.ai'),
  responseSelector: '#response-content-container',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';
    const tag = el.tagName.toLowerCase();

    // Chat Z 使用 CodeMirror6 渲染 tool 代码块
    // 外层容器: div.language-tool 包含 cm-editor
    if (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool')) {
      const codeText = extractCodeMirror6Text(el);
      if (codeText) {
        buf.push('\n```openlink-tool\n' + codeText + '\n```\n');
        return true;
      }
    }

    // 兜底：检测 cm-editor 中包含工具调用 JSON 的情况
    if (classAttr.includes('cm-editor') || classAttr.includes('cm-content')) {
      // 跳过 CodeMirror 内部节点，由外层 language-tool 容器处理
      return true;
    }

    // 标准代码块
    if ((tag === 'pre' || tag === 'code') &&
        (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool'))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    return false;
  }
};

// Gemini (gemini.google.com) 适配器
export const geminiAdapter: PlatformAdapter = {
  name: 'gemini',
  match: () => location.hostname.includes('gemini.google.com'),
  responseSelector: 'message-content, .model-response-text',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';

    // Gemini 通常使用标准 Markdown 渲染
    if ((el.tagName.toLowerCase() === 'pre' || el.tagName.toLowerCase() === 'code') &&
        (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool'))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    return false;
  }
};

// AI Studio (aistudio.google.com) 适配器
export const aiStudioAdapter: PlatformAdapter = {
  name: 'aistudio',
  match: () => location.hostname.includes('aistudio.google.com'),
  responseSelector: 'ms-chat-turn',
  extractText: (el: Element, buf: string[]): boolean => {
    // AI Studio 可能使用 Monaco Editor 或其他复杂组件
    const classAttr = el.getAttribute('class') || '';

    // 检测 Monaco Editor 中的 tool 代码
    if (classAttr.includes('monaco-editor') && el.textContent?.includes('"name":')) {
      const text = el.textContent || '';
      // 尝试提取看起来像工具调用的内容
      if (text.includes('"name"') && text.includes('"args"')) {
        buf.push('\n```openlink-tool\n' + text + '\n```\n');
        return true;
      }
    }

    // 标准代码块
    if ((el.tagName.toLowerCase() === 'pre' || el.tagName.toLowerCase() === 'code') &&
        (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool'))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    return false;
  }
};

// 通用/默认适配器
export const defaultAdapter: PlatformAdapter = {
  name: 'default',
  match: () => true,
  responseSelector: 'message-content, .prose, .chat-content',
  extractText: (el: Element, buf: string[]): boolean => {
    const classAttr = el.getAttribute('class') || '';

    // 通用检测：任何包含 language-tool 的 pre/code 元素
    if ((el.tagName.toLowerCase() === 'pre' || el.tagName.toLowerCase() === 'code') &&
        (classAttr.includes('language-openlink-tool') || classAttr.includes('language-tool'))) {
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    // 通用检测：包含 code + tool/openlink-tool 类的元素
    if (classAttr.includes('code') &&
        (classAttr.includes('openlink-tool') || /\btool\b/.test(classAttr)) &&
        !classAttr.includes('hljs')) { // 排除语法高亮库
      const innerText = el.textContent || '';
      buf.push('\n```openlink-tool\n' + innerText + '\n```\n');
      return true;
    }

    return false;
  }
};

// 按优先级排序的适配器列表
export const platformAdapters: PlatformAdapter[] = [
  kimiAdapter,
  qwenAdapter,
  chatZAdapter,
  geminiAdapter,
  aiStudioAdapter,
  defaultAdapter
];

// 获取当前平台的适配器
export function getPlatformAdapter(): PlatformAdapter {
  for (const adapter of platformAdapters) {
    if (adapter.match()) {
      console.log(`[OpenLink] 使用 ${adapter.name} 平台适配器`);
      return adapter;
    }
  }
  return defaultAdapter;
}
