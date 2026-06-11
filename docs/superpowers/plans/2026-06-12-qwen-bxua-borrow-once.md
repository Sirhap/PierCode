# Qwen bx-ua Borrow-Once 直发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 qwen completions 脱离每请求经页面 —— 借 qwen tab 算一次 baxia bx-ua,SW 缓存复用并干净 fetch 直发;无 tab 可借时降级 ssxmod 直发。

**Architecture:** 复用现有 page-fetch 管线 (SW→content port→page-bridge MAIN world) 新增一组 "借 bx-ua" 消息:页面侧发一个眨眼 `chats/new` 请求 + 临时 hook `window.fetch` 截下 baxia 注入的 `bx-ua`/`bx-umidtoken`,回传 SW 缓存。chat-api 的 qwen config 移出 listen、改直发并注入缓存的 bx-ua;收到 RGV587 清缓存重借一次,仍失败降 ssxmod。

**Tech Stack:** TypeScript, Chrome MV3 (runtime ports, MAIN-world page-bridge), Vitest, 移植自 Qwen2API 的 LZW + 自定义 base64 ssxmod 生成。

---

## 文件结构

- Create: `extension/src/background/qwen-ssxmod.ts` — 纯算法 ssxmod cookie 生成 (无依赖)
- Create: `extension/src/background/qwen-bxua-broker.ts` — 借 tab 算 bx-ua + 内存缓存 + in-flight 去重
- Create: `extension/src/__tests__/qwen-ssxmod.test.ts`
- Create: `extension/src/__tests__/qwen-bxua-broker.test.ts`
- Modify: `extension/src/content/index.ts` — 新增 `piercode-bxua:` port 转发 (镜像 page-fetch port)
- Modify: `extension/src/page-bridge/index.ts` — 新增眨眼请求 + hook-fetch 截 bx-ua
- Modify: `extension/src/background/chat-api.ts` — qwen 移出 listen、注入 bx-ua、RGV587 重试 + ssxmod 降级

---

## Task 1: ssxmod cookie 生成模块

移植 Qwen2API `fingerprint.js` + `cookie-generator.js` 为干净 TS。纯算法,无 DOM/网络依赖,先做最易测的单元。

**Files:**
- Create: `extension/src/background/qwen-ssxmod.ts`
- Test: `extension/src/__tests__/qwen-ssxmod.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// extension/src/__tests__/qwen-ssxmod.test.ts
import { describe, expect, it } from 'vitest';
import { genSsxmod } from '../background/qwen-ssxmod';

describe('genSsxmod', () => {
  it('produces both itna cookies with the 1- prefix', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect(ssxmod_itna.startsWith('1-')).toBe(true);
    expect(ssxmod_itna2.startsWith('1-')).toBe(true);
  });

  it('produces ASCII-only output', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect([...ssxmod_itna].every(c => c.charCodeAt(0) < 128)).toBe(true);
    expect([...ssxmod_itna2].every(c => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('produces itna longer than itna2 (37-field vs 18-field)', () => {
    const { ssxmod_itna, ssxmod_itna2 } = genSsxmod();
    expect(ssxmod_itna.length).toBeGreaterThan(ssxmod_itna2.length);
    expect(ssxmod_itna.length).toBeGreaterThan(300);
  });

  it('varies across calls (random hash fields + timestamp)', () => {
    const a = genSsxmod();
    const b = genSsxmod();
    expect(a.ssxmod_itna).not.toBe(b.ssxmod_itna);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extension && npx vitest run src/__tests__/qwen-ssxmod.test.ts`
Expected: FAIL — `Cannot find module '../background/qwen-ssxmod'`

- [ ] **Step 3: 写实现**

