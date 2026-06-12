// 斜杠命令 / @ 文件补全（extracted from content/index.ts）。
//
// 输入框里 `/skill` 弹 skill 选择器（选中即插入 SKILL.md 内容包装），`@path`
// 弹文件补全（服务端 /files 模糊匹配）。另负责手动发送时的 prompt 上报
// （Enter / 发送按钮点击 → deps.onPromptSubmitted）。
//
// Content-bundle leaf：API 访问 / 站点配置 / 工具执行 经 initEditorCompletionDeps
// 注入；skills 过滤与主题常量直接 import（均为安全 leaf）。

import { filterUserVisibleSkills, SkillSummary } from '../skills';
import { T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW_SOFT, T_FONT } from './terminal-theme';
import { showToast } from './toast';

export interface EditorCompletionDeps {
  checkContext(): boolean;
  bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }>;
  apiEndpointForProfile(apiUrl: string, path: string): string;
  executeToolCallReturn(toolCall: any): Promise<{ sendable: boolean; output: string }>;
  getSiteConfig(): { editor: string; sendBtn: string; fillMethod: string };
  querySelectorFirst(selectors: string): HTMLElement | null;
  getNativeSetter(): ((this: unknown, v: string) => void) | undefined;
  /** 手动发送的 prompt 上报（会话激活 / 上下文追踪 / TUI 镜像，去重由调用方做）。 */
  onPromptSubmitted(text: string): void;
}

let deps!: EditorCompletionDeps;
export function initEditorCompletionDeps(d: EditorCompletionDeps): void {
  deps = d;
}

let skillsCache: SkillSummary[] | null = null;
let skillsCacheTime = 0;
const filesCache = new Map<string, { ts: number; files: string[] }>();
const FILES_TTL = 5000;

async function fetchSkills(): Promise<SkillSummary[]> {
  if (!deps.checkContext()) return [];
  if (skillsCache && Date.now() - skillsCacheTime < 30000) return skillsCache;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await deps.bgFetch(deps.apiEndpointForProfile(apiUrl, '/skills'), { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    skillsCache = data.skills || [];
    skillsCacheTime = Date.now();
    return skillsCache!;
  } catch { return []; }
}

async function loadSkillContent(skillName: string): Promise<string | null> {
  const callId = `skill_${Math.random().toString(36).slice(2, 8)}`;
  const result = await deps.executeToolCallReturn({
    name: 'skill',
    call_id: callId,
    args: { skill: skillName },
  });
  if (!result.sendable) return null;
  const output = result.output.trim();
  return output || null;
}

function formatSkillInsertion(skillName: string, content: string): string {
  return [
    `请加载并遵循下面的 PierCode skill。`,
    '',
    `<skill name="${skillName}">`,
    content.trim(),
    '</skill>',
    '',
    '任务：',
  ].join('\n');
}

async function fetchFiles(q: string): Promise<string[]> {
  if (!deps.checkContext()) return [];
  const cached = filesCache.get(q);
  if (cached && Date.now() - cached.ts < FILES_TTL) return cached.files;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await deps.bgFetch(`${apiUrl}/files?q=${encodeURIComponent(q)}`, { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    const files = data.files || [];
    filesCache.set(q, { ts: Date.now(), files });
    return files;
  } catch { return []; }
}

function showPickerPopup(
  anchorEl: HTMLElement,
  items: Array<{ label: string; sub?: string; value: string }>,
  onSelect: (value: string) => void,
  onDismiss: () => void
): () => void {
  const popup = document.createElement('div');
  popup.style.cssText = `position:fixed;z-index:2147483647;background:${T_PANEL};border:1px solid ${T_LINE};border-radius:8px;padding:4px;min-width:240px;max-width:400px;max-height:240px;overflow-y:auto;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT}`;

  let activeIdx = 0;
  const rows: HTMLElement[] = [];

  function render() {
    popup.innerHTML = '';
    rows.length = 0;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `padding:8px 12px;color:${T_DIM};font-size:12px`;
      empty.textContent = '无匹配项';
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = `padding:6px 12px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:2px;background:${i === activeIdx ? T_PANEL2 : 'transparent'}`;
      const label = document.createElement('span');
      label.style.cssText = `color:${T_TXT};font-size:13px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
      label.textContent = item.label;
      row.appendChild(label);
      if (item.sub) {
        const sub = document.createElement('span');
        sub.style.cssText = `color:${T_DIM};font-size:11px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
        sub.title = item.sub;
        sub.textContent = item.sub;
        row.appendChild(sub);
      }
      row.onmouseenter = () => { setActive(i); };
      row.onclick = () => { onSelect(item.value); destroy(); };
      rows.push(row);
      popup.appendChild(row);
    });
  }

  function setActive(i: number) {
    if (rows[activeIdx]) rows[activeIdx].style.background = 'transparent';
    activeIdx = i;
    if (rows[activeIdx]) {
      rows[activeIdx].style.background = T_PANEL2;
      rows[activeIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  function reposition() {
    const rect = anchorEl.getBoundingClientRect();
    const popupH = Math.min(240, popup.scrollHeight || 240);
    const spaceAbove = rect.top - 6;
    const spaceBelow = window.innerHeight - rect.bottom - 6;
    if (spaceAbove >= popupH || spaceAbove >= spaceBelow) {
      popup.style.top = `${Math.max(4, rect.top - popupH - 6)}px`;
    } else {
      popup.style.top = `${rect.bottom + 6}px`;
    }
    popup.style.left = `${rect.left}px`;
    popup.style.width = `${Math.min(400, rect.width)}px`;
  }

  render();
  document.body.appendChild(popup);
  reposition();

  function onKeyDown(e: KeyboardEvent) {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSelect(items[activeIdx].value); destroy(); }
    else if (e.key === 'Escape') { onDismiss(); destroy(); }
  }

  function onMouseDown(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) { onDismiss(); destroy(); }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  function destroy() {
    popup.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }

  return destroy;
}

export function getEditorText(el: HTMLElement): string {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).value;
  }
  return el.innerText || '';
}

