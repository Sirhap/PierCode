// browser-agent-bridge.ts — content-script module injected into the sidebar's
// AI iframe (chatgpt.com / chat.qwen.ai). It is the iframe end of the
// browser-agent loop: the SW orchestrator (background/browser-agent.ts) pushes a
// composed turn prompt down a long-lived port, the bridge types it into the AI
// composer and submits, reads the AI's reply back out of the DOM, parses the
// browser_* tool calls, and posts them back up the same port.
//
// This file runs in CONTENT-SCRIPT context (isolated world) — NO React, NO
// chrome.storage-bound settings import. It is bundled into the single classic
// content.js (content-build.test.ts guards that), so it may only import
// content-safe leaves (parser / send-fallback / platform-selectors / adapters),
// the same leaves content/index.ts already statically imports.
//
// Architecture decisions (from the wiring contract + recon):
//  - Frame gate (isBrowserAgentFrame): the iframe is cross-origin (we can't read
//    the sidebar parent's location), so it is identified by a
//    ?piercode_browser_agent=<platform> sentinel on its OWN src — analogous to
//    the worker tab's ?piercode_agent= marker. installBrowserAgentBridge() runs
//    ONLY when this is true, so the normal top-frame bootstrap is untouched and a
//    plain embedded iframe does nothing.
//  - INJECT must reach this FRAME, not the tab (chrome.tabs.sendMessage fans out
//    to every frame). So the bridge opens a long-lived runtime.connect port to
//    the SW (notes #7); the SW pushes BROWSER_AGENT_INJECT down it and receives
//    INJECT_ACK / TOOLS up it. No frameId routing needed.
//  - Send-button-enabled wait (notes #3, the "有时发有时不发" race): AI sites keep
//    the send button mounted-but-disabled until the typed value registers in
//    their framework state. The bridge polls a disabled/aria-disabled check and
//    waits before clicking, falling back to a synthetic Enter only after the
//    deadline (dispatchEnterAsSendFallback). Mirrors clickSendButton in ws-linker.
//  - Readback PRIMARY = DOM-observe on the matched adapter's responseSelector +
//    adapter.extractText + extractFenceToolCalls (notes #9). We deliberately do
//    NOT toggle the existing api-listen SSE tee here: its content port relay
//    forwards to the SW's continueListenTurn (the API-chat loop, the WRONG owner
//    for this loop). Keeping a private DOM-observe readback keeps the two
//    pipelines fully separate.
//  - agentTurnId staleness + visible-iframe user typing (notes #10): the iframe
//    is VISIBLE, so the user can also type in it. The bridge marks programmatic
//    sends and only treats a reply that FOLLOWS a programmatic INJECT as an agent
//    turn; the SW also drops readbacks tagged with a stale agentTurnId.
//  - per-document client id (notes #4): sessionStorage is shared across
//    same-origin frames, so we never invent a sessionStorage-keyed id; the iframe
//    runs its own content.js module which already has a fresh per-document id.
//  - TDZ (notes #1): observer startup is deferred with queueMicrotask, never run
//    synchronously mid-module (the Hub hit a real TDZ crash doing that).

import { extractFenceToolCalls, hasIncompleteToolFence } from '../parser';
import { getPlatformAdapter, type PlatformAdapter } from '../platform-adapters';
import { PLATFORM_SELECTORS, selectorsForHost, type PlatformSelectors } from './platform-selectors';
import { dispatchEnterAsSendFallback } from './send-fallback';

// ── 消息常量（与 background/browser-agent.ts 契约一致；与 CHAT_* 完全不相交）──
const MSG_BRIDGE_READY = 'BROWSER_AGENT_BRIDGE_READY';
const MSG_INJECT = 'BROWSER_AGENT_INJECT';
const MSG_INJECT_ACK = 'BROWSER_AGENT_INJECT_ACK';
const MSG_TOOLS = 'BROWSER_AGENT_TOOLS';
const MSG_STREAM = 'BROWSER_AGENT_STREAM';

// 长连端口名前缀（SW onConnect 用 startsWith 识别本通道）。
const PORT_PREFIX = 'piercode-browser-agent:';

// browser_* 工具（操作浏览器）+ question（向用户提问）会被回传给 SW；其它工具名
// （本地文件/shell 工具等）在浏览器 agent 回合里无意义，丢弃以免误触发不支持的执行
// 路径。question 不经 /exec 执行——SW 把它路由成侧边栏提问卡，收集回答后喂回 AI。
function isBrowserToolName(name: string): boolean {
  return typeof name === 'string' && (name.startsWith('browser_') || name === 'question');
}

// ── 帧识别 ────────────────────────────────────────────────────────────────
// 侧边栏宿主的 AI iframe 在其 src 上带 ?piercode_browser_agent=<platform> 哨兵
// （类比 worker tab 的 ?piercode_agent=）。iframe 跨域、读不到父窗口 location，
// 所以只能靠自身 search 判定。非顶层帧 + 命中哨兵 = 本桥应运行的帧。
//
// 持久化（镜像 ws-linker.ts workerAgentId）：chatgpt/qwen 是 SPA，会在加载时
// 重写/剥掉 query（如 chatgpt.com 登录跳转、qwen `/c/<uuid>` 迁移），整页 reload
// 到一个不带哨兵的 URL 后，content.js 重新求值会让本桥探测失败、不再重装、端口
// 永不连上（SW 的 startBrowserAgentTask 因此注入失败）。所以哨兵在第一次成功读到
// 时就落进 sessionStorage（per-origin，单帧单平台，无键冲突），之后即使 URL 被
// 剥掉也能从 sessionStorage 恢复。
const BROWSER_AGENT_PLATFORM_STORAGE_KEY = 'piercode_browser_agent_platform';

