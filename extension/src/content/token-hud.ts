// Token 看板：AI 页面角落悬浮。默认折叠成圆点（颜色随用量/阈值变化），
// 点击展开为面板显示 输入/输出/总计/阈值 + 进度条 + 精度模式。
// stealth 模式下隐藏。折叠/展开状态存 chrome.storage.local 跨页面记忆。

import type { TokenMeter } from './token-meter';

const HUD_STORAGE_KEY = 'tokenHudExpanded';
const Z = '2147483646';

type Ratio = { color: string; label: string };

function ratioStyle(total: number, threshold: number): Ratio {
  const r = threshold > 0 ? total / threshold : 0;
  if (r >= 1) return { color: '#E5484D', label: 'red' };
  if (r >= 0.8) return { color: '#F5A623', label: 'yellow' };
  return { color: '#30A46C', label: 'green' };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return trimFixed(n / 1_000_000, 2) + 'm';
  if (n >= 1_000) return trimFixed(n / 1_000, 1) + 'k';
  return String(n);
}

function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$|(?<=[1-9])0+$/, '');
}

class TokenHud {
  private root: HTMLElement | null = null;
  private dot: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private expanded = false;
  private stealth = false;
  private last: { meter: TokenMeter; threshold: number; platform: string } | null = null;
  private onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.expanded || !this.root) return;
    const target = event.target;
    if (target instanceof Node && this.root.contains(target)) return;
    this.collapse();
  };

  init(): void {
    if (this.root || typeof document === 'undefined') return;
    try {
      chrome.storage?.local?.get([HUD_STORAGE_KEY], (res) => {
        this.expanded = res?.[HUD_STORAGE_KEY] === true;
        this.render();
      });
    } catch {
      this.render();
    }
  }

  configure(opts: { stealth: boolean }): void {
    if (opts.stealth === this.stealth) return;
    this.stealth = opts.stealth;
    this.applyVisibility();
  }

  // update 用最新计量刷新看板。无 root 时先建。
  update(meter: TokenMeter, threshold: number, platform: string): void {
    this.last = { meter, threshold, platform };
    if (!this.root) this.ensureDom();
    this.paint();
  }

  destroy(): void {
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    this.root?.remove();
    this.root = this.dot = this.panel = null;
    this.expanded = false;
    this.last = null;
  }

  private render(): void {
    if (!this.root) this.ensureDom();
    this.paint();
  }

  private ensureDom(): void {
    if (this.root || typeof document === 'undefined' || !document.body) return;
    const root = document.createElement('div');
    root.setAttribute('data-piercode-token-root', '');
    root.style.cssText = `all: initial; position: fixed; right: 16px; bottom: 16px; z-index: ${Z};`;

    const dot = document.createElement('button');
    dot.style.cssText = `
      all: unset; box-sizing: border-box; cursor: pointer;
      width: 14px; height: 14px; border-radius: 50%;
      background: #30A46C; border: 2px solid rgba(255,255,255,0.85);
      box-shadow: 0 1px 4px rgba(0,0,0,0.3); display: block;
    `;
    dot.title = 'PierCode token 看板';
    dot.onclick = () => this.toggle();

    const panel = document.createElement('div');
    panel.style.cssText = `
      all: initial; font-family: -apple-system, system-ui, sans-serif;
      position: absolute; right: 0; bottom: 22px; min-width: 200px;
      background: #1c1c1e; color: #f2f2f7; border-radius: 10px;
      padding: 10px 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      font-size: 12px; line-height: 1.6; display: none;
    `;
    panel.onclick = (e) => e.stopPropagation();

    root.appendChild(panel);
    root.appendChild(dot);
    document.body.appendChild(root);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);

    this.root = root;
    this.dot = dot;
    this.panel = panel;
    this.applyVisibility();
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    try {
      chrome.storage?.local?.set({ [HUD_STORAGE_KEY]: this.expanded });
    } catch {}
    this.paint();
  }

  private collapse(): void {
    this.expanded = false;
    try {
      chrome.storage?.local?.set({ [HUD_STORAGE_KEY]: false });
    } catch {}
    this.paint();
  }

  private applyVisibility(): void {
    if (!this.root) return;
    this.root.style.display = this.stealth ? 'none' : 'block';
  }

  private paint(): void {
    if (!this.dot || !this.panel || !this.last) return;
    const { meter, threshold, platform } = this.last;
    const { color } = ratioStyle(meter.total, threshold);
    this.dot.style.background = color;

    if (this.expanded) {
      const pct = threshold > 0 ? Math.min(100, Math.round((meter.total / threshold) * 100)) : 0;
      const acc = meter.accuracy === 'exact' ? '精确' : '估算';
      this.panel.style.display = 'block';
      this.panel.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;color:#fff;">PierCode · ${escapeHtml(platform)}</div>
        <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">输入</span><span>${fmt(meter.input)}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">输出</span><span>${fmt(meter.output)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:600;"><span style="opacity:.85;">总计</span><span>${fmt(meter.total)}</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="opacity:.7;">阈值</span><span>${fmt(threshold)}</span></div>
        <div style="margin-top:8px;height:5px;border-radius:3px;background:#3a3a3c;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${color};transition:width .3s;"></div>
        </div>
        <div style="margin-top:6px;font-size:10px;opacity:.55;">${pct}% · ${acc}</div>
      `;
    } else {
      this.panel.style.display = 'none';
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

export const tokenHud = new TokenHud();
export { ratioStyle, fmt };
