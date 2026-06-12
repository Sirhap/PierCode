// 状态面板：AI 页面右下角悬浮。折叠成圆点，点击展开显示
// 操作状态 / AI 提供商 / token 计量 / 控制的 tab。stealth 隐藏；展开态存 storage。
// 子 agent 卡独立悬浮于页面右上角（addAgent/appendAgentChunk/setAgentDone）。

import type { TokenMeter } from './token-meter';
import { extractFenceToolCalls } from '../parser';
import { T_PANEL, T_LINE, T_DIM, T_TXT, T_GLOW, T_GLOW_SOFT, T_AMBER, T_RED, T_FONT } from './terminal-theme';

const PANEL_STORAGE_KEY = 'statusPanelExpanded';
const Z = '2147483645';

export type OpState = 'idle' | 'thinking' | 'executing' | 'done' | 'error';
export type ControlledTabInfo = { tabId: number; title: string; url: string };

const OP_LABELS: Record<OpState, string> = {
  idle: '空闲',
  thinking: '思考中',
  executing: '执行工具',
  done: '完成',
  error: '错误',
};
const OP_COLORS: Record<OpState, string> = {
  idle: T_DIM,
  thinking: T_GLOW,
  executing: T_AMBER,
  done: T_GLOW,
  error: T_RED,
};

export function opStateLabel(s: OpState): string {
  return OP_LABELS[s];
}

function fmt(n: number): string {
  if (n >= 1_000_000) return trimFixed(n / 1_000_000, 2) + 'm';
  if (n >= 1_000) return trimFixed(n / 1_000, 1) + 'k';
  return String(n);
}

function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$|(?<=[1-9])0+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

const ACC_LABEL: Record<string, string> = { exact: '精确', approx: '近似', estimate: '估算' };

type AgentRow = { label: string; status: string; transcript: string; task?: string; error?: string };

// summarizeToolArgs / clip：从工具调用参数里挑最有代表性的一项做单行预览
// （与 sidebar/subagent-ui.ts 同逻辑；不 import sidebar 模块避免跨入口共享 chunk）。
const PREVIEW_KEYS = ['path', 'file_path', 'cmd', 'command', 'pattern', 'url', 'task', 'label', 'query'];

function clipPreview(s: string): string {
  const line = s.split('\n')[0];
  return line.length > 40 ? line.slice(0, 39) + '…' : line;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  for (const key of PREVIEW_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return clipPreview(v.trim());
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim()) return clipPreview(v.trim());
  }
  return '';
}

// stripToolFences 去掉 transcript 里的围栏块（工具调用等），留纯文本输出做终态摘要。
function stripToolFences(text: string): string {
  return text.replace(/```[\w-]*\n[\s\S]*?\n```/g, '').replace(/\n{3,}/g, '\n\n');
}

// currentToolPreview 从累计 transcript 解析已闭合的工具调用，取最后一个做
// 「当前工具」预览。流中未闭合 fence 解析为空 → 返回 null（显示任务片段兜底）。
function agentToolCalls(transcript: string): Array<{ name: string; preview: string }> {
  if (!transcript) return [];
  try {
    return extractFenceToolCalls(transcript).map(tc => ({ name: tc.name, preview: summarizeToolArgs(tc.args) }));
  } catch {
    return [];
  }
}

