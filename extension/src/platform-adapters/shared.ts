import type { ExtractedCodeText } from './types';

export function normalizeCodeText(text: string): string {
  return text.replace(/\u00A0/g, ' ').trim();
}

export function looksLikePierCodeLanguage(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.includes('piercode-tool') ||
    normalized.includes('language-piercode-tool') ||
    /\btool\b/.test(normalized);
}

export function looksLikePierCodeAgentResultLanguage(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
	return normalized.includes('piercode-agent-result') ||
		normalized.includes('language-piercode-agent-result');
}

export function hasPierCodeToolClass(classAttr: string): boolean {
  return classAttr.includes('piercode-tool') || /\btool\b/.test(classAttr);
}

export function hasPierCodeAgentResultClass(classAttr: string): boolean {
	return classAttr.includes('piercode-agent-result');
}

export function pushPierCodeTool(buf: string[], text: string, trim = false): boolean {
  const code = trim ? text.trim() : text;
  if (!code) return false;
  buf.push('\n```piercode-tool\n' + code + '\n```\n');
  return true;
}

export function pushPierCodeAgentResult(buf: string[], text: string, trim = false): boolean {
  const code = trim ? text.trim() : text;
  if (!code) return false;
  buf.push('\n```piercode-agent-result\n' + code + '\n```\n');
  return true;
}

export function extractMonacoText(container: Element): ExtractedCodeText {
  const hasOverflow = !!container.querySelector('.mtkoverflow');

  const monacoEl = container.querySelector('.monaco-editor');
  if (monacoEl) {
    try {
      const monacoEditor = (window as any).monaco?.editor?.getEditors?.();
      if (monacoEditor && monacoEditor.length > 0) {
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

export function extractCodeMirror6Text(container: Element): string {
  if (container.classList?.contains('cm-content')) {
    const lines: string[] = [];
    for (const line of container.querySelectorAll('.cm-line')) {
      const clone = line.cloneNode(true) as Element;
      clone.querySelectorAll('.mtkoverflow, .view-cursor').forEach(el => el.remove());
      const text = clone.textContent || '';
      if (text.trim()) lines.push(text);
    }
    if (lines.length > 0) {
      return lines.join('\n').replace(/\u00A0/g, ' ').trim();
    }
    const code = container.querySelector('code');
    if (code) return normalizeCodeText(code.textContent || '');
  }

  const cmContent = container.querySelector('.cm-content');
  if (cmContent) {
    const lines: string[] = [];
    for (const line of cmContent.querySelectorAll('.cm-line')) {
      const clone = line.cloneNode(true) as Element;
      clone.querySelectorAll('.mtkoverflow, .view-cursor').forEach(el => el.remove());
      const text = clone.textContent || '';
      if (text.trim()) lines.push(text);
    }
    if (lines.length > 0) {
      return lines.join('\n').replace(/\u00A0/g, ' ').trim();
    }
  }

  const code = container.querySelector('code');
  if (code) return normalizeCodeText(code.textContent || '');
  return normalizeCodeText(container.textContent || '');
}

export function extractAllToolCalls(text: string, buf: string[]): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === '{') depth++;
        if (c === '}') {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
    }

    if (end !== -1) {
      const jsonStr = text.substring(start, end + 1).trim();
      try {
        const parsed = JSON.parse(jsonStr);
		if (parsed.name && (parsed.args || parsed.arguments)) {
          pushPierCodeTool(buf, jsonStr);
          count++;
        }
      } catch {}
      i = start + jsonStr.length;
    } else {
      i = start + 1;
    }
  }
  return count;
}
