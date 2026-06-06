# Status Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a floating status panel into AI pages showing operation state, AI provider, token usage, and the CDP-controlled tab; activate the currently-dead token pipeline with platform-adaptive accuracy.

**Architecture:** A passive UI singleton (`status-panel.ts`) fed by the content script. The content script aggregates data from `platformAdapter` (provider), tool lifecycle hookpoints (op state), a periodic DOM scan + `computeMeter` (tokens), and a new background broadcast (controlled tab). `token-meter.ts` upgrades to pick the encoder + correction factor per platform and report a 3-tier accuracy label.

**Tech Stack:** TypeScript, Chrome MV3 (content script + service worker), `js-tiktoken`, Vitest + jsdom.

---

## File Structure

New:
- `extension/src/content/status-panel.ts` — UI singleton, pure render + state container
- `extension/src/__tests__/status-panel.test.ts` — jsdom tests

Modified:
- `extension/src/content/token-meter.ts` — platform-adaptive encoder + 3-tier accuracy
- `extension/src/__tests__/token-meter.test.ts` — new cases
- `extension/src/platform-adapters/types.ts` — add `userSelector?`
- `extension/src/platform-adapters/{gemini,claude,chatgpt,qwen}.ts` — add `userSelector`
- `extension/src/content/index.ts` — wire panel, activate token pipeline, listen for controlled-tab
- `extension/src/background/index.ts` — broadcast `PIERCODE_CONTROLLED_TAB`

---

## Task 1: Platform-adaptive token-meter (3-tier accuracy)

**Files:**
- Modify: `extension/src/content/token-meter.ts`
- Test: `extension/src/__tests__/token-meter.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `extension/src/__tests__/token-meter.test.ts`:

```ts
import { platformAccuracy, platformFactor, PLATFORM_TOKEN_FACTOR } from '../content/token-meter';

describe('token-meter platform accuracy tier', () => {
  it('chatgpt is exact', () => {
    expect(platformAccuracy('chatgpt', 'ready')).toBe('exact');
  });
  it('qwen is approx when tokenizer ready', () => {
    expect(platformAccuracy('qwen', 'ready')).toBe('approx');
  });
  it('claude is estimate when tokenizer ready', () => {
    expect(platformAccuracy('claude', 'ready')).toBe('estimate');
  });
  it('any platform is estimate when tokenizer not ready', () => {
    expect(platformAccuracy('chatgpt', 'failed')).toBe('estimate');
  });
});