// 已知 AI 宿主 host → 平台 key（哨兵被 SPA 剥掉 / sessionStorage 被分区时的兜底）。
// 顺序无关；命中即认。只在「跨域子帧」语境下用（见 browserAgentPlatformFromURL），
// 普通页把这些站嵌进 iframe 也会命中——但桥装上后仅在 INJECT 窗口内动作，无 INJECT
// 则全程休眠且端口无害，SW 也只对自己托管的平台发 INJECT，故不会误执行。
const HOST_PLATFORM: { test: (h: string) => boolean; platform: string }[] = [
  { test: h => h.includes('chatgpt.com') || h.includes('chat.openai.com'), platform: 'chatgpt' },
  { test: h => h.includes('qwen.ai') || h.includes('qwenlm.ai'), platform: 'qwen' },
];

// AI 宿主页内部嵌的**非对话**子 iframe（Cloudflare Turnstile / sentinel 反 bot 验证、
// backend-api 内部帧、各类 OAuth/widget 帧）host 也是 chatgpt.com / qwen.ai，会让纯
// host 兜底误判成「我们的 AI 对话帧」→ bridge 装到没有 composer 的验证帧上 → INJECT
// 打空、注入失败、时间线永空（实测根因：bridge 装到了
// chatgpt.com/backend-api/sentinel/frame.html）。这些帧的 pathname 有稳定特征，排除之。
export function isExcludedFramePathname(pathname: string): boolean {
  const p = (pathname || '').toLowerCase();
  return (
    p.includes('/sentinel/') ||
    p.includes('/backend-api/') ||
    p.includes('/cdn-cgi/') ||
    p.endsWith('frame.html') ||
    p.includes('/turnstile') ||
    p.includes('/challenge') ||
    p.includes('/_next/') ||
    p.includes('/api/')
  );
}

function isExcludedFramePath(): boolean {
  try {
    return isExcludedFramePathname(location.pathname);
  } catch {
    return false;
  }
}

// host 兜底仅认 AI 对话主页面（根或浅路径），不认深内部路径。合法的侧边栏 AiFrame
// 是 `https://chatgpt.com/` 或 `/c/<id>` / `https://chat.qwen.ai/` 这类对话路径；
// sentinel/widget 帧是 `/backend-api/sentinel/frame.html` 这类深路径。
function platformFromHost(): string {
  try {
    if (isExcludedFramePath()) return ''; // 验证/内部帧绝不当作对话帧
    const h = location.hostname;
    for (const e of HOST_PLATFORM) if (e.test(h)) return e.platform;
  } catch {
    /* ignore */
  }
  return '';
}

// 缓存「非空」结果：一旦确定平台就不再变；但**不缓存空串**，因为 qwen 这类 SPA 可能
// 在 content.js document_start 求值时 query 已被 history.replaceState 剥掉、且
// 第三方 iframe 的 sessionStorage 被 Chrome 分区/禁用 → 首次读到空。若把空缓存死，
// 桥永不安装（"bridge 未连接"根因）。改为：每次重读，URL→sessionStorage→host 三级
// 兜底，任一非空即缓存并返回。
let cachedBrowserAgentPlatform = '';
function browserAgentPlatformFromURL(): string | null {
  if (cachedBrowserAgentPlatform) return cachedBrowserAgentPlatform;

  // 任何分支之前先排除 AI 宿主内部的验证/widget 帧（sentinel/backend-api/turnstile/
  // frame.html…）。这些帧没有对话 composer，bridge 装上去 INJECT 必然打空（实测根因）。
  // 即使它们意外带了 ?piercode_browser_agent= 也不认。
  if (isExcludedFramePath()) return null;

  let platform = '';
  try {
    platform = (new URLSearchParams(location.search).get('piercode_browser_agent') || '').trim();
  } catch {
    platform = '';
  }

  // 持久化首次从 URL 读到的值（供后续被剥 query 的读取恢复）；读不到再回落 sessionStorage。
  try {
    if (platform) window.sessionStorage.setItem(BROWSER_AGENT_PLATFORM_STORAGE_KEY, platform);
    else platform = (window.sessionStorage.getItem(BROWSER_AGENT_PLATFORM_STORAGE_KEY) || '').trim();
  } catch {
    /* sessionStorage 被分区/禁用：跳过，走 host 兜底 */
  }

  // 仍为空：用 host 兜底（跨域子帧 + 已知 AI 宿主 = 几乎必是我们嵌的）。
  if (!platform && typeof window !== 'undefined') {
    try {
      if (window.top !== window.self) platform = platformFromHost();
    } catch {
      // 访问 window.top 抛错本身即「嵌在别处的跨域子帧」→ 用 host 判定。
      platform = platformFromHost();
    }
  }

  if (platform) cachedBrowserAgentPlatform = platform; // 只缓存非空，允许后续重试。
  return platform || null;
}