```typescript
// extension/src/background/qwen-ssxmod.ts
// Local generation of qwen's ssxmod_itna / ssxmod_itna2 cookies, ported from
// the Qwen2API project (fingerprint.js + cookie-generator.js). Pure algorithm:
// a fixed device fingerprint template → randomised hash fields + current
// timestamp → LZW compression → custom-base64 encode. No DOM, no network.
//
// Used only on the ssxmod fallback path (when no qwen tab is available to
// borrow a real baxia bx-ua from). On strict risk-control accounts this alone
// does NOT clear the WAF — it's a best-effort last resort for lenient-IP users.

const CUSTOM_BASE64 = 'DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ';

// Apple M4 Mac default fingerprint template (37 caret-joined fields).
const TEMPLATE = {
  deviceId: '84985177a19a010dea49',
  sdkVersion: 'websdk-2.3.15d',
  initTimestamp: '1765348410850',
  field3: '91',
  field4: '1|15',
  language: 'zh-CN',
  timezoneOffset: '-480',
  colorDepth: '16705151|12791',
  screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
  field9: '5',
  platform: 'MacIntel',
  field11: '10',
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
  field13: '30|30',
  field14: '0',
  field15: '28',
  pluginCount: '5',
  vendor: 'Google Inc.',
  field29: '8',
  touchInfo: '-1|0|0|0|0',
  field32: '11',
  field35: '0',
  mode: 'P',
};

function randomHash(): number {
  return Math.floor(Math.random() * 4294967296);
}

function deviceId(): string {
  return Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// LZW compress + emit via charFunc, bit-packing into `bits`-wide symbols.
function lzwCompress(data: string, bits: number, charFunc: (i: number) => string): string {
  if (data == null) return '';
  const dict: Record<string, number> = {};
  const dictToCreate: Record<string, boolean> = {};
  let c = '', wc = '', w = '';
  let enlargeIn = 2, dictSize = 3, numBits = 2;
  const result: string[] = [];
  let value = 0, position = 0;

  const emitBit = (bit: number) => {
    value = (value << 1) | bit;
    if (position === bits - 1) { position = 0; result.push(charFunc(value)); value = 0; }
    else { position++; }
  };
  const emitChar = (w0: string) => {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w0)) {
      if (w0.charCodeAt(0) < 256) {
        for (let j = 0; j < numBits; j++) emitBit(0);
        let cc = w0.charCodeAt(0);
        for (let j = 0; j < 8; j++) { emitBit(cc & 1); cc >>= 1; }
      } else {
        for (let j = 0; j < numBits; j++) emitBit(j === 0 ? 1 : 0);
        let cc = w0.charCodeAt(0);
        for (let j = 0; j < 16; j++) { emitBit(cc & 1); cc >>= 1; }
      }
      enlargeIn--; if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
      delete dictToCreate[w0];
    } else {
      let cc = dict[w0];
      for (let j = 0; j < numBits; j++) { emitBit(cc & 1); cc >>= 1; }
    }
    enlargeIn--; if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  };

  for (let i = 0; i < data.length; i++) {
    c = data.charAt(i);
    if (!Object.prototype.hasOwnProperty.call(dict, c)) { dict[c] = dictSize++; dictToCreate[c] = true; }
    wc = w + c;
    if (Object.prototype.hasOwnProperty.call(dict, wc)) { w = wc; }
    else { emitChar(w); dict[wc] = dictSize++; w = String(c); }
  }
  if (w !== '') emitChar(w);

  // Flush marker (symbol 2) + trailing bits.
  let marker = 2;
  for (let j = 0; j < numBits; j++) { emitBit(marker & 1); marker >>= 1; }
  for (;;) {
    value = value << 1;
    if (position === bits - 1) { result.push(charFunc(value)); break; }
    position++;
  }
  return result.join('');
}

function customEncode(data: string): string {
  // urlSafe variant (no padding) — matches the cookie format `1-<encoded>`.
  return lzwCompress(data, 6, i => CUSTOM_BASE64.charAt(i));
}

export function genSsxmod(): { ssxmod_itna: string; ssxmod_itna2: string } {
  const now = Date.now();
  const fields: (string | number)[] = [
    deviceId(),                                   // 0
    TEMPLATE.sdkVersion,                          // 1
    TEMPLATE.initTimestamp,                       // 2
    TEMPLATE.field3,                              // 3
    TEMPLATE.field4,                              // 4
    TEMPLATE.language,                            // 5
    TEMPLATE.timezoneOffset,                      // 6
    TEMPLATE.colorDepth,                          // 7
    TEMPLATE.screenInfo,                          // 8
    TEMPLATE.field9,                              // 9
    TEMPLATE.platform,                            // 10
    TEMPLATE.field11,                             // 11
    TEMPLATE.webglRenderer,                       // 12
    TEMPLATE.field13,                             // 13
    TEMPLATE.field14,                             // 14
    TEMPLATE.field15,                             // 15
    `${TEMPLATE.pluginCount}|${randomHash()}`,    // 16 (split: count|hash)
    randomHash(),                                 // 17
    randomHash(),                                 // 18
    '1', '0', '1', '0',                           // 19-22
    TEMPLATE.mode,                                // 23
    '0', '0', '0', '416',                         // 24-27
    TEMPLATE.vendor,                              // 28
    TEMPLATE.field29,                             // 29
    TEMPLATE.touchInfo,                           // 30
    randomHash(),                                 // 31
    TEMPLATE.field32,                             // 32
    now,                                          // 33 (current timestamp)
    randomHash(),                                 // 34
    TEMPLATE.field35,                             // 35
    Math.floor(Math.random() * 91) + 10,          // 36 (10-100)
  ];

  const itnaData = fields.join('^');
  const ssxmod_itna = '1-' + customEncode(itnaData);

  // itna2 uses only: field0, field1, field23, field32, field33 (+ P-mode blanks).
  const itna2Data = [
    fields[0], fields[1], fields[23],
    0, '', 0, '', '', 0, 0, 0,
    fields[32], fields[33],
    0, 0, 0, 0, 0,
  ].join('^');
  const ssxmod_itna2 = '1-' + customEncode(itna2Data);

  return { ssxmod_itna, ssxmod_itna2 };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extension && npx vitest run src/__tests__/qwen-ssxmod.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd extension && npx tsc --noEmit && cd ..
git add extension/src/background/qwen-ssxmod.ts extension/src/__tests__/qwen-ssxmod.test.ts
git commit -m "feat(qwen): local ssxmod cookie generation (ported from Qwen2API)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: bx-ua broker (内存缓存 + in-flight 去重)

借取动作本身 (port 通信) 在 Task 3/4 接通;本任务先做**纯逻辑**部分:缓存、in-flight 去重、invalidate。借取函数通过依赖注入传入,便于单测。

**Files:**
- Create: `extension/src/background/qwen-bxua-broker.ts`
- Test: `extension/src/__tests__/qwen-bxua-broker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// extension/src/__tests__/qwen-bxua-broker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBxUaBroker } from '../background/qwen-bxua-broker';

