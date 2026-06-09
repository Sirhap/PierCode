// 状态面板：AI 页面右下角悬浮。折叠成圆点，点击展开显示
// 操作状态 / AI 提供商 / token 计量 / 控制的 tab。stealth 隐藏；展开态存 storage。

import type { TokenMeter } from './token-meter';
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

type AgentRow = { label: string; status: string };

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

  // 后台子 agent（API 路由，无可见 UI）：加一行 label · status · ✕。
  // 容器挂在 root 上（独立于 paint() 的 innerHTML 重写），点 ✕ 复用既有取消路径
  // —— 向 background 发 CHAT_AGENT_ABORT，触发 chat-api.ts 的 agentAborts.abort()。
  addAgent(agentId: string, label: string): void {
    const t = this.agentRemoveTimers.get(agentId);
    if (t) { clearTimeout(t); this.agentRemoveTimers.delete(agentId); }
    this.agents.set(agentId, { label, status: 'running' });
    if (!this.root) this.ensureDom();
    this.renderAgents();
  }

  setAgentDone(agentId: string, status: string): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.status = status;
    this.renderAgents();
    // 终态行短暂保留以示结果，~4s 后自动移除。
    const prev = this.agentRemoveTimers.get(agentId);
    if (prev) clearTimeout(prev);
    this.agentRemoveTimers.set(agentId, setTimeout(() => {
      this.agents.delete(agentId);
      this.agentRemoveTimers.delete(agentId);
      this.renderAgents();
    }, 4000));
  }

  private renderAgents(): void {
    if (!this.agentsBox) return;
    this.agentsBox.replaceChildren();
    if (this.agents.size === 0) {
      this.agentsBox.style.display = 'none';
      this.repositionStack();
      return;
    }
    this.agentsBox.style.display = 'block';

    const head = document.createElement('div');
    head.textContent = `⌁ 子 agent (${this.agents.size})`;
    head.style.cssText = `font-weight:600;color:${T_GLOW};margin-bottom:2px;`;
    this.agentsBox.appendChild(head);

    for (const [agentId, info] of this.agents) {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:6px;margin-top:4px;`;

      const dot = document.createElement('span');
      const running = info.status === 'running';
      dot.style.cssText = `flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:${running ? T_AMBER : (info.status === 'error' ? T_RED : T_GLOW)};`;

      const name = document.createElement('span');
      name.textContent = info.label;
      name.style.cssText = `flex:1 1 auto;color:${T_TXT};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

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
        btn.style.cssText = `all:unset;flex:0 0 auto;cursor:pointer;color:${T_DIM};font-size:11px;line-height:1;padding:0 2px;`;
        btn.addEventListener('mouseenter', () => { btn.style.color = T_RED; });
        btn.addEventListener('mouseleave', () => { btn.style.color = T_DIM; });
        btn.addEventListener('click', () => {
          try { chrome.runtime?.sendMessage?.({ type: 'CHAT_AGENT_ABORT', agentId }); } catch {}
        });
        row.appendChild(btn);
      }
      this.agentsBox.appendChild(row);
    }
    this.repositionStack();
  }

  // 仅供测试：强制展开。
  expandForTest(): void {
    this.expanded = true;
    this.paint();
  }

  destroy(): void {
    if (this.resetTimer) { clearTimeout(this.resetTimer); this.resetTimer = null; }
    for (const t of this.agentRemoveTimers.values()) clearTimeout(t);
    this.agentRemoveTimers.clear();
    this.agents.clear();
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

    // 子 agent 浮层：独立卡，常驻于圆点上方（即便面板折叠也显示后台活动）。
    // 它在 panel 之后追加，所以 root 的第一个 <div> 仍是 panel（既有测试依赖此结构）。
    // 容器独立于 panel 的 innerHTML 重写，故行内 ✕ 的事件监听器不会被 paint() 抹掉。
    // marginBottom（在 paint() 中按面板是否展开动态调整）让两卡竖向堆叠不重叠。
    const agentsBox = document.createElement('div');
    agentsBox.setAttribute('data-piercode-status-agents', '');
    agentsBox.style.cssText = `
      all: initial; font-family: ${T_FONT};
      position: absolute; right: 0; bottom: 22px; min-width: 220px; max-width: 280px;
      background: ${T_PANEL}; color: ${T_TXT}; border-radius: 10px;
      border: 1px solid ${T_LINE}; box-shadow: 0 0 0 1px ${T_GLOW_SOFT}, 0 4px 16px rgba(0,0,0,0.5);
      padding: 8px 12px; font-size: 12px; line-height: 1.5; display: none;
    `;
    agentsBox.onclick = (e) => e.stopPropagation();

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

  // 让 panel（展开时）与 agentsBox（有子 agent 时）竖向堆叠不重叠：
  // agentsBox 贴圆点；panel 在其上方，按 agentsBox 实测高度抬升。
  private repositionStack(): void {
    if (!this.panel || !this.agentsBox) return;
    const agentsVisible = this.agentsBox.style.display !== 'none';
    const gap = 8;
    const lift = agentsVisible ? this.agentsBox.offsetHeight + gap : 0;
    this.panel.style.bottom = `${22 + lift}px`;
  }

  private paint(): void {
    if (!this.dot || !this.panel) return;
    this.dot.style.background = OP_COLORS[this.op];
    if (!this.expanded) { this.panel.style.display = 'none'; this.repositionStack(); return; }

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
    this.repositionStack();
  }
}

export const statusPanel = new StatusPanel();