// 模块加载即捕获哨兵 —— 最早时机，赶在任何 SPA 路由剥掉 query 之前 —— 并落 sessionStorage，
// 使后续（含本次已被剥掉的 reload）的读取都能恢复平台。镜像 ws-linker.ts 的 `workerAgentId()`。
browserAgentPlatformFromURL();

export function isBrowserAgentFrame(): boolean {
  try {
    // 必须是子帧：顶层帧跑正常 content 引导，不应被本桥接管。
    if (window.top === window.self) return false;
  } catch {
    // 跨域访问 window.top 抛错本身就意味着这是嵌在别处的子帧。
  }
  return browserAgentPlatformFromURL() !== null;
}

// ── 平台配置解析 ──────────────────────────────────────────────────────────
// 选择器表按平台 key（chatgpt/qwen），适配器按当前 host 匹配。两者在本 iframe
// 内 host 与平台一致，但显式用哨兵里的 platform 作为权威 key，避免 host 变体
// （chat.openai.com 等）落到错误条目。
function resolveSelectors(platform: string): PlatformSelectors {
  return PLATFORM_SELECTORS[platform] || selectorsForHost(location.hostname);
}

function resolveAdapter(): PlatformAdapter {
  // getPlatformAdapter 按 location.hostname 匹配（本 iframe 即 chatgpt/qwen 页），
  // 复用其 extractText（qwen Monaco / chatgpt code-block 归一化）与 responseSelector。
  return getPlatformAdapter();
}

// ── 程序化发送标记（区分本桥提交 vs 用户在可见 iframe 里手打）────────────────
// 仅在一次 INJECT 提交后的窗口内，把新出现的 AI 回复当作 agent 回合读回；用户
// 自己在 iframe 里发的消息不应被解析成工具调用。窗口同时携带当前 agentTurnId，
// 读回时回传该 id 供 SW 丢弃过期回合。
let programmaticTurnId: string | null = null;
let programmaticSendUntil = 0;
// 本回合提交时已存在的 assistant 回复容器数（基线）。读回只认 index 严格大于此基线
// 的容器——否则会把上一回合（或用户自己发的）旧回复当成本回合回复扫读，解析出过期
// 工具或永远读不到本回合的新工具（审计 Bug #3）。markProgrammaticSend 时快照，
// latestResponseContainer 据此只取「本回合之后新建」的容器。
let programmaticBaselineCount = 0;
// 空闲容差：从 INJECT 提交或上一次 DOM 变化起，多久没动静才认为本回合窗口失效。
// 必须够长以扛住 chatgpt 慢首 token / Cloudflare 间隙 / "思考"停顿——否则窗口
// 在回复真正流出前就过期，工具块永远读不到（原 5s 是 bug）。SW 侧 TOOLS_TIMEOUT_MS
// (180s) 才是硬上限；这里只需覆盖单次 DOM 静默间隙。每次 DOM mutation 都续期。
const PROGRAMMATIC_WINDOW_MS = 45000;

function markProgrammaticSend(agentTurnId: string, baselineCount: number): void {
  programmaticTurnId = agentTurnId;
  programmaticSendUntil = Date.now() + PROGRAMMATIC_WINDOW_MS;
  programmaticBaselineCount = baselineCount;
}

// 回合终态上报后（或硬过期）调用：彻底关闭程序化窗口，避免 programmaticTurnId 永不
// 复位（审计 Bug #7）——否则窗口在 truthy 时被 bumpProgrammaticWindow 无条件续期，
// 用户之后在可见 iframe 里手打的对话会被当成本回合回复扫读、其 fence 被误执行。
function clearProgrammaticTurn(): void {
  programmaticTurnId = null;
  programmaticSendUntil = 0;
  programmaticBaselineCount = 0;
}

// 当前是否处于"等待 / 接收某个程序化回合回复"的窗口。每次读到 DOM 变化都续期，
// 因为流式回复可能持续数十秒；只有长时间无 INJECT 才让窗口过期。过期时主动复位
// programmaticTurnId，使窗口真正关闭（Bug #7）。
function activeProgrammaticTurn(): string | null {
  if (!programmaticTurnId) return null;
  if (Date.now() > programmaticSendUntil) {
    clearProgrammaticTurn();
    return null;
  }
  return programmaticTurnId;
}

function bumpProgrammaticWindow(): void {
  // 仅在窗口仍真正有效（未过期）时续期；过期后不再无条件续命（Bug #7）。
  if (programmaticTurnId && Date.now() <= programmaticSendUntil) {
    programmaticSendUntil = Date.now() + PROGRAMMATIC_WINDOW_MS;
  }
}

// ── DOM helpers（自含，不依赖 index.ts 的私有 helper）────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 取首个可见、匹配选择器列表的元素（comma 分隔，按序优先）。
function querySelectorFirstVisible(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
    let el: HTMLElement | null = null;
    try {
      el = document.querySelector(selector) as HTMLElement | null;
    } catch {
      continue; // 非法选择器片段跳过
    }
    if (el && isVisible(el)) return el;
  }
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