describe('createBxUaBroker', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns cached value without re-borrowing on second call', async () => {
    const borrow = vi.fn().mockResolvedValue({ bxUa: 'X', umid: 'Y' });
    const broker = createBxUaBroker(borrow);
    const a = await broker.getBxUa();
    const b = await broker.getBxUa();
    expect(a).toEqual({ bxUa: 'X', umid: 'Y' });
    expect(b).toEqual({ bxUa: 'X', umid: 'Y' });
    expect(borrow).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent borrows into a single in-flight call', async () => {
    let resolveBorrow: (v: { bxUa: string; umid: string }) => void = () => {};
    const borrow = vi.fn().mockReturnValue(new Promise(r => { resolveBorrow = r; }));
    const broker = createBxUaBroker(borrow);
    const p1 = broker.getBxUa();
    const p2 = broker.getBxUa();
    resolveBorrow({ bxUa: 'X', umid: 'Y' });
    await Promise.all([p1, p2]);
    expect(borrow).toHaveBeenCalledTimes(1);
  });

  it('re-borrows after invalidate', async () => {
    const borrow = vi.fn()
      .mockResolvedValueOnce({ bxUa: 'A', umid: '1' })
      .mockResolvedValueOnce({ bxUa: 'B', umid: '2' });
    const broker = createBxUaBroker(borrow);
    expect(await broker.getBxUa()).toEqual({ bxUa: 'A', umid: '1' });
    broker.invalidate();
    expect(await broker.getBxUa()).toEqual({ bxUa: 'B', umid: '2' });
    expect(borrow).toHaveBeenCalledTimes(2);
  });

  it('returns null when borrow fails, and does not cache the failure', async () => {
    const borrow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bxUa: 'A', umid: '1' });
    const broker = createBxUaBroker(borrow);
    expect(await broker.getBxUa()).toBeNull();
    expect(await broker.getBxUa()).toEqual({ bxUa: 'A', umid: '1' });
    expect(borrow).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extension && npx vitest run src/__tests__/qwen-bxua-broker.test.ts`
Expected: FAIL — `Cannot find module '../background/qwen-bxua-broker'`

- [ ] **Step 3: 写实现**

```typescript
// extension/src/background/qwen-bxua-broker.ts
// Borrow-once cache for qwen's baxia bx-ua / bx-umidtoken signature headers.
//
// completions sits behind Aliyun baxia risk control: a clean SW fetch lacking
// bx-ua hits RGV587 (滑块 punish). bx-ua can only be produced by baxia running
// in a real qwen page, BUT (verified empirically) it is reusable across
// requests. So: borrow it once from a qwen tab, cache it, replay on every
// direct SW fetch; on RGV587, invalidate() and re-borrow once.
//
// This module owns only the cache + in-flight dedup. The actual borrow (port
// round-trip to the page) is injected so it can be unit-tested in isolation.

