// 状态面板：AI 页面右下角悬浮，与 tokenHud 错开。折叠成圆点，点击展开显示
// 操作状态 / AI 提供商 / token 计量 / 控制的 tab。stealth 隐藏；展开态存 storage。

import type { TokenMeter } from './token-meter';

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
  idle: '#8E8E93',
  thinking: '#0A84FF',
  executing: '#F5A623',
  done: '#30A46C',
  error: '#E5484D',
};

export function opStateLabel(s: OpState): string {
  return OP_LABELS[s];
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

const ACC_LABEL: Record<string, string> = { exact: '精确', approx: '近似', estimate: '估算' };

class StatusPanel {
  private root: HTMLElement | null = null;
  private dot: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private expanded = false;
  private stealth = false;
  private op: OpState = 'idle';
  private provider = '';
  private profile = '';
  private meter: TokenMeter | null = null;
  private threshold = 0;
  private tab: ControlledTabInfo | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  init(): void {
    if (this.root || typeof document === 'undefined') return;
    try {
      chrome.storage?.local?.get([PANEL_STORAGE_KEY], (res) => {
        this.expanded = res?.[PANEL_STORAGE_KEY] === true;
        this.ensureDom();
        this.paint();
      });
    } catch {
      // storage 不可用时落到下方同步构建。
    }
    // 同步构建一次，便于无 storage 的环境（测试）立即拿到 DOM。
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

  // 仅供测试：强制展开。
  expandForTest(): void {
    this.expanded = true;
    this.paint();
  }

  destroy(): void {
    if (this.resetTimer) { clearTimeout(this.resetTimer); this.resetTimer = null; }
    this.root?.remove();
    this.root = this.dot = this.panel = null;
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
      all: initial; font-family: -apple-system, system-ui, sans-serif;
      position: absolute; right: 0; bottom: 22px; min-width: 220px; max-width: 280px;
      background: #1c1c1e; color: #f2f2f7; border-radius: 10px;
      padding: 10px 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      font-size: 12px; line-height: 1.6; display: none;
    `;
    panel.onclick = (e) => e.stopPropagation();

    root.appendChild(panel);
    root.appendChild(dot);
    document.body.appendChild(root);
    this.root = root;
    this.dot = dot;
    this.panel = panel;
    this.applyVisibility();
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    try { chrome.storage?.local?.set({ [PANEL_STORAGE_KEY]: this.expanded }); } catch {}
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
    const color = pct >= 100 ? '#E5484D' : pct >= 80 ? '#F5A623' : '#30A46C';
    const acc = m ? (ACC_LABEL[m.accuracy] || m.accuracy) : '—';

    const tabBlock = this.tab
      ? `<div style="margin-top:8px;border-top:1px solid #3a3a3c;padding-top:6px;">
           <div style="opacity:.7;">控制的 Tab</div>
           <div style="margin-top:2px;">#${this.tab.tabId} · ${escapeHtml(this.tab.title || '(untitled)')}</div>
           <div style="font-size:10px;opacity:.55;word-break:break-all;">${escapeHtml(this.tab.url || '')}</div>
         </div>`
      : `<div style="margin-top:8px;border-top:1px solid #3a3a3c;padding-top:6px;opacity:.5;">无受控 Tab</div>`;

    this.panel.style.display = 'block';
    this.panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;color:#fff;">PierCode 状态</div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="opacity:.7;">操作</span>
        <span style="color:${OP_COLORS[this.op]};font-weight:600;">${OP_LABELS[this.op]}</span>
      </div>
      <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">提供商</span><span>${provider}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">输入</span><span>${m ? fmt(m.input) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">输出</span><span>${m ? fmt(m.output) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:600;"><span style="opacity:.85;">总计</span><span>${m ? fmt(m.total) : '—'}</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">阈值</span><span>${this.threshold > 0 ? fmt(this.threshold) : '—'}</span></div>
      <div style="margin-top:8px;height:5px;border-radius:3px;background:#3a3a3c;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${color};transition:width .3s;"></div>
      </div>
      <div style="margin-top:6px;font-size:10px;opacity:.55;">${pct}% · ${acc}</div>
      ${tabBlock}
    `;
  }
}

export const statusPanel = new StatusPanel();