// 数当前 DOM 里 assistant 回复容器总数（跨 responseSelector 列表取并集的最大计数）。
// 作为本回合「基线」：提交后只认 index 严格大于此数的新容器（Bug #3）。用「最大单选
// 择器计数」而非并集去重，避免多选择器命中同一节点时虚高——只要任一选择器新增一个
// 容器即视作本回合产出，足够区分新旧。
function countResponseContainers(adapter: PlatformAdapter): number {
  let max = 0;
  for (const selector of adapter.responseSelector.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const n = document.querySelectorAll(selector).length;
      if (n > max) max = n;
    } catch {
      /* 非法选择器片段跳过 */
    }
  }
  return max;
}

// 取首个发送按钮（不要求"可见输入框"语义，按钮可能是图标 div）。
function querySendButtonFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el) return el;
    } catch {
      continue;
    }
  }
  return null;
}

// sendButtonDisabled —— 与 ws-linker.ts 同款判定。AI 站点在填入值被框架 state
// 登记前一直把发送按钮挂着但 disabled，此时点击是 no-op（"有时发有时不发"）。
function sendButtonDisabled(btn: HTMLElement): boolean {
  if (btn.hasAttribute('disabled')) return true;
  const aria = (btn.getAttribute('aria-disabled') || '').toLowerCase();
  if (aria === 'true') return true;
  const realBtn = btn.closest('button');
  if (
    realBtn &&
    realBtn !== btn &&
    (realBtn.hasAttribute('disabled') || (realBtn.getAttribute('aria-disabled') || '').toLowerCase() === 'true')
  ) {
    return true;
  }
  return false;
}

function getNativeTextareaSetter(): ((this: unknown, value: string) => void) | undefined {
  return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
}

// effectiveFillMethod —— 与 editor-completion.ts 同款：textarea/input 一律 value；
// contenteditable 上配置成 value 的纠正为 execCommand。
function effectiveFillMethod(el: HTMLElement, configured: PlatformSelectors['fillMethod']): PlatformSelectors['fillMethod'] {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return 'value';
  if (el.isContentEditable && configured === 'value') return 'execCommand';
  return configured;
}

// 等编辑器 mount（iframe 内 SPA 可能还在 hydrate）。
async function waitForEditor(selectors: string, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = querySelectorFirstVisible(selectors);
    if (el) return el;
    await sleep(300);
  }
  return null;
}