export interface BxUaCreds {
  bxUa: string;
  umid: string;
}

export type BorrowFn = () => Promise<BxUaCreds | null>;

export interface BxUaBroker {
  /** Cached creds, or borrow if empty. null = borrow failed (no tab / punish). */
  getBxUa(): Promise<BxUaCreds | null>;
  /** Drop the cache so the next getBxUa re-borrows (call on RGV587). */
  invalidate(): void;
}

export function createBxUaBroker(borrow: BorrowFn): BxUaBroker {
  let cached: BxUaCreds | null = null;
  let inFlight: Promise<BxUaCreds | null> | null = null;

  return {
    async getBxUa() {
      if (cached) return cached;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const creds = await borrow();
          if (creds) cached = creds; // never cache a null/failure
          return creds;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    invalidate() {
      cached = null;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extension && npx vitest run src/__tests__/qwen-bxua-broker.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd extension && npx tsc --noEmit && cd ..
git add extension/src/background/qwen-bxua-broker.ts extension/src/__tests__/qwen-bxua-broker.test.ts
git commit -m "feat(qwen): bx-ua broker with cache + in-flight dedup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: page-bridge 眨眼请求 + bx-ua 截获 (页面侧)

在 MAIN world 加:收到借取指令 → 临时 hook `window.fetch` 抓 baxia 注入的 header → 发一个最小 `chats/new` 眨眼请求 → 回传截到的 `{bxUa, umid}`。

**Files:**
- Modify: `extension/src/page-bridge/index.ts`

- [ ] **Step 1: 加消息常量 + 借取处理 (页面侧)**

在 `extension/src/page-bridge/index.ts` 顶部消息常量区 (PAGE_FETCH_* 之后) 新增:

```typescript
// content → page-bridge: borrow a baxia bx-ua by sending a blink request.
const BXUA_BORROW = 'PIERCODE_BXUA_BORROW';
// page-bridge → content: result of the borrow.
const BXUA_RESULT = 'PIERCODE_BXUA_RESULT';
```

在文件的 `window.addEventListener('message', ...)` 处理区 (execPageFetch 的分发旁边) 新增对 `BXUA_BORROW` 的处理。先定位现有 message 分发块,在其中加一个分支调用 `borrowBxUa(d.requestId)`。然后在 `execPageFetch` 函数附近新增:

```typescript
// Borrow a baxia bx-ua/bx-umidtoken by firing a minimal chats/new "blink"
// request through the page's own (baxia-patched) window.fetch, while a temporary
// hook captures the headers baxia injects on it. The request result is
// discarded — we only want the signature headers.
async function borrowBxUa(requestId: string): Promise<void> {
  const realFetch = window.fetch;
  let bxUa: string | null = null;
  let umid: string | null = null;
  // Wrap window.fetch to read headers off the init baxia hands to the real fetch.
  // baxia patches window.fetch; our wrapper sits OUTSIDE it (we call realFetch),
  // so by the time realFetch runs, init.headers carries baxia's injected values.
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    try {
      const h = init?.headers;
      const get = (k: string): string | null => {
        if (!h) return null;
        if (h instanceof Headers) return h.get(k);
        const rec = h as Record<string, string>;
        return rec[k] ?? rec[k.toLowerCase()] ?? null;
      };
      const bx = get('bx-ua');
      const um = get('bx-umidtoken');
      if (bx) bxUa = bx;
      if (um) umid = um;
    } catch { /* ignore capture errors */ }
    return realFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
  };
  try {
    (window as Window & typeof globalThis).fetch = wrapped as typeof fetch;
    const ts = Math.floor(Date.now() / 1000);
    const res = await wrapped('https://chat.qwen.ai/api/v2/chats/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        source: 'web',
        'bx-v': '2.5.36',
        'x-request-id': crypto.randomUUID(),
      },
      credentials: 'include',
      body: JSON.stringify({
        title: 'New Chat', models: ['qwen3-max'], chat_mode: 'normal',
        chat_type: 't2t', timestamp: ts, project_id: '',
      }),
    } as RequestInit);
    // Drain the body so the connection closes cleanly; result is unused.
    await res.text().catch(() => {});
  } catch (e) {
    post({ type: BXUA_RESULT, requestId, error: e instanceof Error ? e.message : String(e) });
    (window as Window & typeof globalThis).fetch = realFetch;
    return;
  }
  (window as Window & typeof globalThis).fetch = realFetch;
  if (bxUa) {
    post({ type: BXUA_RESULT, requestId, bxUa, umid: umid || '' });
  } else {
    post({ type: BXUA_RESULT, requestId, error: 'bx-ua not captured (account may be in punish state)' });
  }
}
```

注意:`post()` 已存在 (page-bridge 内 `window.postMessage` 封装,Task 上下文已确认)。在现有 message 分发块加分支:

```typescript
  if (d && d.type === BXUA_BORROW && typeof d.requestId === 'string') {
    void borrowBxUa(d.requestId);
    return;
  }
```

- [ ] **Step 2: 类型检查**

Run: `cd extension && npx tsc --noEmit`
Expected: 无 error (新代码类型合法)

- [ ] **Step 3: 提交**

```bash
git add extension/src/page-bridge/index.ts
git commit -m "feat(qwen): page-bridge bx-ua borrow via blink request + fetch hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: content port 转发 (SW ↔ page-bridge 桥接)

content script 加一个 `piercode-bxua:<id>` port,转发 SW 的借取请求到 page-bridge,并把结果回传 SW。镜像现有 `piercode-page-fetch:` port 逻辑。

**Files:**
- Modify: `extension/src/content/index.ts`

- [ ] **Step 1: 加消息常量 + port 处理**

在 `extension/src/content/index.ts` 的 PF_* 常量区后新增:

```typescript
const BXUA_PORT_PREFIX = 'piercode-bxua:';
const BXUA_BORROW = 'PIERCODE_BXUA_BORROW';   // content → page-bridge
const BXUA_RESULT = 'PIERCODE_BXUA_RESULT';   // page-bridge → content
```

在现有 `chrome.runtime.onConnect.addListener` 块 (处理 page-fetch port) 内,或紧随其后,新增对 bx-ua port 的处理 (与 page-fetch port 并列):

```typescript
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(BXUA_PORT_PREFIX)) return;
    const requestId = port.name.slice(BXUA_PORT_PREFIX.length);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.type !== BXUA_RESULT || d.requestId !== requestId) return;
      window.removeEventListener('message', onMessage);
      try {
        if (d.bxUa) port.postMessage({ ok: true, bxUa: d.bxUa, umid: d.umid || '' });
        else port.postMessage({ ok: false, error: d.error || 'bx-ua borrow failed' });
      } catch { /* port closed */ }
      try { port.disconnect(); } catch { /* already gone */ }
    };
    window.addEventListener('message', onMessage);

    port.onDisconnect.addListener(() => window.removeEventListener('message', onMessage));

    // Kick the page-bridge to borrow.
    window.postMessage({ type: BXUA_BORROW, requestId }, '*');
  });
}
```

注意:若现有 onConnect listener 用 early-return 过滤 port 前缀,本块作为**独立** addListener 追加即可 (Chrome 支持多个 onConnect listener;每个按自己的前缀过滤、不匹配则 return)。

- [ ] **Step 2: 类型检查**

Run: `cd extension && npx tsc --noEmit`
Expected: 无 error

- [ ] **Step 3: 提交**

```bash
git add extension/src/content/index.ts
git commit -m "feat(qwen): content port to relay bx-ua borrow SW<->page-bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: SW 借取函数 (wire broker 到 port)