class StatusPanel {
  private root: HTMLElement | null = null;
  private dot: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private agentsBox: HTMLElement | null = null;
  private expanded = false;
  private stealth = false;
  private op: OpState = 'idle';
  private provider = '';
  private profile = '';
  private meter: TokenMeter | null = null;
  private threshold = 0;
  private tab: ControlledTabInfo | null = null;
  private agents = new Map<string, AgentRow>();
  private agentRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private expandedAgentId: string | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.expanded || !this.root) return;
    const target = event.target;
    if (target instanceof Node && this.root.contains(target)) return;
    this.collapse();
  };

  init(): void {
    if (this.root || typeof document === 'undefined') return;
    try {
      chrome.storage?.local?.get([PANEL_STORAGE_KEY], (res) => {
        this.expanded = res?.[PANEL_STORAGE_KEY] === true;
        this.mount();
      });
    } catch {
      // storage 不可用时落到下方同步构建。
    }
    // 同步构建一次，便于无 storage 的环境（测试）立即拿到 DOM。
    this.mount();
  }

  // mount 构建 DOM。document_start 注入时 body 尚未就绪——挂 DOMContentLoaded 兜底，
  // 避免 ensureDom 静默早退导致面板永不出现。
  private mount(): void {
    if (this.root) return;
    if (typeof document !== 'undefined' && !document.body) {
      document.addEventListener('DOMContentLoaded', () => { this.ensureDom(); this.paint(); }, { once: true });
      return;
    }
    this.ensureDom();
    this.paint();
  }

  configure(opts: { stealth: boolean }): void {
    if (opts.stealth === this.stealth) return;
    this.stealth = opts.stealth;
    this.applyVisibility();
  }

  setOpState(s: OpState): void {
    this.op = s;
    if (this.resetTimer) { clearTimeout(this.resetTimer); this.resetTimer = null; }
    if (s === 'done') this.resetTimer = setTimeout(() => { this.op = 'idle'; this.paint(); }, 1500);
    if (s === 'error') this.resetTimer = setTimeout(() => { this.op = 'idle'; this.paint(); }, 2000);
    if (!this.root) this.ensureDom();
    this.paint();
  }

  setProvider(name: string, profile: string): void {
    this.provider = name;
    this.profile = profile;
    if (!this.root) this.ensureDom();
    this.paint();
  }

  setMeter(meter: TokenMeter, threshold: number): void {
    this.meter = meter;
    this.threshold = threshold;
    if (!this.root) this.ensureDom();
    this.paint();
  }

  setControlledTab(info: ControlledTabInfo | null): void {
    this.tab = info;
    if (!this.root) this.ensureDom();
    this.paint();
  }

  // 后台子 agent（API 路由，无可见 UI）：右上角浮卡，一 agent 一行
  // label · 当前工具预览 · status · ✕。点 ✕ 复用既有取消路径
  // —— 向 background 发 CHAT_AGENT_ABORT，触发 chat-api.ts 的 agentAborts.abort()。
  addAgent(agentId: string, label: string, task?: string): void {
    const t = this.agentRemoveTimers.get(agentId);
    if (t) { clearTimeout(t); this.agentRemoveTimers.delete(agentId); }
    this.agents.set(agentId, { label, status: 'running', transcript: '', task });
    if (!this.root) this.ensureDom();
    this.renderAgents();
  }

  // appendAgentChunk 累积该 agent 的流式输出（CHAT_AGENT_STREAM），用于解析
  // 「当前工具调用」预览。渲染节流 ~150ms，避免每个 chunk 全量重建 DOM。
  appendAgentChunk(agentId: string, chunk: string): void {
    const a = this.agents.get(agentId);
    if (!a || !chunk) return;
    a.transcript += chunk;
    if (this.agentRenderTimer) return;
    this.agentRenderTimer = setTimeout(() => {
      this.agentRenderTimer = null;
      this.renderAgents();
    }, 150);
  }

  setAgentDone(agentId: string, status: string, error?: string): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.status = status;
    if (error) a.error = error;
    this.renderAgents();
    this.scheduleAgentRemoval(agentId, 6000);
  }

  // 终态行保留一段时间以便查看；行处于展开态时不移除（推迟重查），
  // 收起后下一轮计时器把它清掉。
  private scheduleAgentRemoval(agentId: string, delayMs: number): void {
    const prev = this.agentRemoveTimers.get(agentId);
    if (prev) clearTimeout(prev);
    this.agentRemoveTimers.set(agentId, setTimeout(() => {
      if (this.expandedAgentId === agentId) {
        this.scheduleAgentRemoval(agentId, 4000);
        return;
      }
      this.agents.delete(agentId);
      this.agentRemoveTimers.delete(agentId);
      this.renderAgents();
    }, delayMs));
  }

  private renderAgents(): void {
    if (!this.agentsBox) return;
    this.agentsBox.replaceChildren();
    if (this.agents.size === 0) {
      this.agentsBox.style.display = 'none';
      return;
    }
    this.agentsBox.style.display = 'block';

    const head = document.createElement('div');
    head.textContent = `⌁ 子 agent (${this.agents.size})`;
    head.style.cssText = `font-weight:600;color:${T_GLOW};margin-bottom:2px;`;
    this.agentsBox.appendChild(head);

    for (const [agentId, info] of this.agents) {
      const running = info.status === 'running';
      const expanded = this.expandedAgentId === agentId;
      const calls = agentToolCalls(info.transcript);

      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;`;
      if (info.task) row.title = info.task;
      // 点行切换展开详情（工具调用树 + 输出）。✕ 按钮 stopPropagation 不触发。
      row.addEventListener('click', () => {
        this.expandedAgentId = expanded ? null : agentId;
        this.renderAgents();
      });

      const dot = document.createElement('span');
      dot.style.cssText = `flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:${running ? T_AMBER : (info.status === 'error' ? T_RED : T_GLOW)};${running ? 'animation:piercode-agent-pulse 1.2s ease-in-out infinite;' : ''}`;

      const name = document.createElement('span');
      name.textContent = `@${info.label}`;
      name.style.cssText = `flex:0 0 auto;max-width:96px;color:${T_GLOW};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

      const st = document.createElement('span');
      st.textContent = running ? '运行中' : (info.status === 'error' ? '已停止' : '完成');
      st.style.cssText = `flex:0 0 auto;color:${running ? T_AMBER : (info.status === 'error' ? T_RED : T_DIM)};font-size:10px;`;

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(st);

      if (running) {
        const btn = document.createElement('button');
        btn.textContent = '✕';
        btn.title = '取消子 agent';
        btn.style.cssText = `all:unset;flex:0 0 auto;cursor:pointer;color:${T_DIM};font-size:11px;line-height:1;padding:0 2px;margin-left:auto;`;
        btn.addEventListener('mouseenter', () => { btn.style.color = T_RED; });
        btn.addEventListener('mouseleave', () => { btn.style.color = T_DIM; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          try { chrome.runtime?.sendMessage?.({ type: 'CHAT_AGENT_ABORT', agentId }); } catch {}
        });
        row.appendChild(btn);
      }

      const caret = document.createElement('span');
      caret.textContent = expanded ? '▾' : '▸';
      caret.style.cssText = `flex:0 0 auto;color:${T_DIM};font-size:10px;${running ? '' : 'margin-left:auto;'}`;
      row.appendChild(caret);
      this.agentsBox.appendChild(row);

      if (!expanded) {
        // 折叠态预览行：运行中 = 当前（最后一个已闭合）工具调用；终态 = 调用数 / 错误。
        const sub = document.createElement('div');
        sub.style.cssText = `display:flex;align-items:baseline;gap:4px;margin:1px 0 0 12px;font-size:10px;color:${T_DIM};overflow:hidden;`;
        if (running) {
          const cur = calls[calls.length - 1];
          const text = cur ? `${cur.name} ${cur.preview}`.trim() : '…';
          sub.innerHTML = `<span style="flex:0 0 auto;">⎿</span><span style="flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(text)}</span>`;
        } else if (info.status === 'error' && info.error) {
          sub.innerHTML = `<span style="flex:0 0 auto;color:${T_RED};">⎿</span><span style="flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${T_RED};">${escapeHtml(info.error.slice(0, 60))}</span>`;
        } else {
          sub.innerHTML = `<span style="flex:0 0 auto;">⎿</span><span>${calls.length} 工具调用</span>`;
        }
        this.agentsBox.appendChild(sub);
        continue;
      }

      // 展开态：⏺ 任务 + 完整工具调用树 + 终态输出（Claude Code ⏺/⎿ 风格）。
      const detail = document.createElement('div');
      detail.style.cssText = `margin:2px 0 4px 10px;max-height:200px;overflow-y:auto;font-size:10px;line-height:1.5;`;
      detail.onclick = (e) => e.stopPropagation();

      if (info.task) {
        const taskLine = document.createElement('div');
        taskLine.style.cssText = `display:flex;align-items:flex-start;gap:4px;color:${T_TXT};`;
        taskLine.innerHTML = `<span style="flex:0 0 auto;color:${running ? T_AMBER : (info.status === 'error' ? T_RED : T_GLOW)};">⏺</span><span style="white-space:pre-wrap;word-break:break-all;">${escapeHtml(info.task.slice(0, 200))}</span>`;
        detail.appendChild(taskLine);
      }
      if (calls.length === 0) {
        const none = document.createElement('div');
        none.textContent = '（暂无工具调用）';
        none.style.cssText = `margin-left:12px;color:${T_DIM};`;
        detail.appendChild(none);
      }
      for (const c of calls) {
        const callLine = document.createElement('div');
        callLine.style.cssText = `display:flex;align-items:baseline;gap:4px;margin-left:12px;overflow:hidden;`;
        callLine.innerHTML = `<span style="flex:0 0 auto;color:${T_DIM};">⎿</span><span style="flex:0 0 auto;color:${T_GLOW};">${escapeHtml(c.name)}</span><span style="flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${T_DIM};">${escapeHtml(c.preview)}</span>`;
        detail.appendChild(callLine);
      }
      if (!running) {
        const tail = document.createElement('div');
        const out = info.status === 'error' && info.error
          ? info.error
          : stripToolFences(info.transcript).trim().slice(-400) || '(无输出)';
        tail.style.cssText = `display:flex;align-items:flex-start;gap:4px;margin-left:12px;color:${info.status === 'error' ? T_RED : T_DIM};`;
        tail.innerHTML = `<span style="flex:0 0 auto;">⎿</span><span style="white-space:pre-wrap;word-break:break-all;">${escapeHtml(out)}</span>`;
        detail.appendChild(tail);
      }
      this.agentsBox.appendChild(detail);
    }
  }

  // 仅供测试：强制展开。
  expandForTest(): void {
    this.expanded = true;
    this.paint();
  }

  destroy(): void {
    if (this.resetTimer) { clearTimeout(this.resetTimer); this.resetTimer = null; }
    if (this.agentRenderTimer) { clearTimeout(this.agentRenderTimer); this.agentRenderTimer = null; }
    for (const t of this.agentRemoveTimers.values()) clearTimeout(t);
    this.agentRemoveTimers.clear();
    this.agents.clear();
    this.expandedAgentId = null;
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    this.root?.remove();
    this.root = this.dot = this.panel = this.agentsBox = null;
    this.op = 'idle';
    this.provider = this.profile = '';
    this.meter = null;
    this.threshold = 0;
    this.tab = null;
    this.expanded = false;
    this.stealth = false;
  }

  private ensureDom(): void {
    if (this.root || typeof document === 'undefined' || !document.body) return;
    const root = document.createElement('div');
    root.setAttribute('data-piercode-status-root', '');
    root.style.cssText = `all: initial; position: fixed; right: 40px; bottom: 16px; z-index: ${Z};`;

    const dot = document.createElement('button');
    dot.style.cssText = `
      all: unset; box-sizing: border-box; cursor: pointer;
      width: 14px; height: 14px; border-radius: 50%;
      background: ${OP_COLORS.idle}; border: 2px solid rgba(255,255,255,0.85);
      box-shadow: 0 1px 4px rgba(0,0,0,0.3); display: block;
    `;
    dot.title = 'PierCode 状态面板';
    dot.onclick = () => this.toggle();

    const panel = document.createElement('div');
    panel.style.cssText = `
      all: initial; font-family: ${T_FONT};
      position: absolute; right: 0; bottom: 22px; min-width: 220px; max-width: 280px;
      background: ${T_PANEL}; color: ${T_TXT}; border-radius: 10px;
      border: 1px solid ${T_LINE}; box-shadow: 0 0 0 1px ${T_GLOW_SOFT}, 0 4px 16px rgba(0,0,0,0.5);
      padding: 10px 12px;
      font-size: 12px; line-height: 1.6; display: none;
    `;
    panel.onclick = (e) => e.stopPropagation();

    // 子 agent 浮层：独立卡，固定在页面右上角（不随状态面板/圆点走），
    // 即便面板折叠也显示后台活动。容器独立于 panel 的 innerHTML 重写，
    // 故行内 ✕ 的事件监听器不会被 paint() 抹掉。挂在 root 下以共享
    // stealth 显隐与 destroy 清理，position:fixed 使其脱离 root 定位。
    const agentsBox = document.createElement('div');
    agentsBox.setAttribute('data-piercode-status-agents', '');
    agentsBox.style.cssText = `
      all: initial; font-family: ${T_FONT};
      position: fixed; right: 16px; top: 16px; z-index: ${Z}; min-width: 220px; max-width: 300px;
      background: ${T_PANEL}; color: ${T_TXT}; border-radius: 10px;
      border: 1px solid ${T_LINE}; box-shadow: 0 0 0 1px ${T_GLOW_SOFT}, 0 4px 16px rgba(0,0,0,0.5);
      padding: 8px 12px; font-size: 12px; line-height: 1.5; display: none;
    `;
    agentsBox.onclick = (e) => e.stopPropagation();

    // 运行中圆点的脉冲动画（一次性注入，stealth 不影响样式表）。
    if (!document.getElementById('piercode-agent-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'piercode-agent-pulse-style';
      style.textContent = '@keyframes piercode-agent-pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }';
      (document.head || document.documentElement).appendChild(style);
    }

    root.appendChild(panel);
    root.appendChild(agentsBox);
    root.appendChild(dot);
    document.body.appendChild(root);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    this.root = root;
    this.dot = dot;
    this.panel = panel;
    this.agentsBox = agentsBox;
    this.applyVisibility();
    this.renderAgents();
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    try { chrome.storage?.local?.set({ [PANEL_STORAGE_KEY]: this.expanded }); } catch {}
    this.paint();
  }

  private collapse(): void {
    this.expanded = false;
    try { chrome.storage?.local?.set({ [PANEL_STORAGE_KEY]: false }); } catch {}
    this.paint();
  }

  private applyVisibility(): void {
    if (!this.root) return;
    this.root.style.display = this.stealth ? 'none' : 'block';
  }

  private paint(): void {
    if (!this.dot || !this.panel) return;
    this.dot.style.background = OP_COLORS[this.op];
    if (!this.expanded) { this.panel.style.display = 'none'; return; }

    const provider = this.provider
      ? `${escapeHtml(this.provider)}${this.profile && this.profile !== this.provider ? ' · ' + escapeHtml(this.profile) : ''}`
      : '—';
    const m = this.meter;
    const pct = m && this.threshold > 0 ? Math.min(100, Math.round((m.total / this.threshold) * 100)) : 0;
    const color = pct >= 100 ? T_RED : pct >= 80 ? T_AMBER : T_GLOW;
    const acc = m ? (ACC_LABEL[m.accuracy] || m.accuracy) : '—';

    const tabBlock = this.tab
      ? `<div style="margin-top:8px;border-top:1px solid ${T_LINE};padding-top:6px;color:${T_DIM};">
           <div>控制的 Tab</div>
           <div style="margin-top:2px;color:${T_TXT};">#${this.tab.tabId} · ${escapeHtml(this.tab.title || '(untitled)')}</div>
           <div style="font-size:10px;word-break:break-all;">${escapeHtml(this.tab.url || '')}</div>
         </div>`
      : `<div style="margin-top:8px;border-top:1px solid ${T_LINE};padding-top:6px;color:${T_DIM};opacity:.5;">无受控 Tab</div>`;

    this.panel.style.display = 'block';
    this.panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;color:${T_GLOW};">⌁ PierCode 状态</div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:${T_DIM};">操作</span>
        <span style="color:${OP_COLORS[this.op]};font-weight:600;">${OP_LABELS[this.op]}</span>
      </div>
      <div style="display:flex;justify-content:space-between;"><span style="color:${T_DIM};">提供商</span><span style="color:${T_TXT};">${provider}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:${T_DIM};">输入</span><span style="color:${T_TXT};">${m ? fmt(m.input) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:${T_DIM};">输出</span><span style="color:${T_TXT};">${m ? fmt(m.output) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:600;"><span style="color:${T_DIM};">总计</span><span style="color:${T_TXT};">${m ? fmt(m.total) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:${T_DIM};">阈值</span><span style="color:${T_TXT};">${this.threshold > 0 ? fmt(this.threshold) : '—'}</span></div>
      <div style="margin-top:8px;height:5px;border-radius:3px;background:${T_LINE};overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};transition:width .3s;"></div>
      </div>
      <div style="margin-top:6px;font-size:10px;color:${T_DIM};">${pct}% · ${acc}</div>
      ${tabBlock}
    `;
  }
}

export const statusPanel = new StatusPanel();