function fillEditor(editor: HTMLElement, text: string, method: PlatformSelectors['fillMethod']): void {
  editor.focus();
  if (method === 'paste') {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } else if (method === 'execCommand') {
    // 先清空已有内容，避免上一轮残留与本轮拼接。
    const sel = window.getSelection();
    if (sel) {
      try {
        sel.selectAllChildren(editor);
      } catch {
        /* selection 不可用时直接插入 */
      }
    }
    document.execCommand('insertText', false, text);
  } else if (method === 'value') {
    const ta = editor as HTMLTextAreaElement;
    const setter = getNativeTextareaSetter();
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (method === 'prosemirror') {
    editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// 读编辑器当前文本（textarea/input 取 value，contenteditable 取 textContent）。
// 提交确认用：composer 提交后通常被站点清空。
function editorText(editor: HTMLElement): string {
  if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
    return (editor as HTMLTextAreaElement).value || '';
  }
  return editor.textContent || '';
}

// composer 是否「实际清空」：textarea 取 value；contenteditable 取规范化文本——
// ProseMirror/Lexical 提交后常留 `<p><br></p>` 等占位，textContent 仍含零宽/换行，
// 故把 ​/ /空白全剥后判空（否则永远判「未清空」→ 误报提交失败，Bug #9 回归）。
function composerCleared(editor: HTMLElement): boolean {
  const raw = editorText(editor).replace(/[​-‍﻿ \s]/g, '');
  return raw === '';
}

// 等发送按钮 enabled 再点。**点了 enabled 的发送按钮即视为提交成功**——按钮 enabled
// 表示站点框架已登记输入值，点击就会发送。不再强求观测到 composer 清空才返回 true
// （chatgpt 的 ProseMirror 提交后保留占位节点，清空检测不可靠，原实现因此误报
// "submit not confirmed" 把已成功的提交判失败、整轮中止 —— Bug #9 的回归）。
// 仅当始终等不到可点按钮时，才落 Enter 兜底并以 composer 清空作为唯一证据。
async function clickSendWhenReady(sel: PlatformSelectors, editor: HTMLElement, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sendBtn = querySendButtonFirst(sel.sendBtn);
    if (sendBtn) {
      if (sendButtonDisabled(sendBtn)) {
        // 值尚未登记，按钮还 disabled —— 等，绝不在 no-op 点击后返回 true。
        await sleep(200);
        continue;
      }
      sendBtn.click();
      // 点了 enabled 按钮 = 已提交。给框架一拍处理，乐观返回 true。
      await sleep(150);
      return true;
    }
    await sleep(250);
  }
  // 始终没等到可点按钮：合成 Enter 兜底。Enter 对合成事件不一定触发提交，故这里仍以
  // 「composer 清空」为证据确认（占位容忍），1.5s 内清空才算成功。
  dispatchEnterAsSendFallback(editor);
  const enterDeadline = Date.now() + 1500;
  while (Date.now() < enterDeadline) {
    if (composerCleared(editor)) return true;
    await sleep(120);
  }
  return false;
}

// ── 注入一次任务并提交 ─────────────────────────────────────────────────────
interface InjectResult {
  ok: boolean;
  error?: string;
}

async function injectAndSubmit(platform: string, prompt: string, agentTurnId: string): Promise<InjectResult> {
  const clean = (prompt || '').trim();
  if (!clean) return { ok: false, error: 'empty prompt' };

  const sel = resolveSelectors(platform);
  const isQwen = platform === 'qwen' || /(^|\.)qwen(lm)?\.ai$/.test(location.hostname);
  const sendTimeout = isQwen ? 90000 : 10000;

  let editor = querySelectorFirstVisible(sel.editor);
  if (!editor) editor = await waitForEditor(sel.editor, 30000);
  if (!editor) return { ok: false, error: 'composer editor not found' };

  // 在填入并提交之前打上程序化标记，使提交后出现的回复被读回路径当作本回合。
  // 同时快照当前 assistant 容器数作为基线：读回只认本回合之后新建的容器（Bug #3）。
  markProgrammaticSend(agentTurnId, countResponseContainers(resolveAdapter()));

  const method = effectiveFillMethod(editor, sel.fillMethod);
  try {
    fillEditor(editor, clean, method);
  } catch (err) {
    return { ok: false, error: `fill failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 给站点框架一个微任务窗口把 input 事件刷进内部 state，再去等发送按钮。
  await sleep(120);

  const sent = await clickSendWhenReady(sel, editor, sendTimeout);
  if (!sent) {
    return { ok: false, error: 'send button never enabled / submit not confirmed' };
  }
  return { ok: true };
}

// ── 读回 AI 回复（DOM-observe 主路径）──────────────────────────────────────
// 在匹配的 adapter.responseSelector 容器上做作用域 MutationObserver，组装回复
// 文本（adapter.extractText 负责平台代码块归一化），用 extractFenceToolCalls
// 提取 piercode-tool 工具块。debounce + settle，避免流式中途半截 JSON 误判。

class ReplyReader {
  private adapter: PlatformAdapter;
  private observer: MutationObserver | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  // 已上报过工具的回合，避免同一回合的后续 DOM 变化重复回传。
  private reportedTurns = new Set<string>();
  // 已发过 STREAM 预览的文本长度（按回合），只发增量。
  private streamedLenByTurn = new Map<string, number>();
  // 两个按回合累积的集合在长寿命 iframe 里只增不删，会缓慢泄漏（审计 Bug #18）。
  // turnId 全局单调递增，故按插入序裁到最近 N 个即可——旧回合 id 永不会再出现，
  // 删它们不影响去重正确性。
  private static readonly MAX_TRACKED_TURNS = 64;
  private capTrackedTurns(): void {
    while (this.reportedTurns.size > ReplyReader.MAX_TRACKED_TURNS) {
      const oldest = this.reportedTurns.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reportedTurns.delete(oldest);
      this.streamedLenByTurn.delete(oldest);
    }
    while (this.streamedLenByTurn.size > ReplyReader.MAX_TRACKED_TURNS) {
      const oldest = this.streamedLenByTurn.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.streamedLenByTurn.delete(oldest);
    }
  }

  constructor(
    adapter: PlatformAdapter,
    private onTools: (turnId: string, tools: ParsedToolCall[], rawContent: string) => void,
    private onStream: (turnId: string, chunk: string) => void,
  ) {
    this.adapter = adapter;
  }

  start(): void {
    if (this.observer) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });
    // 启动时也扫一次：INJECT 可能在 observer 装好之前就引出了回复。
    this.scheduleScan();
  }

  stop(): void {
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        /* ignore */
      }
      this.observer = null;
    }
    if (this.debounce) clearTimeout(this.debounce);
    if (this.settle) clearTimeout(this.settle);
    this.debounce = null;
    this.settle = null;
  }

  private scheduleScan(): void {
    // 先续期：DOM 一有动静就把窗口往后推，**必须在 active 判定之前**——否则窗口
    // 一旦到点，activeProgrammaticTurn() 返回 null 直接 return，续期永远轮不到，
    // 窗口再也复活不了（原 5s 窗口在 chatgpt 慢回复/CF 间隙下必死的根因）。
    // 仍有 programmaticTurnId（回合未被清除）就续期，无论是否已过期。
    bumpProgrammaticWindow();
    // 只在"程序化回合窗口"内工作；用户自己在可见 iframe 里打字不触发读回。
    if (!activeProgrammaticTurn()) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(), 250);
  }

  // 找到"最后一个"助手回复容器（最新回合在 DOM 末尾）。优先**本回合之后新建**的
  // 容器（匹配数严格大于提交基线 programmaticBaselineCount，Bug #3 防跨回合误读）；
  // 但若按基线找不到（基线被 chatgpt 双 responseSelector / 提交瞬间的占位容器算偏，
  // 或站点复用同一容器），**兜底退回 DOM 末尾容器**——绝不因基线算偏就返回 null 把
  // 整条读回链掐死（那会导致 AI 明明吐了工具却无卡片、不执行）。
  private latestResponseContainer(): Element | null {
    const selectors = this.adapter.responseSelector.split(',').map((s) => s.trim()).filter(Boolean);
    let strict: Element | null = null;
    let anyLast: Element | null = null;
    for (const selector of selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      if (nodes.length === 0) continue;
      anyLast = nodes[nodes.length - 1];
      // 严格：该选择器匹配数已超过基线 → 末元素是本回合新容器。
      if (nodes.length > programmaticBaselineCount) strict = nodes[nodes.length - 1];
    }
    return strict || anyLast;
  }

  private extractContainerText(el: Element): string {
    const buf: string[] = [];
    this.walk(el, buf);
    let text = buf.join('');
    // 兜底（关键）：adapter.extractText 靠 pre/code 标签 + class 命中把工具代码块转成
    // ```piercode-tool 围栏。chatgpt/qwen 把工具调用渲染成自定义折叠卡片（非标准
    // pre/code，或被虚拟化）时，walk 可能没产出任何 piercode-tool 围栏 → 解析为 0 →
    // 无卡片不执行。此时直接对容器的原始 textContent 扫裸 JSON 工具对象（{"name",
    // "args"/"arguments"}），把它们重新包成围栏补进文本，让 extractFenceToolCalls 能认。
    // 不依赖任何站点 DOM 结构假设。
    if (!FENCE_OPEN_RE_TEST.test(text)) {
      const raw = el.textContent || '';
      const recovered: string[] = [];
      recoverBareToolObjects(raw, recovered);
      if (recovered.length > 0) text += '\n' + recovered.join('\n');
    }
    return text;
  }

  // 递归提取：先给 adapter 处理（平台代码块 → piercode-tool fence 文本），命中
  // 即停；否则块级标签前补换行后继续下钻。镜像 content/index.ts 的 extractText。
  private walk(node: Node, buf: string[]): void {
    if (node.nodeType === Node.TEXT_NODE) {
      buf.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (this.adapter.extractText(el, buf)) return;
    if (BLOCK_TAGS.has(el.tagName)) buf.push('\n');
    for (const child of el.childNodes) this.walk(child, buf);
  }

  private scan(): void {
    const turnId = activeProgrammaticTurn();
    if (!turnId) { return; }
    const container = this.latestResponseContainer();
    if (!container) {
      // 诊断：基线把所有容器都滤掉了 → 无卡片的头号嫌疑（Bug #3 修复的回归面）。
      try {
        const total = document.querySelectorAll(this.adapter.responseSelector.split(',')[0].trim()).length;
        console.debug('[PierCode/ba] scan: no eligible container', { baseline: programmaticBaselineCount, total, turnId });
      } catch { /* ignore */ }
      return;
    }

    const text = this.extractContainerText(container);
    if (!text.trim()) return;
    // 诊断：拿到容器文本，看 extractFenceToolCalls 解析出几个工具。
    try {
      const parsedDbg = extractFenceToolCalls(text);
      console.debug('[PierCode/ba] scan: container text', {
        len: text.length, parsed: parsedDbg.length,
        names: parsedDbg.map(t => t.name), incomplete: hasIncompleteToolFence(text),
        head: text.slice(0, 120),
      });
    } catch { /* ignore */ }

    // 流式预览（best-effort）：只发本回合新增的文本片段。
    this.maybeStream(turnId, text);

    // 本回合已上报过工具就不再重复（同一容器流式期间会多次触发）。
    if (this.reportedTurns.has(turnId)) return;

    const parsed = extractFenceToolCalls(text);
    if (parsed.length === 0) {
      // 还没有完整工具块：可能仍在流式。安排一次 settle 重扫，兜住"工具块是
      // 回复最后一段、之后无 DOM 变动"的情况；同时也给"无工具=自然语言收尾"
      // 一个稳定判定的机会（由 SW 在拿到 rawContent 后裁决）。
      this.scheduleSettleFlush(turnId);
      return;
    }

    const browserTools = parsed
      .filter((tc) => isBrowserToolName(tc.name))
      .map((tc, i) => ({ name: tc.name, args: tc.args, call_id: tc.callId || `ba-${turnId}-${i}` }));

    if (browserTools.length === 0) {
      // 解析到的全是非 browser_* 工具：当作"无可执行动作"，交 settle/SW 处理。
      this.scheduleSettleFlush(turnId);
      return;
    }

    this.reportedTurns.add(turnId);
    this.onTools(turnId, browserTools, text);
    // 本回合工具已上报，回合终态：复位程序化窗口，避免 programmaticTurnId 永不复位
    // 导致用户后续手打对话被误扫读（Bug #7）。下一轮 INJECT 会重新 markProgrammaticSend。
    clearProgrammaticTurn();
  }

  // 当一轮回复看起来已完整但没有 browser_* 工具时，在 settle 窗口后把"无工具 +
  // rawContent"上报一次，让 SW 据此判定自然语言完成（tools:[] + rawContent）。
  private scheduleSettleFlush(turnId: string): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      if (this.reportedTurns.has(turnId)) return;
      if (activeProgrammaticTurn() !== turnId) return;
      const container = this.latestResponseContainer();
      if (!container) return;
      const text = this.extractContainerText(container);
      if (!text.trim()) return;
      const parsed = extractFenceToolCalls(text).filter((tc) => isBrowserToolName(tc.name));
      if (parsed.length > 0) {
        // settle 期间工具块流完了：正常上报。
        this.reportedTurns.add(turnId);
        this.onTools(
          turnId,
          parsed.map((tc, i) => ({ name: tc.name, args: tc.args, call_id: tc.callId || `ba-${turnId}-${i}` })),
          text,
        );
        clearProgrammaticTurn();
        return;
      }
      // 工具 fence 仍未闭合（chatgpt 慢回复/CF 间隙下 900ms 静默常见，而 fence 还在流式）：
      // 绝不报空——那会被 SW 当成自然语言完成、提前 DONE 并丢掉这次工具调用（审计 Bug #2）。
      // 重排一次 settle 等 fence 流完，镜像 content/index.ts scheduleSettleRetry 的处理。
      if (hasIncompleteToolFence(text)) {
        this.scheduleSettleFlush(turnId);
        return;
      }
      // fence 确已完整且无 browser_* 工具：真自然语言收尾，上报空工具 + 文本，SW 据此
      // 结束回合（completed），并复位程序化窗口（Bug #7）。
      this.reportedTurns.add(turnId);
      this.onTools(turnId, [], text);
      clearProgrammaticTurn();
    }, 900);
  }

  private maybeStream(turnId: string, text: string): void {
    const prev = this.streamedLenByTurn.get(turnId) || 0;
    if (text.length <= prev) return;
    const chunk = text.slice(prev);
    this.streamedLenByTurn.set(turnId, text.length);
    this.capTrackedTurns(); // 裁掉旧回合项，防长寿命 iframe 缓慢泄漏（Bug #18）。
    if (chunk.trim()) this.onStream(turnId, chunk);
  }
}

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  call_id: string;
}