SW 侧实现注入给 broker 的 `borrow()`:找 qwen tab → `tabs.connect(piercode-bxua:<id>)` → 等结果 (10s 超时)。在 chat-api.ts 内构造单例 broker。

**Files:**
- Modify: `extension/src/background/chat-api.ts`

- [ ] **Step 1: 顶部 import + 构造 broker**

在 `chat-api.ts` import 区 (qwenPageFetch import 旁) 新增:

```typescript
import { createBxUaBroker, type BxUaCreds } from './qwen-bxua-broker'
import { genSsxmod } from './qwen-ssxmod'
```

在模块作用域 (PLATFORMS 之前) 新增借取实现 + broker 单例:

```typescript
// Borrow a baxia bx-ua from an open qwen tab via the content↔page-bridge relay
// (piercode-bxua port). Returns null if no qwen tab is open or capture fails.
const QWEN_TAB_URLS_BXUA = ['*://chat.qwen.ai/*', '*://qwen.ai/*', '*://*.qwen.ai/*']
let bxuaSeq = 0

async function borrowBxUaFromTab(): Promise<BxUaCreds | null> {
  const tabs = await chrome.tabs.query({ url: QWEN_TAB_URLS_BXUA })
  const tab = tabs.find(t => t.active && typeof t.id === 'number') ?? tabs.find(t => typeof t.id === 'number')
  if (!tab?.id) return null
  const requestId = `bxua-${Date.now()}-${++bxuaSeq}`
  const port = chrome.tabs.connect(tab.id, { name: `piercode-bxua:${requestId}` })
  return new Promise<BxUaCreds | null>(resolve => {
    let settled = false
    const done = (v: BxUaCreds | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { port.disconnect() } catch { /* gone */ }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 10_000)
    port.onMessage.addListener((msg: { ok?: boolean; bxUa?: string; umid?: string }) => {
      if (msg?.ok && msg.bxUa) done({ bxUa: msg.bxUa, umid: msg.umid || '' })
      else done(null)
    })
    port.onDisconnect.addListener(() => done(null))
  })
}

const qwenBxUaBroker = createBxUaBroker(borrowBxUaFromTab)
```

