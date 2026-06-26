// Tool card rendering (Claude Code style) extracted from content/index.ts.
//
// Content-bundle leaf: only imports other content-safe leaves (terminal-theme,
// destructive-warning, visual-indicator, status-panel) — no chrome.* at module
// scope, no cross-entry modules, so the classic content.js bundle stays intact.
//
// Execution side effects (HTTP exec, dedup marking, editor backfill, WS stream
// dispatcher registration) live in index.ts and are injected once at bootstrap
// via initToolCardDeps(). renderToolCard is a no-op until deps are set.

import { T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW, T_AMBER, T_RED, T_FONT } from './terminal-theme';
import { getDestructiveCommandWarning } from './destructive-warning';
import { visualIndicator } from './visual-indicator';
import { statusPanel } from './status-panel';
import { saveToolResult, loadToolResult } from './tool-result-store';

// ── 流式工具输出订阅表 ────────────────────────────────────────────────────────
// 同一个 call_id 的 ToolCard 注册自己的 stream/done 回调。index.ts 的
// ensureStreamDispatchers 收到 WS 事件后查表路由。多 tab 都会收到广播，
// 但只有对应卡片所在的 tab 命中。
export type StreamChunkHandler = (stream: 'stdout' | 'stderr', text: string) => void;
export type StreamDoneHandler = (exitCode: number, status: string, errMsg: string, durationMs: number) => void;

export const streamChunkSubs = new Map<string, StreamChunkHandler>();
export const streamDoneSubs = new Map<string, StreamDoneHandler>();

// ── 小工具 ───────────────────────────────────────────────────────────────────

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

export function getToolCallId(data: any): string {
  return String(data?.callId || data?.call_id || '');
}

export function ensureToolCallId(data: any, key: string): any {
  const existing = getToolCallId(data);
  if (existing) {
    return data.callId ? data : { ...data, callId: existing };
  }
  return { ...data, callId: `ol_${Math.abs(hashStr(key)).toString(36)}` };
}

// renderTodoChecklist renders the todo array (from todo_write args) as a
// styled checklist in the given container. Mirrors the Go-side
// formatTodoChecklist so the user sees the same picture regardless of which
// tool ran. Accepts strings or {text/content/title, status} objects.
export function renderTodoChecklist(container: HTMLElement, todos: unknown[]) {
  if (!todos.length) {
    const empty = document.createElement('div');
    empty.textContent = '(任务列表为空)';
    empty.style.cssText = 'color:#888;font-size:12px';
    container.appendChild(empty);
    return;
  }
  const ul = document.createElement('ul');
  ul.style.cssText = 'list-style:none;margin:0;padding:0;font-size:12px';
  todos.forEach((raw, i) => {
    const li = document.createElement('li');
    li.style.cssText = `padding:2px 0;color:${T_TXT}`;
    const { text, status } = todoFieldsTS(raw);
    let marker = '☐';
    let color = T_TXT;
    switch (status.toLowerCase()) {
      case 'completed':
      case 'done':
        marker = '☑'; color = T_GLOW; break;
      case 'in_progress':
      case 'in-progress':
      case 'running':
        marker = '◐'; color = T_AMBER; break;
      case 'blocked':
        marker = '⚠'; color = T_RED; break;
    }
    li.style.color = color;
    li.textContent = `${i + 1}. ${marker} ${text}`;
    if (status.toLowerCase() === 'completed' || status.toLowerCase() === 'done') {
      li.style.textDecoration = 'line-through';
    }
    ul.appendChild(li);
  });
  container.appendChild(ul);
}

function todoFieldsTS(raw: unknown): { text: string; status: string } {
  if (typeof raw === 'string') return { text: raw, status: '' };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of ['text', 'content', 'title', 'description', 'name', 'task']) {
      const v = obj[k];
      if (typeof v === 'string' && v) {
        return { text: v, status: typeof obj.status === 'string' ? obj.status : '' };
      }
    }
    return { text: JSON.stringify(obj), status: typeof obj.status === 'string' ? obj.status : '' };
  }
  return { text: String(raw), status: '' };
}