function getCaretPosition(el: HTMLElement): number {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).selectionStart ?? 0;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

export function effectiveFillMethod(el: HTMLElement, configuredFillMethod: string): string {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return 'value';
  if (el.isContentEditable && configuredFillMethod === 'value') return 'execCommand';
  return configuredFillMethod;
}

function replaceTokenInEditor(el: HTMLElement, token: string, replacement: string, fillMethod: string) {
  const method = effectiveFillMethod(el, fillMethod);
  if (method === 'value') {
    const ta = el as HTMLTextAreaElement;
    const val = ta.value;
    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const newVal = val.slice(0, tokenStart) + replacement + after;
    const nativeSetter = deps.getNativeSetter();
    if (nativeSetter) nativeSetter.call(ta, newVal);
    else ta.value = newVal;
    const newCaret = tokenStart + replacement.length;
    ta.setSelectionRange(newCaret, newCaret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (method === 'execCommand' || method === 'prosemirror') {
    // prosemirror 也通过 execCommand insertText 拦截，不能直接写 innerHTML
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const text = getEditorText(el);
    const pos = getCaretPosition(el);
    const before = text.slice(0, pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode: Text | null = null, startOffset = 0;
    let endNode: Text | null = null, endOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const len = node.textContent?.length ?? 0;
      if (!startNode && charCount + len > tokenStart) {
        startNode = node;
        startOffset = tokenStart - charCount;
      }
      if (startNode && !endNode && charCount + len >= tokenStart + token.length) {
        endNode = node;
        endOffset = tokenStart + token.length - charCount;
        break;
      }
      charCount += len;
    }
    if (startNode && endNode) {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, replacement);
    }
  } else {
    // paste fallback (DeepSeek/Slate)：先删除 token，再粘贴
    const ta = el as HTMLTextAreaElement;
    const val = ta.tagName === 'TEXTAREA' ? ta.value : el.innerText;
    const tokenStart = val.lastIndexOf(token);
    if (tokenStart !== -1 && ta.tagName === 'TEXTAREA') {
      const newVal = val.slice(0, tokenStart) + val.slice(tokenStart + token.length);
      const nativeSetter = deps.getNativeSetter();
      if (nativeSetter) nativeSetter.call(ta, newVal);
      else ta.value = newVal;
      ta.setSelectionRange(tokenStart, tokenStart);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', replacement);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  }
}

const attachedInputEditors = new WeakSet<HTMLElement>();
let sendClickListenerAttached = false;

export function attachInputListener(editorEl: HTMLElement) {
  if (attachedInputEditors.has(editorEl)) return;
  attachedInputEditors.add(editorEl);

  const { fillMethod } = deps.getSiteConfig();
  let destroyPicker: (() => void) | null = null;
  let inputVersion = 0;

  function dismiss() {
    if (destroyPicker) { destroyPicker(); destroyPicker = null; }
  }

  function logSubmittedPrompt(activeEditor: HTMLElement): void {
    const text = getEditorText(activeEditor).trim();
    if (!text) return;
    deps.onPromptSubmitted(text);
  }

  editorEl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    logSubmittedPrompt(editorEl);
  }, true);

  if (!sendClickListenerAttached) {
    sendClickListenerAttached = true;
    document.addEventListener('click', event => {
      const target = event.target as Element | null;
      if (!target) return;
      const siteConfig = deps.getSiteConfig();
      if (!target.closest(siteConfig.sendBtn)) return;
      const activeEditor = deps.querySelectorFirst(siteConfig.editor) || editorEl;
      logSubmittedPrompt(activeEditor);
    }, true);
  }

  async function updateCompletions() {
    const currentVersion = ++inputVersion;
    const text = getEditorText(editorEl);
    const pos = getCaretPosition(editorEl);
    const before = text.slice(0, pos);

    const slashMatch = before.match(/(?:^|[\s\n\u00a0])(\/([\w-]*))$/);
    if (slashMatch) {
      const token = slashMatch[1];
      const query = slashMatch[2].toLowerCase();
      const skills = filterUserVisibleSkills(await fetchSkills());
      if (currentVersion !== inputVersion) return;
      const filtered = query
        ? skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
        : skills;
      dismiss();
      if (filtered.length === 0) return;
      destroyPicker = showPickerPopup(
        editorEl,
        filtered.map(s => ({
          label: s.name,
          sub: s.description,
          value: s.name,
        })),
        async (skillName) => {
          dismiss();
          // Slash skill selection is a local UX shortcut: insert a bounded
          // instruction wrapper plus resolved SKILL.md content, not a visible
          // tool-call fence that the assistant must execute later.
          const content = await loadSkillContent(skillName);
          if (!content) {
            showToast(`加载 skill ${skillName} 失败`, 5000);
            return;
          }
          replaceTokenInEditor(editorEl, token, formatSkillInsertion(skillName, content), fillMethod);
        },
        dismiss
      );
      return;
    }

    const atMatch = before.match(/@([^\s]*)$/);
    if (atMatch) {
      const token = atMatch[0];
      const query = atMatch[1];
      const files = await fetchFiles(query);
      if (currentVersion !== inputVersion) return;
      dismiss();
      if (files.length === 0) return;
      destroyPicker = showPickerPopup(
        editorEl,
        files.map(f => ({ label: f, value: f })),
        (path) => { replaceTokenInEditor(editorEl, token, path, fillMethod); dismiss(); },
        dismiss
      );
      return;
    }

    dismiss();
  }

  let completionTimer: number | null = null;
  function scheduleCompletionUpdate() {
    if (completionTimer !== null) window.clearTimeout(completionTimer);
    completionTimer = window.setTimeout(() => {
      completionTimer = null;
      void updateCompletions();
    }, 0);
  }

  editorEl.addEventListener('input', scheduleCompletionUpdate);
  editorEl.addEventListener('keyup', event => {
    if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      scheduleCompletionUpdate();
    }
  }, true);
  editorEl.addEventListener('compositionend', scheduleCompletionUpdate);
}