- [ ] **Step 2: 类型检查**

Run: `cd extension && npx tsc --noEmit`
Expected: 无 error (genSsxmod 暂未使用会触发 unused 警告则在 Task 6 消除;若 tsc 因 noUnusedLocals 报错,先加 `void genSsxmod` 占位或直接进 Task 6 一并提交)

- [ ] **Step 3: 提交**

```bash
git add extension/src/background/chat-api.ts
git commit -m "feat(qwen): SW-side bx-ua borrow wired to broker via tab port

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: qwen config 直发改造 (移出 listen + 注入 bx-ua + RGV587 重试 + ssxmod 降级)

qwen 从 listen 移除、去 usePageFetch;buildHeaders 注入缓存的 bx-ua;新增 qwen 专属发送函数处理 RGV587 重试与 ssxmod 降级。

**Files:**
- Modify: `extension/src/background/chat-api.ts`

- [ ] **Step 1: qwen 移出 LISTEN_PLATFORMS**

定位 (约行 875):

```typescript
const LISTEN_PLATFORMS = new Set(['qwen', 'chatgpt'])
```

改为:

```typescript
const LISTEN_PLATFORMS = new Set(['chatgpt'])
```

- [ ] **Step 2: qwen config 去 usePageFetch + buildHeaders 注入 bx-ua**

定位 qwen config 内 (约行 263):

```typescript
    usePageFetch: true,
```

删除该行。

把 qwen 的 `buildHeaders` (约行 169-185) 改为注入 bx-ua/ssxmod。原函数:

```typescript
    async buildHeaders(token) {
      const xsrf = await getCookieToken('chat.qwen.ai', 'xsrf-token')
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'bx-v': '2.5.36',
        ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      }
    },