describe('token-meter platform factor', () => {
  it('chatgpt factor is 1.0', () => {
    expect(platformFactor('chatgpt')).toBe(1.0);
  });
  it('claude factor is 1.15', () => {
    expect(platformFactor('claude')).toBe(1.15);
  });
  it('unknown platform falls back to 1.0', () => {
    expect(platformFactor('totally-unknown')).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npm test -- token-meter`
Expected: FAIL — `platformAccuracy`/`platformFactor`/`PLATFORM_TOKEN_FACTOR` not exported.

- [ ] **Step 3: Implement platform-adaptive logic**

In `extension/src/content/token-meter.ts`, change the accuracy type and add platform helpers. Replace the `TokenAccuracy` type line:

```ts
export type TokenAccuracy = 'exact' | 'approx' | 'estimate';
```

Add a load-state accessor (the module already has internal `loadState`). Export a typed snapshot for tests:

```ts
export type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
export function tokenizerState(): LoadState {
  return loadState;
}
```

Add the factor table + helpers near the top (after the `TokenAccuracy` type):

```ts
// 各平台相对 o200k_base 的经验校正系数（混合中英文/代码）。保守初值，可后续标定。
export const PLATFORM_TOKEN_FACTOR: Record<string, number> = {
  chatgpt: 1.0,
  qwen: 1.0,   // 用 cl100k_base 直接编码，不额外乘系数
  gemini: 1.1,
  claude: 1.15,
};

export function platformFactor(platform: string): number {
  return PLATFORM_TOKEN_FACTOR[platform] ?? 1.0;
}

// 精度档：chatgpt+o200k=精确；qwen+cl100k=近似；其余系数估算。tokenizer 未就绪一律 estimate。
export function platformAccuracy(platform: string, state: LoadState): TokenAccuracy {
  if (state !== 'ready') return 'estimate';
  if (platform === 'chatgpt') return 'exact';
  if (platform === 'qwen') return 'approx';
  if (platform === 'gemini') return 'approx';
  return 'estimate';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test -- token-meter`
Expected: PASS for the new cases (existing cases still pass).

- [ ] **Step 5: Commit**

```bash
git add extension/src/content/token-meter.ts extension/src/__tests__/token-meter.test.ts
git commit -m "feat(extension): platform-adaptive token accuracy tiers"
```

---

## Task 2: Per-platform encoder selection in computeMeter

**Files:**
- Modify: `extension/src/content/token-meter.ts`
- Test: `extension/src/__tests__/token-meter.test.ts`

- [ ] **Step 1: Write failing test**

Add to `extension/src/__tests__/token-meter.test.ts`:

```ts
import { computeMeter } from '../content/token-meter';

describe('computeMeter platform-aware', () => {
  const ctx = (msgs: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => ({
    messages: msgs.map((m, i) => ({ ...m, timestamp: i })),
    totalChars: msgs.reduce((s, m) => s + m.content.length, 0),
  });

  it('applies claude factor (>= raw) to totals', () => {
    const claude = computeMeter(ctx([{ role: 'user', content: 'hello world '.repeat(20) }]), 'claude');
    const chatgpt = computeMeter(ctx([{ role: 'user', content: 'hello world '.repeat(20) }]), 'chatgpt');
    expect(claude.total).toBeGreaterThanOrEqual(chatgpt.total);
    expect(claude.accuracy).toBe('estimate');
  });

  it('chatgpt meter is exact tier', () => {
    const m = computeMeter(ctx([{ role: 'assistant', content: 'reply text here' }]), 'chatgpt');
    expect(m.accuracy).toBe('exact');
    expect(m.output).toBeGreaterThan(0);
    expect(m.input).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npm test -- token-meter`
Expected: FAIL — `computeMeter` takes one arg / accuracy not platform-aware.

- [ ] **Step 3: Implement platform-aware computeMeter**

In `extension/src/content/token-meter.ts`, change `computeMeter` signature and body. The encoder is the existing single `encoder` (o200k); for qwen we want cl100k. Add a second lazy encoder and select by platform.

Replace the encoder singleton block to support two encodings:

```ts
type Encoder = { encode: (text: string) => number[] };
const encoders: Partial<Record<'o200k_base' | 'cl100k_base', Encoder>> = {};
let loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let loadPromise: Promise<void> | null = null;

function encoderFor(platform: string): Encoder | null {
  const name = platform === 'qwen' ? 'cl100k_base' : 'o200k_base';
  return encoders[name] ?? null;
}
```

Update `ensureTiktoken` to load both encodings:

```ts
function ensureTiktoken(): void {
  if (loadState !== 'idle') return;
  loadState = 'loading';
  loadPromise = (async () => {
    try {
      const mod = await import('js-tiktoken');
      encoders.o200k_base = mod.getEncoding('o200k_base') as unknown as Encoder;
      encoders.cl100k_base = mod.getEncoding('cl100k_base') as unknown as Encoder;
      loadState = 'ready';
    } catch (err) {
      console.warn('[PierCode] js-tiktoken 加载失败，回退字符估算:', err);
      loadState = 'failed';
    }
  })();
}
```

Make `countTokens` platform-aware:

```ts
export function countTokens(text: string, platform = 'chatgpt'): number {
  if (!text) return 0;
  ensureTiktoken();
  const enc = loadState === 'ready' ? encoderFor(platform) : null;
  if (enc) {
    try {
      return Math.round(enc.encode(text).length * platformFactor(platform));
    } catch {
      return estimateTokens(text);
    }
  }
  return estimateTokens(text);
}
```

Replace `computeMeter`:

```ts
export function computeMeter(ctx: ConversationContext, platform = 'chatgpt'): TokenMeter {
  let input = 0;
  let output = 0;
  for (const msg of ctx.messages) {
    const n = countTokens(msg.content, platform);
    if (msg.role === 'assistant') output += n;
    else input += n;
  }
  return { input, output, total: input + output, accuracy: platformAccuracy(platform, loadState) };
}
```

Update `tokenAccuracy()` (now platform-free legacy) to delegate — keep for any existing caller:

```ts
export function tokenAccuracy(): TokenAccuracy {
  return loadState === 'ready' && encoders.o200k_base ? 'exact' : 'estimate';
}
```

Update `__resetTokenizerForTest`:

```ts
export function __resetTokenizerForTest(): void {
  delete encoders.o200k_base;
  delete encoders.cl100k_base;
  loadState = 'idle';
  loadPromise = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test -- token-meter`
Expected: PASS all.

- [ ] **Step 5: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/token-meter.ts extension/src/__tests__/token-meter.test.ts
git commit -m "feat(extension): per-platform encoder + factor in computeMeter"
```

---

## Task 3: Add userSelector to adapter type + adapters

**Files:**
- Modify: `extension/src/platform-adapters/types.ts`
- Modify: `extension/src/platform-adapters/gemini.ts`, `claude.ts`, `chatgpt.ts`, `qwen.ts`

- [ ] **Step 1: Add the optional field to the interface**

In `extension/src/platform-adapters/types.ts`, add after `responseSelector`:

```ts
  // 用户消息容器选择器，供面板扫描会话计 token。未配置时只算 assistant 响应。
  userSelector?: string;
```

- [ ] **Step 2: Set userSelector on each adapter**

`gemini.ts` — add after `responseSelector`:
```ts
  userSelector: 'user-query, .user-query-bubble-with-background',
```

`chatgpt.ts` — add after `responseSelector`:
```ts
  userSelector: '[data-message-author-role="user"]',
```

`claude.ts` — add after `responseSelector`:
```ts
  userSelector: '[data-testid="user-message"], .font-user-message',
```

`qwen.ts` — add after `responseSelector`:
```ts
  userSelector: '.qwen-chat-message-user, .user-message',
```

(If any of these files lacks a literal `responseSelector:` property line, add the `userSelector` line immediately after the `name:` line instead. Read the file first to confirm placement.)

- [ ] **Step 3: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add extension/src/platform-adapters/types.ts extension/src/platform-adapters/gemini.ts extension/src/platform-adapters/chatgpt.ts extension/src/platform-adapters/claude.ts extension/src/platform-adapters/qwen.ts
git commit -m "feat(extension): add userSelector to platform adapters"
```

---

## Task 4: status-panel.ts UI singleton

**Files:**
- Create: `extension/src/content/status-panel.ts`
- Test: `extension/src/__tests__/status-panel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/__tests__/status-panel.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { statusPanel, opStateLabel } from '../content/status-panel';

beforeEach(() => {
  document.body.innerHTML = '';
  statusPanel.destroy();
});

describe('status-panel opStateLabel', () => {
  it('maps states to zh labels', () => {
    expect(opStateLabel('idle')).toBe('空闲');
    expect(opStateLabel('thinking')).toBe('思考中');
    expect(opStateLabel('executing')).toBe('执行工具');
    expect(opStateLabel('done')).toBe('完成');
    expect(opStateLabel('error')).toBe('错误');
  });
});

describe('status-panel render', () => {
  it('mounts a root on init', () => {
    statusPanel.init();
    statusPanel.setProvider('gemini', 'gemini');
    expect(document.querySelector('[data-piercode-status-root]')).not.toBeNull();
  });

  it('shows provider and tokens when expanded', () => {
    statusPanel.init();
    statusPanel.setProvider('claude', 'claude');
    statusPanel.setMeter({ input: 100, output: 50, total: 150, accuracy: 'estimate' }, 1000);
    statusPanel.expandForTest();
    const text = document.querySelector('[data-piercode-status-root]')!.textContent!;
    expect(text).toContain('claude');
    expect(text).toContain('150');
  });

  it('renders controlled tab info', () => {
    statusPanel.init();
    statusPanel.setControlledTab({ tabId: 7, title: 'Example', url: 'https://e.com' });
    statusPanel.expandForTest();
    const text = document.querySelector('[data-piercode-status-root]')!.textContent!;
    expect(text).toContain('Example');
    expect(text).toContain('7');
  });

  it('hides root in stealth mode', () => {
    statusPanel.init();
    statusPanel.configure({ stealth: true });
    const root = document.querySelector('[data-piercode-status-root]') as HTMLElement;
    expect(root.style.display).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npm test -- status-panel`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement status-panel.ts**

Create `extension/src/content/status-panel.ts`:

```ts
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
      this.ensureDom();
      this.paint();
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npm test -- status-panel`
Expected: PASS all.

- [ ] **Step 5: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/content/status-panel.ts extension/src/__tests__/status-panel.test.ts
git commit -m "feat(extension): status panel UI singleton"
```

---

## Task 5: Background broadcast of controlled tab

**Files:**
- Modify: `extension/src/background/index.ts`

- [ ] **Step 1: Add a pure message builder + broadcast**

In `extension/src/background/index.ts`, add near `setBrowserRelayStatus` (around line 173):

```ts
type ControlledTabMessage = {
  type: 'PIERCODE_CONTROLLED_TAB';
  info: { tabId: number; title: string; url: string } | null;
};

function buildControlledTabMessage(tab: chrome.tabs.Tab | null): ControlledTabMessage {
  if (!tab || tab.id == null) return { type: 'PIERCODE_CONTROLLED_TAB', info: null };
  return {
    type: 'PIERCODE_CONTROLLED_TAB',
    info: { tabId: tab.id, title: tab.title || '', url: tab.url || '' },
  };
}

async function broadcastControlledTab(): Promise<void> {
  let msg: ControlledTabMessage;
  if (controlledTabId == null) {
    msg = { type: 'PIERCODE_CONTROLLED_TAB', info: null };
  } else {
    try {
      const tab = await chrome.tabs.get(controlledTabId);
      msg = buildControlledTabMessage(tab);
    } catch {
      msg = { type: 'PIERCODE_CONTROLLED_TAB', info: null };
    }
  }
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    }
  } catch {
    // tabs API 不可用时静默。
  }
}
```

- [ ] **Step 2: Call broadcast on status change**

Inside `setBrowserRelayStatus(...)` (after it sets the status object, ~line 178), append:

```ts
  void broadcastControlledTab();
```

Also call `void broadcastControlledTab();` at the point where `controlledTabId = tab.id;` is set (~line 851) and where `controlledTabId = null;` is set (~line 724). Read those lines first to place the call on the line immediately after each assignment.

- [ ] **Step 3: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add extension/src/background/index.ts
git commit -m "feat(extension): broadcast controlled tab to content scripts"
```

---

## Task 6: Wire panel into content script

**Files:**
- Modify: `extension/src/content/index.ts`

- [ ] **Step 1: Import + init the panel**

At top of `extension/src/content/index.ts`, after the `visualIndicator` import (line 5), add:

```ts
import { statusPanel, type ControlledTabInfo } from './status-panel';
import { computeMeter } from './token-meter';
```

In the init block (after line 1035 `visualIndicator.configure(...)`), add:

```ts
  statusPanel.init();
  statusPanel.setProvider(platformAdapter.name, platformProfile);
  try {
    chrome.storage?.local?.get(['stealthMode'], (result) => {
      statusPanel.configure({ stealth: resolveStealthMode(result?.stealthMode) });
    });
  } catch {}
```

Also in the `chrome.storage.onChanged` listener (line 139-140, where `stealthMode` changes), add after the `visualIndicator.configure(...)` line:

```ts
      statusPanel.configure({ stealth: resolveStealthMode(changes.stealthMode.newValue) });
```

- [ ] **Step 2: Hook op-state into lifecycle points**

- `notifyResponseLoading` (line ~2006, where `sendAIResponseLog(... '思考中...')`): add before/after that line:
  ```ts
    statusPanel.setOpState('thinking');
  ```
- `execBtn.onclick` (line 1366, after `visualIndicator.showStatusBadge('loading')`):
  ```ts
    statusPanel.setOpState('executing');
  ```
- completed (line 1379, after `visualIndicator.showStatusBadge('completed')`):
  ```ts
    statusPanel.setOpState('done');
  ```
- error (line 1415, after `visualIndicator.showStatusBadge('error')`):
  ```ts
    statusPanel.setOpState('error');
  ```
- `executeBatch` loading (line 1643): `statusPanel.setOpState('executing');`
- `executeBatch` completed (line 1681): `statusPanel.setOpState('done');`

- [ ] **Step 3: Add scanConversation + token refresh loop**

Add a helper function in `index.ts` (place near `getConversationId`, ~line 1144):

```ts
// scanConversation 扫描页面会话，分类 user/assistant 消息供 token 计量。
// qwen 复用已维护的 qwenConversationCtx；其他平台按选择器扫 DOM。
function scanConversation(): ConversationContext {
  if (platformAdapter.name === 'qwen' && qwenConversationCtx) {
    return qwenConversationCtx;
  }
  const messages: ConversationContext['messages'] = [];
  let totalChars = 0;
  const push = (role: 'user' | 'assistant', el: Element) => {
    const content = (el.textContent || '').trim();
    if (!content) return;
    messages.push({ role, content, timestamp: Date.now() });
    totalChars += content.length;
  };
  const userSel = platformAdapter.userSelector;
  if (userSel) document.querySelectorAll(userSel).forEach((el) => push('user', el));
  if (platformAdapter.responseSelector) {
    document.querySelectorAll(platformAdapter.responseSelector).forEach((el) => push('assistant', el));
  }
  return { messages, totalChars };
}

let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
function startTokenRefresh(): void {
  if (tokenRefreshTimer) return;
  const refresh = () => {
    try {
      const ctx = scanConversation();
      const meter = computeMeter(ctx, platformAdapter.name);
      statusPanel.setMeter(meter, tokenThreshold());
    } catch {}
  };
  refresh();
  tokenRefreshTimer = setInterval(refresh, 3000);
}
```

Add a `tokenThreshold()` helper. Check `extension/src/settings.ts` for an existing threshold constant; use `DEFAULT_QWEN_MAX_CONTEXT_TOKENS` for qwen and a generic default otherwise:

```ts
function tokenThreshold(): number {
  // qwen 用压缩阈值；其他平台用一个通用上下文上限做进度条参考。
  if (platformAdapter.name === 'qwen') return DEFAULT_QWEN_MAX_CONTEXT_TOKENS;
  return 128_000;
}
```

Import `DEFAULT_QWEN_MAX_CONTEXT_TOKENS` from `../settings` if not already imported (grep first; qwen-settings.ts may already pull it).

Call `startTokenRefresh();` at the end of the init block (after `statusPanel.setProvider(...)`).

- [ ] **Step 4: Listen for controlled-tab broadcast**

In the `chrome.runtime.onMessage.addListener` block (starts line 1085), add a new branch before `return false;` (line 1134):

```ts
    if (msg.type === 'PIERCODE_CONTROLLED_TAB') {
      statusPanel.setControlledTab((msg.info ?? null) as ControlledTabInfo | null);
      return false;
    }
```

- [ ] **Step 5: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors. (If `ConversationContext` import is missing the `userSelector` field or `tokenThreshold` references an unimported constant, fix the import.)

- [ ] **Step 6: Build to confirm bundling**

Run: `cd extension && npm run build`
Expected: build succeeds, `dist/content.js` produced.

- [ ] **Step 7: Run full test suite**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add extension/src/content/index.ts
git commit -m "feat(extension): wire status panel + activate token pipeline"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full type-check + tests + build**

Run:
```bash
cd extension && npx tsc --noEmit && npm test && npm run build
```
Expected: no type errors, all tests pass, build succeeds.

- [ ] **Step 2: Manual smoke (optional, user-driven)**

Load unpacked `extension/dist` in Chrome, open a supported AI page (e.g. gemini.google.com), confirm the status-panel dot appears bottom-right (left of token HUD dot), click to expand, verify provider + token blocks render. Trigger a tool call, confirm op-state cycles executing → done. Run a browser tool to attach a tab, confirm the controlled-tab block populates.