// 非全局 test 正则：判定文本里是否已有 ```piercode-tool / ```tool 围栏开头
// （extractContainerText 的兜底门控：已有围栏就不再裸扫，避免重复）。
const FENCE_OPEN_RE_TEST = /```(?:piercode-tool|tool)\b/i;

// 从任意文本里 brace-match 出每个顶层 {...}，凡含 name + args/arguments 的 JSON
// 对象就重新包成 ```piercode-tool 围栏推进 buf。adapter.extractText 因站点 DOM
// 结构（自定义折叠卡片 / 虚拟化）漏抓时的最后兜底，不依赖任何标签/class 假设。
export function recoverBareToolObjects(text: string, buf: string[]): void {
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end === -1) break; // 对象未闭合 = 仍在流式，留待下次扫描
    const jsonStr = text.slice(start, end + 1).trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === 'object' && parsed.name && (parsed.args || parsed.arguments)) {
        buf.push('```piercode-tool\n' + jsonStr + '\n```');
      }
    } catch { /* 非工具 JSON，跳过 */ }
    i = end + 1;
  }
}

// 与 content/index.ts 的 BLOCK_TAGS / SKIP_TAGS 对齐（模块级常量，避免每次扫描重建）。
const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const SKIP_TAGS = new Set(['MS-THOUGHT-CHUNK', 'MAT-ICON', 'SCRIPT', 'STYLE', 'BUTTON', 'MAT-EXPANSION-PANEL-HEADER', 'SVG']);