let toolCardAnimStylesInjected = false;
export function ensureToolCardAnimStyles(): void {
  if (toolCardAnimStylesInjected) return;
  if (typeof document === 'undefined' || !document.head) return;
  const style = document.createElement('style');
  style.setAttribute('data-piercode-tool-card-anim', '');
  style.textContent = `
@keyframes piercodeCardPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.5; }
}
`;
  document.head.appendChild(style);
  toolCardAnimStylesInjected = true;
}

// Locate the actual rendered code block (`<pre>` / platform container) inside
// `sourceEl` whose text is this tool call's JSON. We decorate that block in place
// instead of inserting a separate card above the message — so the animated
// status/collapse sits right on the AI's ```piercode-tool block. Match by
// call_id first (most specific), then by the tool name + a JSON shape, then any
// pre that looks like a tool fence. Returns null if no block can be pinpointed
// (callers fall back to inserting above the message).
export function findToolBlockElement(sourceEl: Element, data: any): HTMLElement | null {
  const callId = getToolCallId(data);
  const name = String(data?.name || '');
  const candidates = Array.from(
    sourceEl.querySelectorAll<HTMLElement>(
      'pre, .qwen-markdown-code, .language-piercode-tool, .language-tool'
    )
  ).filter(el => !el.closest('[data-piercode-key]')); // skip already-decorated

  const looksLikeTool = (t: string) => t.includes('"name"') || t.includes('piercode-tool') || t.includes("'name'");
  // 1) call_id match — must match the WHOLE call_id value, not a bare substring.
  // Two consecutive same-tool blocks (e.g. call_ids "screenshot-1" / "screenshot-12")
  // would mis-match with includes(), so the second block locks onto the first
  // block's <pre> and its own card never anchors. Match the quoted JSON value
  // (and the call_id boundary) so a prefix can't steal another block's element.
  if (callId) {
    const quoted = `"${callId}"`;
    for (const el of candidates) {
      const t = el.textContent || '';
      if (looksLikeTool(t) && t.includes(quoted)) return el;
    }
    // Fallback: bare call_id but bounded by a non-id char on the right, so
    // "screenshot-1" doesn't match inside "screenshot-12".
    const re = new RegExp(escapeRegExp(callId) + '(?![\\w-])');
    for (const el of candidates) {
      const t = el.textContent || '';
      if (looksLikeTool(t) && re.test(t)) return el;
    }
  }
  // 2) name match
  if (name) {
    for (const el of candidates) {
      const t = el.textContent || '';
      if (looksLikeTool(t) && t.includes(`"${name}"`)) return el;
    }
  }
  // 3) any tool-shaped block
  for (const el of candidates) {
    if (looksLikeTool(el.textContent || '')) return el;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// toolCardArgPreview 取最有代表性的参数做头行单行预览（Claude Code 的
// `Bash(go test ./...)` 风格）。优先 command/path 类键，其次第一个字符串值。
export function toolCardArgPreview(a: Record<string, any>): string {
  const keys = ['command', 'cmd', 'path', 'file_path', 'pattern', 'url', 'query', 'task', 'label', 'name'];
  let v = '';
  for (const k of keys) {
    if (typeof a[k] === 'string' && a[k].trim()) { v = a[k].trim(); break; }
  }
  if (!v) {
    const s = Object.values(a).find(x => typeof x === 'string' && (x as string).trim());
    v = s ? (s as string).trim() : '';
  }
  v = v.split('\n')[0];
  return v.length > 60 ? v.slice(0, 59) + '…' : v;
}

// ── 执行依赖注入 ─────────────────────────────────────────────────────────────

export interface ToolCardDeps {
  /** HTTP exec via background; null = extension context invalidated. */
  executeToolCallRaw(toolCall: any): Promise<string | null>;
  /** Per-conversation dedup marking. */
  markExecuted(key: string): void;
  /** Backfill result text into the chat editor (autoSend). */
  fillAndSend(result: string, autoSend?: boolean): Promise<boolean> | boolean;
  /** Register WS tool_stream/tool_done dispatchers (idempotent). */
  ensureStreamDispatchers(): void;
}

let deps: ToolCardDeps | null = null;
export function initToolCardDeps(d: ToolCardDeps): void {
  deps = d;
}

// ── 工具卡 ───────────────────────────────────────────────────────────────────

/** Whether a tool card for this key is currently live in the DOM. Used by the
 *  scan loop to self-heal: during live streaming the SPA can rebuild the <pre>
 *  the card was anchored to, orphaning the card and re-showing the raw block.
 *  When that happens the card is gone but the dedup key was already burned, so
 *  no rescan re-rendered it. Callers check this before honoring `processed`. */
export function isToolCardLive(key: string): boolean {
  return !!document.querySelector(`[data-piercode-key="${CSS.escape(key)}"]`);
}

// subLineEl builds a Claude-Code-style ⎿ indented child row. Shared shape used
// by both the interactive card (closure version inside renderToolCard) and the
// read-only executed card below.
function subLineEl(): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = `display:flex;align-items:baseline;gap:5px;margin:1px 0 0 14px;color:${T_DIM};font-size:11px;min-width:0`;
  const mark = document.createElement('span');
  mark.textContent = '⎿';
  mark.style.cssText = 'flex:0 0 auto';
  d.appendChild(mark);
  return d;
}

// appendResultPreview renders the ⎿ first-line preview + expandable full output,
// mirroring renderToolCard's closure `appendResultSection` but standalone for the
// read-only executed card. No "插入到对话" link — the result is already in the
// conversation (it went through fillAndSend when the tool first ran).
function appendResultPreview(card: HTMLElement, text: string): void {
  const lines = text.split('\n');
  const first = (lines.find(l => l.trim()) || '(无输出)').trim();
  const extra = Math.max(0, lines.length - 1);
  const lineEl = subLineEl();
  const preview = document.createElement('span');
  preview.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  preview.textContent = first.length > 100 ? first.slice(0, 99) + '…' : first;
  lineEl.appendChild(preview);

  const full = document.createElement('div');
  full.style.cssText = `display:none;margin:4px 0 0 14px;padding:6px 8px;background:${T_PANEL2};border-radius:6px;max-height:240px;overflow-y:auto;font-family:${T_FONT};font-size:11px;color:${T_TXT};white-space:pre-wrap;word-break:break-word`;
  full.textContent = text;

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

/** Render a read-only terminal "done" card for an ALREADY-EXECUTED tool whose
 *  interactive card got orphaned by an SPA DOM rebuild. NO exec/background/skip
 *  buttons and it never calls executeToolCallRaw — so re-rendering an executed
 *  tool can never re-trigger execution (the double-exec guard the `isExecuted`
 *  gate protects). Result text (when cached) comes from tool-result-store; a
 *  cache miss degrades to a "已执行，无缓存输出" line. Returns true when a card
 *  is live in the DOM after the call. */
export function renderExecutedCard(data: any, sourceEl: Element, key: string): boolean {
  data = ensureToolCallId(data, key);
  // Already live (e.g. a prior executed-card render) → nothing to do.
  if (isToolCardLive(key)) return true;

  const blockEl = findToolBlockElement(sourceEl, data);
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = blockEl?.parentElement ?? messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return false;

  // A previously-decorated block whose card was orphaned: clear the stale flag so
  // the block-hide below re-applies to the rebuilt node.
  if (blockEl?.getAttribute('data-piercode-decorated') === '1') {
    blockEl.removeAttribute('data-piercode-decorated');
  }

  ensureToolCardAnimStyles();
  const rec = loadToolResult(key);
  const args = data.args || {};

  const card = document.createElement('div');
  card.setAttribute('data-piercode-key', key);
  card.style.cssText = `border:1px solid ${T_LINE};border-radius:8px;padding:7px 10px;margin:8px 0;background:${T_PANEL};color:${T_TXT};font-size:12px;line-height:1.55;font-family:${T_FONT}`;

  // ── 头行：⏺ name(预览) · 状态（done/error 终态，只读）──
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
  const stateMark = document.createElement('span');
  const isError = rec?.status === 'error';
  stateMark.textContent = '⏺';
  stateMark.style.cssText = `flex:0 0 auto;display:inline-block;color:${isError ? T_RED : T_GLOW}`;
  const title = document.createElement('span');
  title.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  title.title = `#${getToolCallId(data)}`;
  const nameSpan = document.createElement('span');
  nameSpan.style.cssText = `font-weight:600;color:${T_TXT}`;
  nameSpan.textContent = String(data.name);
  const argSpan = document.createElement('span');
  argSpan.style.color = T_DIM;
  argSpan.textContent = `(${rec?.argsPreview || toolCardArgPreview(args)})`;
  title.append(nameSpan, argSpan);
  const statusNote = document.createElement('span');
  statusNote.style.cssText = `flex:0 0 auto;margin-left:auto;color:${isError ? T_RED : T_DIM};font-size:11px;white-space:nowrap`;
  statusNote.textContent = rec
    ? (isError ? `error · ${(rec.durationMs / 1000).toFixed(1)}s` : `已执行 · ${(rec.durationMs / 1000).toFixed(1)}s`)
    : '已执行';
  header.append(stateMark, title, statusNote);
  card.appendChild(header);

  // Hide the AI's raw ```piercode-tool block (same as the interactive card), so
  // the executed card replaces the noisy JSON ChatGPT re-rendered.
  if (blockEl) {
    blockEl.setAttribute('data-piercode-decorated', '1');
    const rawDetails = document.createElement('details');
    rawDetails.style.cssText = 'margin:1px 0 0 14px';
    const rawSummary = document.createElement('summary');
    rawSummary.style.cssText = `cursor:pointer;list-style:none;color:${T_DIM};font-size:11px;user-select:none`;
    rawSummary.textContent = '⎿ 原始调用 ▸';
    rawDetails.appendChild(rawSummary);
    card.appendChild(rawDetails);
    const prevDisplay = blockEl.style.display;
    blockEl.style.display = 'none';
    rawDetails.addEventListener('toggle', () => {
      rawSummary.textContent = rawDetails.open ? '⎿ 原始调用 ▾' : '⎿ 原始调用 ▸';
      blockEl.style.display = rawDetails.open ? prevDisplay : 'none';
    });
  }

  // Result preview (from cache) or a no-output placeholder.
  if (rec && rec.output.trim()) {
    appendResultPreview(card, rec.output);
  } else {
    const line = subLineEl();
    const txt = document.createElement('span');
    txt.style.cssText = 'flex:0 1 auto;min-width:0;color:' + T_DIM;
    txt.textContent = '(已执行，无缓存输出)';
    line.appendChild(txt);
    card.appendChild(line);
  }

  if (blockEl && blockEl.parentElement === anchor) {
    anchor.insertBefore(card, blockEl);
  } else {
    anchor.insertBefore(card, messageContent);
  }
  return true;
}

/** Returns true when a card for `key` is present in the DOM after this call
 *  (either freshly inserted or already there), false when it bailed without one
 *  (no anchor, or the anchor vanished). Callers MUST only burn the dedup key on
 *  a true return, so a failed/orphaned render is retried on the next scan. */
export function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>): boolean {
  if (!deps) return false; // bootstrap 未注入依赖（理论上不可达）
  const { executeToolCallRaw, markExecuted, fillAndSend, ensureStreamDispatchers } = deps;
  data = ensureToolCallId(data, key);

  // Prefer in-place decoration of the AI's ```piercode-tool code block. Fall back
  // to inserting above the message only when the block can't be located.
  const blockEl = findToolBlockElement(sourceEl, data);
  // Find stable anchor: message-content's parent, which Angular doesn't rebuild
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = blockEl?.parentElement ?? messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return false;

  // Card already exists (anywhere) → nothing to do, key stays burned.
  if (isToolCardLive(key)) return true;
  // The block was decorated but its card is gone (SPA rebuilt the node and the
  // card was orphaned with the old <pre>). Re-decorate: clear the stale flag and
  // fall through to insert a fresh card.
  if (blockEl?.getAttribute('data-piercode-decorated') === '1') {
    blockEl.removeAttribute('data-piercode-decorated');
  }

  ensureStreamDispatchers();

  const args = data.args || {};
  const isExecCmd = String(data.name).toLowerCase() === 'exec_cmd';
  const card = document.createElement('div');
  card.setAttribute('data-piercode-key', key);
  // Claude Code 风格：单行 ⏺ 头 + 缩进 ⎿ 子行，紧凑、低噪。
  card.style.cssText = `border:1px solid ${T_LINE};border-radius:8px;padding:7px 10px;margin:8px 0;background:${T_PANEL};color:${T_TXT};font-size:12px;line-height:1.55;font-family:${T_FONT}`;

  ensureToolCardAnimStyles();

  // ── 头行：⏺ name(主参数预览) · 状态备注 · 操作链接（执行/后台/忽略）──
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';
  const stateMark = document.createElement('span');
  stateMark.style.cssText = 'flex:0 0 auto;display:inline-block';
  const title = document.createElement('span');
  title.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  title.title = `#${getToolCallId(data)}`;
  const nameSpan = document.createElement('span');
  nameSpan.style.cssText = `font-weight:600;color:${T_TXT}`;
  nameSpan.textContent = String(data.name);
  const argSpan = document.createElement('span');
  argSpan.style.color = T_DIM;
  argSpan.textContent = `(${toolCardArgPreview(args)})`;
  title.append(nameSpan, argSpan);
  const statusNote = document.createElement('span');
  statusNote.style.cssText = `flex:0 0 auto;margin-left:auto;color:${T_DIM};font-size:11px;white-space:nowrap`;
  header.append(stateMark, title, statusNote);

  type CardState = 'pending' | 'running' | 'background' | 'done' | 'error';
  const STATE_META: Record<CardState, { color: string; pulse: boolean }> = {
    pending:    { color: T_DIM,   pulse: false },
    running:    { color: T_AMBER, pulse: true },
    background: { color: T_AMBER, pulse: true },
    done:       { color: T_GLOW,  pulse: false },
    error:      { color: T_RED,   pulse: false },
  };
  function setCardState(s: CardState): void {
    const meta = STATE_META[s];
    stateMark.textContent = '⏺';
    stateMark.style.color = meta.color;
    stateMark.style.animation = meta.pulse ? 'piercodeCardPulse 1s ease-in-out infinite' : 'none';
  }

  function mkLinkBtn(label: string, color: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `all:unset;flex:0 0 auto;cursor:pointer;color:${color};font-size:11px;font-family:${T_FONT};padding:1px 5px;border-radius:4px`;
    b.addEventListener('mouseenter', () => { b.style.background = T_PANEL2; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    return b;
  }
  function setBtnDisabled(b: HTMLButtonElement | null, on: boolean): void {
    if (!b) return;
    b.disabled = on;
    b.style.opacity = on ? '0.35' : '1';
    b.style.pointerEvents = on ? 'none' : 'auto';
  }
  const execBtn = mkLinkBtn('执行', T_GLOW);
  let bgBtn: HTMLButtonElement | null = null;
  if (isExecCmd) bgBtn = mkLinkBtn('后台', T_AMBER);
  const skipBtn = mkLinkBtn('忽略', T_DIM);
  header.appendChild(execBtn);
  if (bgBtn) header.appendChild(bgBtn);
  header.appendChild(skipBtn);

  setCardState('pending');
  card.appendChild(header);

  // ⎿ 子行工厂（Claude Code 缩进风格）。
  function subLine(): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = `display:flex;align-items:baseline;gap:5px;margin:1px 0 0 14px;color:${T_DIM};font-size:11px;min-width:0`;
    const mark = document.createElement('span');
    mark.textContent = '⎿';
    mark.style.cssText = 'flex:0 0 auto';
    d.appendChild(mark);
    return d;
  }

  // #16: optional intent line. When the model supplied a `purpose`, surface it as
  // a short ⎿ line right under the header (above the args) so the user reads WHY
  // the tool runs before approving. Absent purpose → nothing rendered (the card
  // looks exactly as before).
  const purpose = typeof data.purpose === 'string' ? data.purpose.trim() : '';
  if (purpose) {
    const purposeLine = subLine();
    const ptxt = document.createElement('span');
    ptxt.style.cssText = 'flex:0 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word';
    ptxt.textContent = purpose;
    purposeLine.appendChild(ptxt);
    card.appendChild(purposeLine);
  }

  // 参数详情：⎿ 参数 ▸ 折叠行，点击展开键值列表。
  const details = document.createElement('details');
  details.style.cssText = 'margin:1px 0 0 14px';
  const summary = document.createElement('summary');
  summary.style.cssText = `cursor:pointer;list-style:none;color:${T_DIM};font-size:11px;user-select:none`;
  summary.textContent = '⎿ 参数 ▸';
  details.addEventListener('toggle', () => { summary.textContent = details.open ? '⎿ 参数 ▾' : '⎿ 参数 ▸'; });
  details.appendChild(summary);
  const argsBox = document.createElement('div');
  argsBox.style.cssText = `margin:4px 0 4px 14px;padding:6px 8px;background:${T_PANEL2};border-radius:6px`;
  if (String(data.name).toLowerCase() === 'todo_write' && Array.isArray(args.todos)) {
    renderTodoChecklist(argsBox, args.todos);
  } else {
    for (const [k, v] of Object.entries(args)) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:4px';
      const keyLabel = document.createElement('span');
      keyLabel.style.cssText = `color:${T_GLOW};font-size:11px`;
      keyLabel.textContent = k;
      row.appendChild(keyLabel);
      const val = document.createElement('div');
      val.style.cssText = `color:${T_TXT};font-size:11px;font-family:${T_FONT};white-space:pre-wrap;max-height:120px;overflow-y:auto`;
      val.textContent = typeof v === 'string' ? v : JSON.stringify(v);
      row.appendChild(val);
      argsBox.appendChild(row);
    }
  }
  details.appendChild(argsBox);
  card.appendChild(details);

  // In-place mode: hide the AI's raw ```piercode-tool code block (the long JSON)
  // by default and tuck it under a second collapsible inside the card. The user
  // still sees the original text on demand, but the default view is the compact
  // animated status card — replacing the noisy raw block, not stacking above it.
  if (blockEl) {
    blockEl.setAttribute('data-piercode-decorated', '1');
    const rawDetails = document.createElement('details');
    rawDetails.style.cssText = 'margin:1px 0 0 14px';
    const rawSummary = document.createElement('summary');
    rawSummary.style.cssText = `cursor:pointer;list-style:none;color:${T_DIM};font-size:11px;user-select:none`;
    rawSummary.textContent = '⎿ 原始调用 ▸';
    rawDetails.appendChild(rawSummary);
    card.appendChild(rawDetails);
    // Keep the original block in its original DOM position (don't move it — some
    // SPAs re-read/rebuild it), just hide it by default and reveal it when the
    // user expands "原始调用". prevDisplay preserves the platform's own value.
    const prevDisplay = blockEl.style.display;
    blockEl.style.display = 'none';
    rawDetails.addEventListener('toggle', () => {
      rawSummary.textContent = rawDetails.open ? '⎿ 原始调用 ▾' : '⎿ 原始调用 ▸';
      blockEl.style.display = rawDetails.open ? prevDisplay : 'none';
    });
  }

  // Destructive-command warning (exec_cmd only). Informational, does not
  // block execution — surfaces what the command may do before the user clicks 执行.
  if (isExecCmd) {
    const cmdStr = typeof args.command === 'string' ? args.command : (typeof args.cmd === 'string' ? args.cmd : '');
    const warning = getDestructiveCommandWarning(cmdStr);
    if (warning) {
      const warnLine = subLine();
      warnLine.style.color = T_AMBER;
      const wtxt = document.createElement('span');
      wtxt.style.cssText = 'white-space:pre-wrap;word-break:break-word';
      wtxt.textContent = `⚠ 危险命令：${warning}`;
      warnLine.appendChild(wtxt);
      card.appendChild(warnLine);
    }
  }

  // streamBox: only shown once we actually start receiving live chunks.
  // exec_cmd uses this for both foreground streaming and background tasks.
  let streamBox: HTMLDivElement | null = null;
  function ensureStreamBox(): HTMLDivElement {
    if (streamBox) return streamBox;
    streamBox = document.createElement('div');
    streamBox.style.cssText = `margin:4px 0 0 14px;padding:6px 8px;background:${T_PANEL2};border-radius:6px;max-height:160px;overflow-y:auto;font-family:${T_FONT};font-size:11px;color:${T_DIM};white-space:pre-wrap;word-break:break-word`;
    card.appendChild(streamBox);
    return streamBox;
  }
  function appendStreamChunk(stream: 'stdout' | 'stderr', text: string) {
    const box = ensureStreamBox();
    const span = document.createElement('span');
    if (stream === 'stderr') span.style.color = T_RED;
    span.textContent = text;
    box.appendChild(span);
    box.scrollTop = box.scrollHeight;
  }

  // 结果区（Claude Code 风格）：⎿ 首行预览 (+N 行 ▸ 展开) · 插入到对话。
  function appendResultSection(text: string): void {
    const lines = text.split('\n');
    const first = (lines.find(l => l.trim()) || '(无输出)').trim();
    const extra = Math.max(0, lines.length - 1);
    const lineEl = subLine();
    const preview = document.createElement('span');
    preview.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    preview.textContent = first.length > 100 ? first.slice(0, 99) + '…' : first;
    lineEl.appendChild(preview);

    const full = document.createElement('div');
    full.style.cssText = `display:none;margin:4px 0 0 14px;padding:6px 8px;background:${T_PANEL2};border-radius:6px;max-height:240px;overflow-y:auto;font-family:${T_FONT};font-size:11px;color:${T_TXT};white-space:pre-wrap;word-break:break-word`;
    full.textContent = text;

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

    const insertLink = document.createElement('span');
    insertLink.textContent = '插入到对话';
    insertLink.style.cssText = `flex:0 0 auto;margin-left:auto;color:${T_GLOW};cursor:pointer;user-select:none`;
    insertLink.onclick = () => fillAndSend(text, true);
    lineEl.appendChild(insertLink);

    card.appendChild(lineEl);
    card.appendChild(full);
  }

  const callIdForStream = getToolCallId(data);
  let sawStreamChunk = false;

  function unsubscribeStream() {
    if (!callIdForStream) return;
    streamChunkSubs.delete(callIdForStream);
    streamDoneSubs.delete(callIdForStream);
  }

  function subscribe() {
    if (!callIdForStream) return;
    streamChunkSubs.set(callIdForStream, (stream, text) => {
      sawStreamChunk = true;
      appendStreamChunk(stream, text);
    });
    streamDoneSubs.set(callIdForStream, (exitCode, status, errMsg, durationMs) => {
      unsubscribeStream();
      const ok = status === 'done' && exitCode === 0;
      setCardState(ok ? 'done' : 'error');
      statusNote.style.color = ok ? T_DIM : T_RED;
      statusNote.textContent = ok
        ? `${(durationMs / 1000).toFixed(1)}s`
        : `${status} · exit ${exitCode}${errMsg ? ` · ${errMsg}` : ''}`;
      setBtnDisabled(execBtn, true);
      setBtnDisabled(bgBtn, true);
      setBtnDisabled(skipBtn, true);
    });
  }

  execBtn.onclick = async () => {
    const t0 = Date.now();
    setBtnDisabled(execBtn, true);
    setBtnDisabled(bgBtn, true);
    statusNote.textContent = '执行中…';
    setCardState('running');
    subscribe();

    // 显示可视化指示器
    visualIndicator.showPulsingBorder();
    visualIndicator.showStatusBadge('loading');
    statusPanel.setOpState('executing');

    try {
      const text = await executeToolCallRaw(data);
      if (text === null) {
        statusNote.style.color = T_RED;
        statusNote.textContent = '请刷新页面';
        setCardState('error');
        unsubscribeStream();
        visualIndicator.hideAllIndicators();
        return;
      }
      markExecuted(key);
      // Cache the result so a read-only done card can be re-rendered if the SPA
      // later rebuilds the message DOM and orphans this card (ChatGPT does this
      // on stream-finalize). See tool-result-store / renderExecutedCard.
      saveToolResult(key, {
        name: String(data.name),
        argsPreview: toolCardArgPreview(args),
        output: text,
        status: 'done',
        durationMs: Date.now() - t0,
        ts: Date.now(),
      });
      setCardState('done');
      if (statusNote.textContent === '执行中…') statusNote.textContent = '完成';
      setBtnDisabled(skipBtn, true);

      // 显示完成状态
      visualIndicator.showStatusBadge('completed');
      statusPanel.setOpState('done');
      setTimeout(() => visualIndicator.hideAllIndicators(), 1500);

      // For exec_cmd whose live stream already populated streamBox, don't
      // duplicate the full output in a result section — just a slim
      // insert-to-chat line. Non-stream tools (and exec_cmd runs with no
      // chunks) get the ⎿ preview + expandable full output.
      if (isExecCmd && sawStreamChunk) {
        const lineEl = subLine();
        const insertLink = document.createElement('span');
        insertLink.textContent = '插入到对话';
        insertLink.style.cssText = `flex:0 0 auto;color:${T_GLOW};cursor:pointer;user-select:none`;
        insertLink.onclick = () => fillAndSend(text, true);
        lineEl.appendChild(insertLink);
        card.appendChild(lineEl);
      } else {
        appendResultSection(text);
      }
      // For foreground exec_cmd, the HTTP response already carries the final
      // output and the server will not send any tool_done for this call_id.
      // Drop the subscription so the map doesn't leak.
      if (!isExecCmd || (isExecCmd && !data.args?.background)) {
        unsubscribeStream();
      }
    } catch {
      statusNote.style.color = T_RED;
      statusNote.textContent = '执行失败';
      setBtnDisabled(execBtn, false);
      setBtnDisabled(bgBtn, false);
      setCardState('error');
      unsubscribeStream();
      visualIndicator.showStatusBadge('error');
      statusPanel.setOpState('error');
      setTimeout(() => visualIndicator.hideAllIndicators(), 2000);
    }
  };

  if (bgBtn) {
    bgBtn.onclick = async () => {
      const t0 = Date.now();
      setBtnDisabled(bgBtn, true);
      setBtnDisabled(execBtn, true);
      statusNote.textContent = '后台执行中…';
      setCardState('background');
      subscribe();
      // Make a shallow copy with background:true so we don't mutate the
      // original parsed tool call (the AI's text on the page is still the
      // original foreground request).
      const bgData = {
        ...data,
        args: { ...(data.args || {}), background: true },
      };
      try {
        const text = await executeToolCallRaw(bgData);
        if (text === null) {
          statusNote.style.color = T_RED;
          statusNote.textContent = '请刷新页面';
          setCardState('error');
          unsubscribeStream();
          return;
        }
        markExecuted(key);
        saveToolResult(key, {
          name: String(data.name),
          argsPreview: toolCardArgPreview(data.args || {}),
          output: text,
          status: 'done',
          durationMs: Date.now() - t0,
          ts: Date.now(),
        });
        // text contains "[backgrounded as task ...]" — ⎿ 行展示 task_id，
        // 与下方实时流对应。
        const infoLine = subLine();
        infoLine.style.color = T_GLOW;
        const itxt = document.createElement('span');
        itxt.style.cssText = 'white-space:pre-wrap;word-break:break-word';
        itxt.textContent = text;
        infoLine.appendChild(itxt);
        card.appendChild(infoLine);
      } catch {
        statusNote.style.color = T_RED;
        statusNote.textContent = '后台启动失败';
        setBtnDisabled(execBtn, false);
        setBtnDisabled(bgBtn, false);
        setCardState('error');
        unsubscribeStream();
      }
    };
  }

  skipBtn.onclick = () => {
    unsubscribeStream();
    card.remove();
    processed.delete(key);
    markExecuted(key);
  };

  // In-place: drop the card right where the AI's tool block is (the original
  // block is hidden just below it). Otherwise fall back to above the message.
  if (blockEl && blockEl.parentElement === anchor) {
    anchor.insertBefore(card, blockEl);
  } else {
    anchor.insertBefore(card, messageContent);
  }
  return true;
}