```

改为:

```typescript
    async buildHeaders(token) {
      const xsrf = await getCookieToken('chat.qwen.ai', 'xsrf-token')
      const base: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'bx-v': '2.5.36',
        ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      }
      // Primary path: replay a borrowed baxia bx-ua so a clean SW fetch clears
      // risk control. If no tab to borrow from, fall back to local ssxmod cookies.
      const creds = await qwenBxUaBroker.getBxUa()
      if (creds) {
        base['bx-ua'] = creds.bxUa
        if (creds.umid) base['bx-umidtoken'] = creds.umid
      } else {
        const { ssxmod_itna, ssxmod_itna2 } = genSsxmod()
        base['Cookie'] = `ssxmod_itna=${ssxmod_itna};ssxmod_itna2=${ssxmod_itna2}`
      }
      return base
    },
```

同样 `createConversation` (约行 122-164) 用了 `qwenPageFetch` —— 改为直 fetch + bx-ua 注入。把其中:

```typescript
      const res = await qwenPageFetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Origin': 'https://chat.qwen.ai',
          'Referer': 'https://chat.qwen.ai/',
          'version': '0.2.63',
          'source': 'web',
          'x-request-id': crypto.randomUUID(),
          'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
          'bx-v': '2.5.36',
          ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
        },
        body: JSON.stringify({
          title: '新建对话',
          models: [model],
          chat_mode: 'normal',
          chat_type: 't2t',
          timestamp: Math.floor(Date.now() / 1000),
          project_id: '',
        }),
        stream: false,
      })
      const text = await res.text()
```

改为 (chats/new 实测无需 bx-ua,但带上无害;用直 fetch):

```typescript
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
        'version': '0.2.63',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'bx-v': '2.5.36',
        ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      }
      const creds = await qwenBxUaBroker.getBxUa()
      if (creds) {
        headers['bx-ua'] = creds.bxUa
        if (creds.umid) headers['bx-umidtoken'] = creds.umid
      } else {
        const { ssxmod_itna, ssxmod_itna2 } = genSsxmod()
        headers['Cookie'] = `ssxmod_itna=${ssxmod_itna};ssxmod_itna2=${ssxmod_itna2}`
      }
      const res = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          title: '新建对话',
          models: [model],
          chat_mode: 'normal',
          chat_type: 't2t',
          timestamp: Math.floor(Date.now() / 1000),
          project_id: '',
        }),
      })
      const text = await res.text()
```

- [ ] **Step 3: RGV587 重试 + 降级 (platformFetch qwen 分支)**

`platformFetch` (约行 79-90) 现在二选一。qwen 不再走 page-fetch,但需 RGV587 重试。改 `platformFetch` 为:

```typescript
async function platformFetch(
  config: PlatformConfig,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  stream: boolean,
  signal?: AbortSignal,
): Promise<FetchLike> {
  if (config.usePageFetch) {
    return qwenPageFetch(url, { ...init, stream }, signal)
  }
  // qwen direct path: detect RGV587 (risk control) on the first bytes; on hit,
  // invalidate the cached bx-ua, re-borrow, rebuild headers, and retry ONCE.
  if (config.name === 'Qwen') {
    return qwenDirectFetch(config, url, init, signal)
  }
  return fetch(url, { method: init.method, headers: init.headers, body: init.body, signal })
}