// ── 端口连接与消息分发 ─────────────────────────────────────────────────────
let port: chrome.runtime.Port | null = null;
let reader: ReplyReader | null = null;
let installedPlatform = '';

// 出站重投队列（诊断 [high/medium]）：端口在 SW 休眠/重连窗口内断开时，
// postMessage 会静默丢弃。最关键的 TOOLS（工具回读）一旦丢失，SW 端 awaitTools
// 永等到 180s 超时 → 一轮白跑甚至整条链路卡死。故对"必达"消息排队，重连后立刻
// 重投。BRIDGE_READY / STREAM 这类瞬时消息不入队（重连会自然重发 READY，STREAM
// 只是预览丢了无碍）。每条入队消息带稳定 dedupeKey，重连重投不会与已成功投递的
// 重复（SW 端 settle 幂等：同 turn 二次 TOOLS 在无 pending 时被 break 忽略）。
interface QueuedMsg {
  msg: Record<string, unknown>;
  dedupeKey: string;
}
const outboundQueue: QueuedMsg[] = [];
const MAX_OUTBOUND_QUEUE = 50;

// 直发（不入队）：端口存在则投递并回是否成功；端口缺失/抛错回 false。
function rawPost(msg: Record<string, unknown>): boolean {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

function postUp(msg: Record<string, unknown>): void {
  // 瞬时消息：投不出去就算了（重连会自然恢复语义）。
  rawPost(msg);
}

// 必达消息：投递失败则入队，重连后 flush。dedupeKey 防止重投与已达项重复堆积。
function postUpReliable(msg: Record<string, unknown>, dedupeKey: string): void {
  if (rawPost(msg)) return;
  // 同 key 已在队列里则替换（保留最新载荷），否则追加；超额丢最旧。
  const idx = outboundQueue.findIndex(q => q.dedupeKey === dedupeKey);
  if (idx >= 0) outboundQueue[idx] = { msg, dedupeKey };
  else outboundQueue.push({ msg, dedupeKey });
  while (outboundQueue.length > MAX_OUTBOUND_QUEUE) outboundQueue.shift();
}

// 重连后清空出站队列（逐条尝试重投；投不出去的留回队列等下次）。
function flushOutboundQueue(): void {
  if (outboundQueue.length === 0) return;
  const pending = outboundQueue.splice(0, outboundQueue.length);
  for (const q of pending) {
    if (!rawPost(q.msg)) {
      // 仍投不出去（端口又断）：放回队列，等下次重连。
      outboundQueue.push(q);
    }
  }
}

function connectPort(platform: string): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  try {
    port = chrome.runtime.connect({ name: PORT_PREFIX + platform });
  } catch {
    port = null;
    return;
  }

  // 关键顺序（诊断 [high]）：**先**装 onMessage 监听，**再**发 BRIDGE_READY。
  // MV3 Port 无消息缓冲——若 SW 收到 BRIDGE_READY 后立刻经此端口回推 INJECT，而本端
  // 的 onMessage 尚未注册，那条 INJECT 会被静默丢弃 → injectTurn 永等 ACK 至 30s 超时
  // → 工具永不执行。先注册监听消除这个竞态。
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as { type?: string; prompt?: string; platform?: string; agentTurnId?: string } | null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== MSG_INJECT) return;

    const agentTurnId = String(msg.agentTurnId || '');
    const prompt = String(msg.prompt || '');
    console.debug('[PierCode/ba] INJECT received', { agentTurnId, promptLen: prompt.length, platform });
    // INJECT 一到就让读回器先就位：observer 装好后注入引出的回复才不会漏读
    // （注入失败也无害——程序化窗口需 markProgrammaticSend 才激活，未提交则 scan 早返回）。
    reader?.start();
    void injectAndSubmit(platform, prompt, agentTurnId)
      .then((res) => {
        console.debug('[PierCode/ba] injectAndSubmit result', { agentTurnId, ok: res.ok, error: res.error });
        // ACK 必达：SW 端 injectTurn 阻塞等它；丢失=注入超时一轮白跑。入队保命。
        postUpReliable({ type: MSG_INJECT_ACK, agentTurnId, ok: res.ok, error: res.error }, `ack:${agentTurnId}`);
        // 提交确认后确保读回器在跑（已在 injectAndSubmit 内打了程序化标记）。
        if (res.ok) reader?.start();
      })
      .catch((err) => {
        postUpReliable(
          {
            type: MSG_INJECT_ACK,
            agentTurnId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          `ack:${agentTurnId}`,
        );
      });
  });

  port.onDisconnect.addListener(() => {
    port = null;
    // SW 休眠会断开端口；自动重连，使下个回合的 INJECT 仍能下发。重连前小退避，
    // 避免 SW 彻底卸载时的紧密重试循环。
    setTimeout(() => {
      if (!port) connectPort(installedPlatform || platform);
    }, 500);
  });

  // 开口即宣告就绪：SW 用它解析本平台 INJECT 通道是否在线（契约 BRIDGE_READY）。
  // 监听已就位后再发，避免 SW 即刻回推的 INJECT 落空。
  postUp({ type: MSG_BRIDGE_READY, platform });

  // 重连后立刻 flush 出站队列：上次断开窗口里没投出去的 TOOLS/ACK 在此补投，
  // 这样 SW 端阻塞的 awaitTools 能尽快拿到工具，而不是干等 180s 超时。
  flushOutboundQueue();
}

