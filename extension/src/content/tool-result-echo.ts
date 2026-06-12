// 工具响应回显卡（extracted from content/index.ts）。
//
// 工具结果以 `### name #call_id\n\noutput` 回填成用户消息（parser.formatToolResults
// 的格式）。这里把这种用户气泡识别出来，替换成 Claude Code 风格的紧凑结果卡：
// ⏺ name #id + ⎿ 首行预览（可展开全文）。display-only，不影响执行/会话逻辑。
//
// Content-bundle leaf：只 import terminal-theme 纯常量。

import { T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW, T_RED, T_FONT } from './terminal-theme';

export type ToolResultEchoSection = { name: string; id: string; body: string };

export function parseToolResultEchoSections(text: string): ToolResultEchoSection[] {
  const re = /^###\s+([\w.-]+)\s+#(\S+)\s*$/gm;
  const headers: Array<{ name: string; id: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) headers.push({ name: m[1], id: m[2], start: m.index, end: m.index + m[0].length });
  // 首个标题必须在开头附近，否则只是恰好包含 ### 的普通用户消息。
  if (headers.length === 0 || headers[0].start > 10) return [];
  return headers.map((h, i) => ({
    name: h.name,
    id: h.id,
    body: text.slice(h.end, i + 1 < headers.length ? headers[i + 1].start : undefined).trim(),
  }));
}

function buildToolResultEchoCard(sections: ToolResultEchoSection[]): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = `border:1px solid ${T_LINE};border-radius:8px;padding:7px 10px;background:${T_PANEL};color:${T_TXT};font-size:12px;line-height:1.55;font-family:${T_FONT};text-align:left`;
  for (const s of sections) {
    const isErr = /\[PierCode 错误\]|\[PierCode error\]|^Error\b|执行失败/m.test(s.body);
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
    const mark = document.createElement('span');
    mark.textContent = '⏺';
    mark.style.cssText = `flex:0 0 auto;color:${isErr ? T_RED : T_GLOW}`;
    const name = document.createElement('span');
    name.style.cssText = `font-weight:600;color:${T_TXT};flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
    name.textContent = s.name;
    name.title = `#${s.id}`;
    const tag = document.createElement('span');
    tag.style.cssText = `flex:0 0 auto;color:${T_DIM};font-size:11px`;
    tag.textContent = '工具结果';
    head.append(mark, name, tag);
    card.appendChild(head);

    const lines = s.body.split('\n');
    const first = (lines.find(l => l.trim()) || '(无输出)').trim();
    const extra = Math.max(0, lines.length - 1);
    const lineEl = document.createElement('div');
    lineEl.style.cssText = `display:flex;align-items:baseline;gap:5px;margin:1px 0 2px 14px;color:${isErr ? T_RED : T_DIM};font-size:11px;min-width:0`;
    const lm = document.createElement('span');
    lm.textContent = '⎿';
    lm.style.cssText = 'flex:0 0 auto';
    const preview = document.createElement('span');
    preview.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    preview.textContent = first.length > 100 ? first.slice(0, 99) + '…' : first;
    lineEl.append(lm, preview);

    const full = document.createElement('div');
    full.style.cssText = `display:none;margin:2px 0 4px 14px;padding:6px 8px;background:${T_PANEL2};border-radius:6px;max-height:240px;overflow-y:auto;font-size:11px;color:${T_TXT};white-space:pre-wrap;word-break:break-word`;
    full.textContent = s.body;
    if (extra > 0 || first.length > 100) {
      const toggle = document.createElement('span');
      toggle.style.cssText = `flex:0 0 auto;color:${T_GLOW};cursor:pointer;user-select:none`;
      const closedLabel = extra > 0 ? `+${extra} 行 ▸` : '展开 ▸';
      toggle.textContent = closedLabel;
      const flip = () => {
        const open = full.style.display !== 'none';
        full.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? closedLabel : '收起 ▾';
      };
      toggle.onclick = flip;
      preview.style.cursor = 'pointer';
      preview.onclick = flip;
      lineEl.appendChild(toggle);
    }
    card.appendChild(lineEl);
    card.appendChild(full);
  }
  return card;
}

// decorateToolResultEchoes 扫描用户消息气泡，把工具结果回填替换成紧凑卡。
// 原始内容移入隐藏 wrapper（SPA 原地重建会丢 attr → 自动重新装饰）。
export function decorateToolResultEchoes(userSelector: string | undefined): void {
  if (!userSelector) return;
  document.querySelectorAll(userSelector).forEach((el) => {
    const host = el as HTMLElement;
    if (host.getAttribute('data-piercode-result-echo') === '1') return;
    const text = (host.innerText || host.textContent || '').trim();
    if (!text.startsWith('###')) return;
    const sections = parseToolResultEchoSections(text);
    if (sections.length === 0) return;
    host.setAttribute('data-piercode-result-echo', '1');
    const wrapper = document.createElement('div');
    wrapper.style.display = 'none';
    while (host.firstChild) wrapper.appendChild(host.firstChild);
    const card = buildToolResultEchoCard(sections);
    // 折叠态附"原文"开关，需要时还原查看完整回填文本。
    const rawToggle = document.createElement('div');
    rawToggle.style.cssText = `margin-top:2px;color:${T_DIM};font-size:10px;cursor:pointer;user-select:none;font-family:${T_FONT}`;
    rawToggle.textContent = '原文 ▸';
    rawToggle.onclick = () => {
      const open = wrapper.style.display !== 'none';
      wrapper.style.display = open ? 'none' : 'block';
      rawToggle.textContent = open ? '原文 ▸' : '原文 ▾';
    };
    card.appendChild(rawToggle);
    host.appendChild(card);
    host.appendChild(wrapper);
  });
}

let resultEchoTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleResultEchoDecoration(userSelector: string | undefined): void {
  if (resultEchoTimer) return;
  resultEchoTimer = setTimeout(() => {
    resultEchoTimer = null;
    try { decorateToolResultEchoes(userSelector); } catch {}
  }, 300);
}