// One RGV587-aware retry. Returns a FetchLike whose body streams the SSE once
// the response is confirmed past risk control. Peeks the first chunk to detect
// the punish JSON (content-type stays application/json on punish vs
// text/event-stream on success).
async function qwenDirectFetch(
  config: PlatformConfig,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  signal?: AbortSignal,
): Promise<FetchLike> {
  const attempt = async (headers: Record<string, string>): Promise<Response> =>
    fetch(url, { method: init.method, headers, body: init.body, credentials: 'include', signal })

  let res = await attempt(init.headers)
  let ct = res.headers.get('content-type') || ''
  // Punish responses come back as JSON (not event-stream). Peek to confirm.
  if (!ct.includes('event-stream')) {
    const text = await res.text()
    if (text.includes('RGV587') || text.includes('punish') || text.includes('aliyun_waf')) {
      // Invalidate + re-borrow + rebuild headers (buildHeaders re-runs broker).
      qwenBxUaBroker.invalidate()
      const retryHeaders = await config.buildHeaders('') // token already in init? rebuild fully below
      // buildHeaders needs the token; reuse the Authorization from init.
      const auth = init.headers['Authorization']
      if (auth) retryHeaders['Authorization'] = auth
      res = await attempt(retryHeaders)
      ct = res.headers.get('content-type') || ''
      if (!ct.includes('event-stream')) {
        const t2 = await res.text()
        // Synthesize a FetchLike that surfaces the error text to the caller.
        return { ok: false, status: res.status, text: async () => t2, body: null }
      }
    } else {
      // Non-stream, non-punish (e.g. business error) — pass through as text.
      return { ok: res.ok, status: res.status, text: async () => text, body: null }
    }
  }
  return res
}
```

注意:`buildHeaders('')` 重建会再跑一次 broker (此时缓存已 invalidate → 重借)。token 从 init 的 Authorization 头回填。若 broker 重借仍失败,buildHeaders 内部已自动落 ssxmod。

- [ ] **Step 4: 全量类型检查 + 测试**

Run: `cd extension && npx tsc --noEmit && npx vitest run`
Expected: tsc 无 error;所有测试 PASS (含 Task 1/2 新测 + 现有测试不回归)

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/chat-api.ts
git commit -m "feat(qwen): direct-send with borrowed bx-ua, RGV587 retry, ssxmod fallback

qwen leaves the listen path and the page-fetch proxy. completions now goes
out as a clean SW fetch carrying a borrowed-and-cached baxia bx-ua. On RGV587
the cache is invalidated, bx-ua re-borrowed, and the request retried once;
if there is no qwen tab to borrow from, headers fall back to locally generated
ssxmod cookies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 构建验证 + 手动验收准备

**Files:** 无 (验证)

- [ ] **Step 1: 生产构建**

Run: `cd extension && npm run build`
Expected: 构建成功,无 TS error,产出 `extension/dist/`

- [ ] **Step 2: 手动验收清单 (记录到 PR/commit 描述,需真 Chrome)**

1. 加载 `extension/dist/`,打开并登录 chat.qwen.ai。
2. sidebar 选 qwen 发一条消息。
3. DevTools Network: 确认 completions 请求**由扩展 SW 直发** (不经 page-bridge 中转),带 `bx-ua` header,返回 `text/event-stream`,正常流式渲染。
4. 关闭所有 qwen tab,再发一条 → 应走 ssxmod 降级 (Network 见 `Cookie: ssxmod_itna=...`,无 bx-ua);严格账号预期 RGV587 → CHAT_ERROR 提示开页登录 (符合设计)。
5. 连发多条:确认 bx-ua 只借一次 (仅首条触发借取 port),后续复用缓存。

- [ ] **Step 3: 提交 (若构建产物或文档需记录)**

```bash
git add docs/superpowers/plans/2026-06-12-qwen-bxua-borrow-once.md
git commit -m "docs(plan): qwen bx-ua borrow-once implementation plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自审记录

- **Spec 覆盖**: ssxmod 生成 (T1) / bx-ua 缓存+去重 (T2) / 眨眼截获 (T3) / port 桥接 (T4,T5) / 直发+RGV587+降级 (T6) / 验收 (T7) —— spec 各节均有对应任务。
- **占位符**: 每个改动步骤含完整代码;无 TBD/TODO。
- **类型一致**: `BxUaCreds {bxUa,umid}` 贯穿 broker/SW/config;`genSsxmod()` 返回 `{ssxmod_itna,ssxmod_itna2}` 一致;消息常量 `BXUA_BORROW`/`BXUA_RESULT`/port 前缀 `piercode-bxua:` 三处对齐。
- **已知风险**: T6 Step3 的 `buildHeaders('')` 重建依赖 token 从 init 回填 —— 执行时若发现 PlatformConfig.buildHeaders 签名不便,可改为在 handleChatRequest 层重建 headers 后重发 (替代实现,语义等价)。