// ── 安装入口 ───────────────────────────────────────────────────────────────
// 幂等：window flag 守卫，重复 import / 重复调用只装一次。仅在 isBrowserAgentFrame()
// 为真的帧里被 content/index.ts 经 queueMicrotask 调用（绕开 TDZ）。
export function installBrowserAgentBridge(): void {
  const w = window as unknown as { __PIERCODE_BROWSER_AGENT_BRIDGE__?: boolean };
  if (w.__PIERCODE_BROWSER_AGENT_BRIDGE__) return;
  if (!isBrowserAgentFrame()) return;
  w.__PIERCODE_BROWSER_AGENT_BRIDGE__ = true;

  const platform = browserAgentPlatformFromURL() || resolveAdapter().name;
  installedPlatform = platform;

  const adapter = resolveAdapter();
  reader = new ReplyReader(
    adapter,
    (turnId, tools, rawContent) => {
      console.debug('[PierCode/ba] onTools → SW', { turnId, toolCount: tools.length, names: tools.map(t => t.name), rawLen: rawContent.length });
      // TOOLS 必达（诊断 [high/medium]）：这是本轮回读的唯一产物，SW 端 awaitTools
      // 阻塞等它；端口在 SW 重连窗口断开时若静默丢失，整轮白跑直至 180s 超时。入队
      // 保命，重连后 flush。dedupeKey 按 turn——同 turn 二次投递在 SW 端幂等（无 pending
      // 即 break 忽略）。
      postUpReliable({ type: MSG_TOOLS, agentTurnId: turnId, platform, tools, rawContent }, `tools:${turnId}`);
    },
    (turnId, chunk) => {
      // 流式预览：瞬时、可丢，不入队（丢的只是 UI 预览片段，不影响正确性）。
      postUp({ type: MSG_STREAM, agentTurnId: turnId, chunk });
    },
  );

  connectPort(platform);
  console.log('[PierCode] browser-agent bridge installed:', platform, location.href);
}
