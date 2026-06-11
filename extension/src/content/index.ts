import { FENCE_RE, TOOL_RE, parseJsonFenceToolCall, parseXmlToolCall, tryParseToolJSON, parseAgentResultPacket, formatToolResults, toolDedupHash } from '../parser';
import { hasApiClient } from './platform-caps';
import { extractMonacoText, findQwenPierCodeBody, getAdapterNewSessionUrl, getAdapterProfileName, getPlatformAdapter, PlatformAdapter } from '../platform-adapters';
import { filterUserVisibleSkills, SkillSummary } from '../skills';
import { initWsLinker, onToolDone, onToolStream, onQuestionAsk, onQuestionCancel, onBrowserApprovalAsk, onBrowserApprovalDone, onBrowserAttachmentUpload, sendAIResponseLog, sendUserPromptLog, sendQuestionAnswer, sendQuestionCancel, sendBrowserApprovalAnswer, sendBrowserAttachmentUploadResult, getPierCodeClientId, workerAgentId, isWorkerStopped, sendAgentResult, injectToolResult } from './ws-linker';
import { isConversationURLForCurrentPage, observeConversationURL, getConversationKey } from './conversation-scope';
import { maybeTruncate } from './result-truncate';
import { isBalancedJson } from './json-complete';
import { visualIndicator } from './visual-indicator';
import { statusPanel, type ControlledTabInfo } from './status-panel';
import { computeMeter } from './token-meter';
import { getDestructiveCommandWarning } from './destructive-warning';
import { exposeAccessibilityTree, generateAccessibilityTree, getElementCoordinates, scrollToElement, clickElement, searchElements } from './accessibility-tree';
import { SinglePacketWaiter } from './qwen-context-packet-waiter';
import {
  compactToolOutputForChat,
  ConversationContext,
  compressAndPrepareNewSession,
  extractContextPacketFields,
  formatPacketHandoffPrompt,
  formatPierCodeContextPacketPrompt,
  formatQwenCompressedContextPrompt,
  formatTokenCount,
  parsePierCodeContextPacket,
  PierCodeContextPacket
} from './qwen-context-compress';
import {
  ContextCompressionConfig,
  resolveContextCompressionConfig,
  thresholdForPlatform,
} from './qwen-settings';
import { dispatchEnterAsSendFallback } from './send-fallback';
import { installUserSendReminder, markProgrammaticSend, isSystemReminderEnabled } from './user-send-reminder';
import { selectorsForHost } from './platform-selectors';
import { autoSubmitSettleRemainingMs } from './auto-submit-settle';
import { T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW, T_GLOW_SOFT, T_AMBER, T_RED, T_FONT } from './terminal-theme';
import { TIMING } from './timing';
import { DOM_EXTRACT } from './dom-extract-config';

// 静默窗口解析器（内联，避免 content 引入 ../settings 触发 Rollup 共享分块，
// 进而让 content.js 输出 ESM import —— MV3 classic content script 不允许）。
const DEFAULT_BATCH_QUIET_MS = 400;
const MIN_BATCH_QUIET_MS = 0;
const MAX_BATCH_QUIET_MS = 5000;

// Worker result packet fence: a dispatched worker reports back via a single
// ```piercode-agent-result fenced JSON block. Mirrors the piercode-context
// detection in qwen-context-compress.ts.
const AGENT_RESULT_FENCE_RE = /```piercode-agent-result\s*\n([\s\S]*?)\n```/gi;
function resolveBatchQuietMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BATCH_QUIET_MS;
  return Math.min(MAX_BATCH_QUIET_MS, Math.max(MIN_BATCH_QUIET_MS, Math.round(value)));
}

// 获取当前平台适配器
const platformAdapter: PlatformAdapter = getPlatformAdapter();
const platformProfile = getAdapterProfileName(platformAdapter);

const MONACO_ID_ATTR = 'data-piercode-monaco-id';
const MONACO_REQUEST = 'PIERCODE_MONACO_TEXT_REQUEST';
const MONACO_RESPONSE = 'PIERCODE_MONACO_TEXT_RESPONSE';

// Qwen page-context fetch proxy relay. The SW opens a port (name
// `piercode-page-fetch:<id>`) to this content script to forward a qwen API
// request; we relay it into the page world (page-bridge), where window.fetch
// runs through baxia's anti-bot patch and gets a valid bx-ua header. Response
// chunks stream back the reverse way. See background/qwen-page-fetch.ts.
const PAGE_FETCH_PORT_PREFIX = 'piercode-page-fetch:';
// SW ↔ content port message types:
const PF_REQUEST = 'PIERCODE_PAGE_FETCH';
const PF_ABORT = 'PIERCODE_PAGE_FETCH_ABORT';
const PF_HEAD = 'PIERCODE_PAGE_FETCH_HEAD';
const PF_CHUNK = 'PIERCODE_PAGE_FETCH_CHUNK';
const PF_DONE = 'PIERCODE_PAGE_FETCH_DONE';
const PF_ERROR = 'PIERCODE_PAGE_FETCH_ERROR';
// content ↔ page-bridge window.postMessage types:
const PF_EXEC = 'PIERCODE_PAGE_FETCH_EXEC';
const PF_EXEC_ABORT = 'PIERCODE_PAGE_FETCH_EXEC_ABORT';
const PF_EXEC_HEAD = 'PIERCODE_PAGE_FETCH_EXEC_HEAD';
const PF_EXEC_CHUNK = 'PIERCODE_PAGE_FETCH_EXEC_CHUNK';
const PF_EXEC_DONE = 'PIERCODE_PAGE_FETCH_EXEC_DONE';
const PF_EXEC_ERROR = 'PIERCODE_PAGE_FETCH_EXEC_ERROR';

// Passive listen channel relay. page-bridge tees the page's own chat-API SSE
// response and posts frames here (window.postMessage); content opens a fresh
// `piercode-api-listen:<requestId>` port to the SW per intercepted stream and
// forwards them. Opposite direction from page-fetch (page initiates here).
const AL_LISTEN_PORT_PREFIX = 'piercode-api-listen:';
const AL_SET = 'PIERCODE_API_LISTEN_SET';      // content → page-bridge: toggle relay
const AL_HEAD = 'PIERCODE_API_LISTEN_HEAD';
const AL_CHUNK = 'PIERCODE_API_LISTEN_CHUNK';
const AL_DONE = 'PIERCODE_API_LISTEN_DONE';
const AL_ERROR = 'PIERCODE_API_LISTEN_ERROR';

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(PAGE_FETCH_PORT_PREFIX)) return;
    const requestId = port.name.slice(PAGE_FETCH_PORT_PREFIX.length);
    let disconnected = false;

    // page-bridge → content → SW. Forward only this request's frames.
    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.requestId !== requestId) return;
      try {
        if (d.type === PF_EXEC_HEAD) port.postMessage({ type: PF_HEAD, requestId, ok: d.ok, status: d.status });
        else if (d.type === PF_EXEC_CHUNK) port.postMessage({ type: PF_CHUNK, requestId, b64: d.b64 });
        else if (d.type === PF_EXEC_DONE) port.postMessage({ type: PF_DONE, requestId });
        else if (d.type === PF_EXEC_ERROR) port.postMessage({ type: PF_ERROR, requestId, error: d.error });
      } catch {
        // port closed mid-stream — stop relaying.
      }
    };
    window.addEventListener('message', onWindowMessage);

    // SW → content → page-bridge.
    port.onMessage.addListener((msg: { type?: string; [k: string]: unknown }) => {
      if (!msg) return;
      if (msg.type === PF_REQUEST) {
        injectPageBridge();
        window.postMessage({
          type: PF_EXEC,
          requestId,
          url: msg.url,
          method: msg.method,
          headers: msg.headers,
          body: msg.body,
          stream: msg.stream,
        }, '*');
      } else if (msg.type === PF_ABORT) {
        window.postMessage({ type: PF_EXEC_ABORT, requestId }, '*');
      }
    });

    port.onDisconnect.addListener(() => {
      if (disconnected) return;
      disconnected = true;
      window.removeEventListener('message', onWindowMessage);
      // Tell the page world to cancel the in-flight fetch if any.
      window.postMessage({ type: PF_EXEC_ABORT, requestId }, '*');
    });
  });
}

// Passive listen relay: page-bridge tees the page's own chat-API SSE response
// and posts AL_* frames. For each intercepted stream we open a fresh port to the
// SW (keyed by the page-generated requestId) and forward HEAD/CHUNK/DONE/ERROR.
// The page only emits these when listen mode is on (flag set via AL_SET below).
if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
  const listenPorts = new Map<string, chrome.runtime.Port>();
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d.requestId !== 'string') return;
    const rid = d.requestId as string;
    try {
      if (d.type === AL_HEAD) {
        const port = chrome.runtime.connect({ name: AL_LISTEN_PORT_PREFIX + rid });
        listenPorts.set(rid, port);
        port.onDisconnect.addListener(() => listenPorts.delete(rid));
        port.postMessage({ type: AL_HEAD, platform: d.platform, ok: d.ok, status: d.status });
      } else if (d.type === AL_CHUNK) {
        listenPorts.get(rid)?.postMessage({ type: AL_CHUNK, b64: d.b64 });
      } else if (d.type === AL_DONE) {
        const port = listenPorts.get(rid);
        if (port) { try { port.postMessage({ type: AL_DONE }); } catch {} port.disconnect(); listenPorts.delete(rid); }
      } else if (d.type === AL_ERROR) {
        const port = listenPorts.get(rid);
        if (port) { try { port.postMessage({ type: AL_ERROR, error: d.error }); } catch {} port.disconnect(); listenPorts.delete(rid); }
      }
    } catch {
      // port closed mid-stream — drop it.
      listenPorts.delete(rid);
    }
  });
}

// SW/sidebar → content → page-bridge: turn the listen relay on/off for this tab.
// When listen mode is on, the SW listen channel (consumeListenStream →
// continueListenTurn) owns tool execution + send-back. The content DOM observer
// must NOT also execute the same fence (it would double-execute — the exact
// double-source hazard). So this flag gates the DOM auto-exec path: cards still
// render for inspection, but content does not run them.
let listenModeActive = false;
function isListenModeActive(): boolean {
  return listenModeActive;
}

function setApiListen(on: boolean): void {
  listenModeActive = on;
  injectPageBridge();
  window.postMessage({ type: AL_SET, on }, '*');
}

// runListenSend: enable the relay, then drive the page to DOM-submit `text`.
// Used by both the CHAT_LISTEN_SEND runtime message (production send-back from
// the SW) and a window-message diagnostic trigger (below). Leaves a DOM
// breadcrumb (data-piercode-listen-send) so the result is observable from the
// page MAIN world even though content runs in the isolated world.
async function runListenSend(text: string): Promise<{ ok: boolean; error?: string }> {
  const mark = (state: string) => {
    try { document.documentElement.setAttribute('data-piercode-listen-send', state); } catch {}
  };
  if (!text.trim()) { mark('empty'); return { ok: false, error: 'empty text' }; }
  mark('start');
  setApiListen(true);
  try {
    const sent = await fillAndSend(text, true, { forceSend: true, immediate: true });
    mark(sent ? 'sent' : 'fill-returned-false');
    return { ok: sent === true, error: sent ? '' : 'fillAndSend returned false' };
  } catch (error) {
    mark('threw:' + String(error).slice(0, 60));
    return { ok: false, error: String(error) };
  }
}

// Diagnostic trigger: drive runListenSend from the page MAIN world. Lets a CDP
// Runtime.evaluate exercise the send-back leg without the sidebar/SW. Harmless
// in production (no page emits this message).
window.addEventListener('message', event => {
  if (event.source !== window) return;
  const d = event.data;
  if (d && d.type === 'PIERCODE_TEST_LISTEN_SEND' && typeof d.text === 'string') {
    void runListenSend(d.text);
  }
});

let pageBridgeInjected = false;

// Inject page-bridge as early as possible (document_start). It installs the
// keep-alive visibility shim in page context BEFORE the AI site's own scripts
// attach their `visibilitychange`/`document.hidden` listeners — otherwise a
// background/worker tab gets throttled and the site pauses its streaming
// response. Must run before the site mounts; later injection (post-init) is too
// late to beat the site's listeners on some platforms.
try {
  injectPageBridgeEarly();
} catch {}
let monacoIdSeq = 0;
let monacoRequestSeq = 0;
const CONTEXT_INVALID_MESSAGE = '扩展已失效，请刷新页面';
let lastContextInvalidNoticeAt = 0;
let responseSessionActivatedAt = 0;

// 上下文压缩状态（全平台启用，按平台阈值触发；packet 自压缩仅 Qwen 走 DOM 重扫
// 兜底，其余平台靠模型按提示词输出 packet）。
let qwenConversationCtx: ConversationContext | null = null;
let compressionInProgress = false;
let compressionConfigCache: ContextCompressionConfig | null = null;
let lastObservedConversationURL = '';
const MAX_CONVERSATION_CONTEXTS = 20;
const conversationCtxByURL = new Map<string, ConversationContext>();
function evictOldestConversationContext() {
  if (conversationCtxByURL.size <= MAX_CONVERSATION_CONTEXTS) return;
  // Map preserves insertion order; first key is the oldest.
  const oldest = conversationCtxByURL.keys().next().value;
  if (oldest !== undefined) conversationCtxByURL.delete(oldest);
}
/** Promote a key to newest position (LRU touch). */
function touchConversationContext(key: string) {
  const ctx = conversationCtxByURL.get(key);
  if (ctx !== undefined) {
    conversationCtxByURL.delete(key);
    conversationCtxByURL.set(key, ctx);
  }
}
// 熔断器（借鉴 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES）：连续 N 次压缩
// 失败就停止触发，根治"无限压缩/无限开新会话"——避免上下文不可恢复时每条消息
// 都徒劳重试。成功一次即重置。
const MAX_COMPRESSION_FAILURES = 3;
let compressionConsecutiveFailures = 0;
const qwenContextPacketWaiter = new SinglePacketWaiter<PierCodeContextPacket>();
const handledContextPacketHashes = new Set<number>();
// 注入新会话的首条 handoff payload 体积大（含整个 initPrompt），会被当成 user
// 消息计入预算。设此一次性标记让那一条不触发压缩，避免"刚注入初始化就立刻又压缩"
// 的环（尤其低阈值时）。仍计入预算用于显示，只是不触发。
let suppressNextCompressionTrigger = false;
// confirm 模式下，用户已对「当前这一轮超阈值」做过选择（压缩或跳过），在 token
// 进一步增长越过下一格之前不再重复弹卡，避免每条消息都打断。压缩成功或会话切换时重置。
let compressionConfirmPending = false;
let compressionPromptedAtTokens = 0;
// Set true when the user clicks 取消 on the in-progress compression card. Each
// await boundary in triggerContextCompression checks it and bails early so a slow
// model packet / new-session open can be abandoned mid-flight.
let compressionAborted = false;

// cancelCompression aborts an in-flight compression: stops waiting on the model
// packet and signals the run to abandon at its next checkpoint.
function cancelCompression(): void {
  if (!compressionInProgress) return;
  compressionAborted = true;
  clearPendingContextPacketWaiter();
  compressionStatusCard.set('cancelled');
}

// confirm 模式：到阈值后是否需要再次弹确认卡。用户点「跳过」后，要等 token 比上次
// 提示时显著增长（再涨 10%）才再次提示，否则视为同一轮，不重复打断。
function shouldPromptCompressionAgain(usedTokens: number): boolean {
  if (compressionConfirmPending) return false;
  if (compressionPromptedAtTokens === 0) return true;
  return usedTokens >= compressionPromptedAtTokens * 1.1;
}

// 是否对当前平台启用上下文压缩。目前 Qwen + ChatGPT 已验证 DOM 捕获/新会话注入；
// 其余平台默认关闭，避免误触发把没追踪全的上下文压坏。
const COMPRESSION_PLATFORMS = new Set(['qwen', 'chatgpt']);
function isCompressionPlatform(): boolean {
  return COMPRESSION_PLATFORMS.has(platformAdapter.name);
}

function syncConversationStateForCurrentURL(): void {
  // Key conversation state by the migration-stable conversation key, not the raw
  // URL. Otherwise the /new -> /chat/<uuid> flip would re-key mid-conversation,
  // orphaning the history built on /new and resetting the token meter to empty.
  const current = getConversationKey();
  if (!current || current === lastObservedConversationURL) return;

  if (lastObservedConversationURL && qwenConversationCtx) {
    conversationCtxByURL.set(lastObservedConversationURL, qwenConversationCtx);
    evictOldestConversationContext();
  }

  lastObservedConversationURL = current;
  qwenConversationCtx = conversationCtxByURL.get(current) ?? null;
  if (qwenConversationCtx) touchConversationContext(current);
  handledContextPacketHashes.clear();
  // New conversation surface: forget any pending compression confirm prompt.
  compressionConfirmPending = false;
  compressionPromptedAtTokens = 0;
  compressionConfirmCard.dismiss();
}

function updateQwenContext(role: 'user' | 'assistant' | 'system', content: string, sourceKey?: string, sourceEl?: Element): void {
  if (!isCompressionPlatform()) return;
  syncConversationStateForCurrentURL();
  const clean = content.trim();
  if (!clean) return;
  if (!qwenConversationCtx) {
    qwenConversationCtx = {
      messages: [],
      totalChars: 0,
      lastCompressedAt: 0
    };
  }
  if (sourceKey) {
    const existing = qwenConversationCtx.messages.find(m => m.sourceKey === sourceKey);
    if (existing) {
      if (existing.content === clean) return;
      qwenConversationCtx.totalChars += clean.length - existing.content.length;
      existing.content = clean;
      existing.timestamp = Date.now();
    } else {
      qwenConversationCtx.messages.push({ role, content: clean, timestamp: Date.now(), sourceKey });
      qwenConversationCtx.totalChars += clean.length;
    }
  } else {
    qwenConversationCtx.messages.push({ role, content: clean, timestamp: Date.now() });
    qwenConversationCtx.totalChars += clean.length;
  }
  if (lastObservedConversationURL) {
    conversationCtxByURL.set(lastObservedConversationURL, qwenConversationCtx);
    evictOldestConversationContext();
  }

  if (role === 'assistant' && maybeHandleQwenContextPacket(clean, sourceEl)) {
    return;
  }
  // 注入的首条 handoff(user)消费抑制标记，不触发压缩。只针对 user：assistant
  // 流式更新不该吃掉这枚标记，否则注入后第一段模型回应反而成了"被抑制"的那条。
  if (role === 'user' && suppressNextCompressionTrigger) {
    suppressNextCompressionTrigger = false;
    return;
  }
  void maybeTriggerQwenContextCompression();
}

function maybeHandleQwenContextPacket(text: string, sourceEl?: Element): boolean {
  if (!isCompressionPlatform()) return false;
  const packet = parsePierCodeContextPacket(text);
  if (!packet) return false;

  const packetHash = hashStr(packet.raw);
  if (handledContextPacketHashes.has(packetHash)) return true;
  handledContextPacketHashes.add(packetHash);

  // 不管走哪条路径，先把裸 JSON 换成可读卡片（有 sourceEl 时锚到该响应）。
  if (sourceEl) renderContextPacketCard(packet, sourceEl, packetHash);

  if (qwenContextPacketWaiter.resolve(packet)) {
    return true;
  }

  if (compressionInProgress) {
    return true;
  }

  // 熔断后不再为模型自发的 packet 开新会话，避免发送失败循环里模型反复吐包→反复
  // 开会话。卡片已渲染，用户仍能手动复制。
  if (compressionConsecutiveFailures >= MAX_COMPRESSION_FAILURES) {
    return true;
  }

  void openContextPacketInNewSession(packet, 'model_initiated');
  return true;
}

function waitForQwenContextPacket(): Promise<PierCodeContextPacket | null> {
  return qwenContextPacketWaiter.register();
}

function startQwenContextPacketTimeout(timeoutMs: number): void {
  qwenContextPacketWaiter.startTimeout(timeoutMs);
}

function clearPendingContextPacketWaiter(): void {
  qwenContextPacketWaiter.cancel();
}

async function loadCompressionConfig(): Promise<ContextCompressionConfig> {
  if (compressionConfigCache) return compressionConfigCache;
  if (!checkContext()) return resolveContextCompressionConfig(undefined);
  try {
    const stored = await chrome.storage.local.get(['contextCompressionConfig', 'qwenCompressionConfig']);
    compressionConfigCache = resolveContextCompressionConfig(
      stored.contextCompressionConfig,
      stored.qwenCompressionConfig
    );
  } catch {
    compressionConfigCache = resolveContextCompressionConfig(undefined);
  }
  return compressionConfigCache;
}

// 当前平台阈值。
function platformThreshold(config: ContextCompressionConfig): number {
  return thresholdForPlatform(config, platformAdapter.name);
}

// 把通用配置 + 当前平台阈值，折成压缩提示词/本地摘要函数需要的旧形状
// （maxContextTokens 用平台阈值，maxSummaryTokens 用通用值）。
function legacyShapeForPlatform(config: ContextCompressionConfig): {
  enabled: boolean;
  maxContextTokens: number;
  maxSummaryTokens: number;
} {
  return {
    enabled: config.enabled,
    maxContextTokens: platformThreshold(config),
    maxSummaryTokens: config.maxSummaryTokens,
  };
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && ('contextCompressionConfig' in changes || 'qwenCompressionConfig' in changes)) {
      compressionConfigCache = null; // 先失效缓存（含旧→新迁移）
      // tokenThreshold() 是同步读缓存：清 null 后若不主动重填，会回退到
      // STATUS_PANEL_FALLBACK_THRESHOLD，导致 popup 改阈值后小点不跟着变。
      // 立即重读 storage 重填缓存，再即时刷新一次小点。
      void loadCompressionConfig().then(() => refreshTokenMeterNow());
    }
    if (areaName === 'local' && 'stealthMode' in changes) {
      visualIndicator.configure({ stealth: resolveStealthMode(changes.stealthMode.newValue) });
      statusPanel.configure({ stealth: resolveStealthMode(changes.stealthMode.newValue) });
    }
  });
}

async function maybeTriggerQwenContextCompression(): Promise<void> {
  if (!qwenConversationCtx || compressionInProgress) return;
  if (!isCompressionPlatform()) return;
  // 熔断：连续多次压缩失败后停手，不再触发，避免无限重试/无限开新会话。
  if (compressionConsecutiveFailures >= MAX_COMPRESSION_FAILURES) {
    return;
  }
  const config = await loadCompressionConfig();
  if (!config.enabled) return;
  // 用精确 token 计量（tiktoken，未就绪回退字符估算）判断是否到阈值，
  // 取代旧的纯字符 shouldCompress。
  const used = computeMeter(qwenConversationCtx, platformAdapter.name).total;
  if (used < platformThreshold(config)) return;

  if (config.triggerMode === 'confirm') {
    // 手动确认模式：弹卡让用户选「压缩」还是「跳过继续执行」。不自动压缩。
    if (!shouldPromptCompressionAgain(used)) return;
    compressionConfirmPending = true;
    compressionPromptedAtTokens = used;
    compressionConfirmCard.show(used, platformThreshold(config), {
      onCompress: () => {
        compressionConfirmPending = false;
        void triggerContextCompression(config);
      },
      onSkip: () => {
        compressionConfirmPending = false;
        // 保留 compressionPromptedAtTokens，等再涨 10% 才重新提示。
      },
    });
    return;
  }

  await triggerContextCompression(config);
}

async function triggerContextCompression(config?: ContextCompressionConfig): Promise<void> {
  if (!qwenConversationCtx || compressionInProgress) return;
  const resolvedConfig = config || await loadCompressionConfig();
  if (!resolvedConfig.enabled) return;
  const legacyConfig = legacyShapeForPlatform(resolvedConfig);
  compressionInProgress = true;
  compressionAborted = false;
  // Starting a real compression run clears the confirm-prompt gate.
  compressionConfirmPending = false;
  compressionPromptedAtTokens = 0;
  compressionConfirmCard.dismiss();
  compressionStatusCard.set('requesting', undefined, { onCancel: cancelCompression });

  try {
    // 让模型自压缩：第一次按标准提示词，超时未出包则用更强约束重试一次，
    // 仍失败才退化到本地 DOM 摘要兜底（质量低很多）。
    const basePrompt = formatPierCodeContextPacketPrompt(qwenConversationCtx, legacyConfig);
    let packet = await requestContextPacketFromModel(basePrompt, 60000);
    if (compressionAborted) return;
    if (!packet) {
      console.warn('[PierCode] 首次未按时输出上下文包，加强约束重试一次');
      compressionStatusCard.set('retrying', undefined, { onCancel: cancelCompression });
      const strictPrompt = '现在只允许输出一个 `piercode-context` fenced JSON，'
        + '不要任何解释、寒暄、Markdown 标题或工具调用。\n\n' + basePrompt;
      packet = await requestContextPacketFromModel(strictPrompt, 45000);
      if (compressionAborted) return;
    }

    if (packet) {
      await openContextPacketInNewSession(packet, 'piercode_requested', true);
      return;
    }

    console.warn('[PierCode] 两次未输出上下文包，使用本地摘要兜底');
    compressionStatusCard.set('local_fallback', undefined, { onCancel: cancelCompression });
    const { summary, newContext } = await compressAndPrepareNewSession(
      qwenConversationCtx,
      (s) => console.log('[PierCode] 生成摘要:', s.slice(0, 200) + '...'),
      legacyConfig
    );
    if (compressionAborted) return;
    qwenConversationCtx = newContext;
    const initPrompt = await fetchInitPromptForCurrentProfile();
    if (compressionAborted) return;
    const payload = formatQwenCompressedContextPrompt(summary, initPrompt);
    await openNewSessionWithPayload(payload, '上下文已本地压缩，并已发送到新会话');
  } catch (err) {
    console.error('[PierCode] 压缩失败:', err);
    compressionConsecutiveFailures += 1;
    compressionStatusCard.set('failed', String(err).slice(0, 80));
    maybeWarnCompressionCircuitBreaker();
  } finally {
    clearPendingContextPacketWaiter();
    compressionInProgress = false;
    compressionAborted = false;
  }
}

// 熔断触发时提示一次，让用户知道为什么不再自动压缩。
function maybeWarnCompressionCircuitBreaker(): void {
  if (compressionConsecutiveFailures >= MAX_COMPRESSION_FAILURES) {
    console.warn(`[PierCode] 压缩连续失败 ${compressionConsecutiveFailures} 次，已熔断，停止自动压缩`);
    compressionStatusCard.set('failed', '连续失败已熔断，暂停自动压缩');
  }
}

// 给当前 Qwen 会话发"压缩成 packet"的提示词，并等模型在 timeoutMs 内回出 packet。
// 返回 packet 或 null（编辑器没找到 / 模型没按时输出）。
async function requestContextPacketFromModel(prompt: string, timeoutMs: number): Promise<PierCodeContextPacket | null> {
  const packetPromise = waitForQwenContextPacket();
  const sent = await fillAndSend(prompt, true, { forceSend: true, immediate: true });
  if (!sent) {
    clearPendingContextPacketWaiter();
    return null;
  }
  startQwenContextPacketTimeout(timeoutMs);
  return packetPromise;
}

// alreadyOwned: the caller (triggerContextCompression) has already set
// compressionInProgress and owns the run, so skip the re-entrancy guard that
// otherwise protects the standalone model-initiated path. Without this, the
// happy path (model returns a valid packet) would early-return here and the
// packet would be silently dropped — the new session never opens.
async function openContextPacketInNewSession(packet: PierCodeContextPacket, reason: string, alreadyOwned = false): Promise<void> {
  if (!alreadyOwned) {
    if (compressionInProgress) return; // another compression is already running
    compressionInProgress = true;
  }
  try {
    const packetText = packet.raw || packet.content;
    qwenConversationCtx = {
      messages: [
        { role: 'system', content: `[上下文已压缩:${reason}]\n\n${packetText}`, timestamp: Date.now() },
      ],
      totalChars: packetText.length,
      lastCompressedAt: Date.now(),
    };
    // 模型 packet 已是成型的 ```piercode-context 块，原样转发，不二次套壳。
    const initPrompt = await fetchInitPromptForCurrentProfile();
    const payload = formatPacketHandoffPrompt(packetText, initPrompt);
    await openNewSessionWithPayload(payload, '已发送到新会话');
  } finally {
    // Only release the flag we acquired. When alreadyOwned, the caller
    // (triggerContextCompression) owns it and clears it in its own finally.
    if (!alreadyOwned) compressionInProgress = false;
  }
}

// 在新标签开会话并把最终 payload 注入。payload 由调用方按路径(packet/本地摘要)构造好。
async function openNewSessionWithPayload(payload: string, successMessage: string): Promise<void> {
  if (compressionAborted) return;
  // 手动 handoff 模式：只把压缩结果复制到剪贴板并提示用户，不自动开标签、不自动发送。
  // 用户自己打开新会话粘贴。
  const cfg = await loadCompressionConfig();
  if (cfg.handoffMode === 'manual') {
    let copied = false;
    try {
      await navigator.clipboard.writeText(payload);
      copied = true;
    } catch {}
    compressionConsecutiveFailures = 0;
    compressionStatusCard.set('manual', copied ? '已复制到剪贴板，请自行打开新会话粘贴' : '复制失败，请手动复制状态卡内容');
    showToast(copied ? '压缩上下文已复制到剪贴板，请打开新会话粘贴' : '压缩完成，但复制到剪贴板失败', 6000);
    return;
  }

  compressionStatusCard.set('opening');
  try {
    await navigator.clipboard.writeText(payload);
  } catch {}

  const result = await openQwenCompressedContextSession(payload);
  if (result.ok) {
    // 成功一次即重置熔断计数。两条压缩路径(packet/本地兜底)都过这里。
    compressionConsecutiveFailures = 0;
    compressionStatusCard.set('done', successMessage);
  } else {
    compressionConsecutiveFailures += 1;
    compressionStatusCard.set('failed', '新会话发送失败，摘要已复制到剪贴板');
    console.warn('[PierCode] 新会话发送失败:', result.error);
    maybeWarnCompressionCircuitBreaker();
  }
}

function qwenNewSessionUrl(): string {
  return getAdapterNewSessionUrl(platformAdapter);
}

async function openQwenCompressedContextSession(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!checkContext()) return { ok: false, error: CONTEXT_INVALID_MESSAGE };
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_QWEN_COMPRESSED_CONTEXT',
      url: qwenNewSessionUrl(),
      text,
    });
    return response?.ok === true
      ? { ok: true }
      : { ok: false, error: response?.error || 'unknown error' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function fillCompressedContextWhenReady(text: string): Promise<boolean> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const editor = querySelectorFirst(getSiteConfig().editor);
    if (editor) {
      // 新标签 SPA 可能仍在 hydrate：editor 已可见但输入事件还没挂上。
      // 先等输入区稳定，再用 immediate 发送（会主动等发送按钮可点），
      // 单次填充避免重试把文本追加成重复内容。
      await new Promise(resolve => setTimeout(resolve, TIMING.HANDOFF_EDITOR_SETTLE_MS));
      // 这条注入的 handoff 体积大，标记为"不触发压缩"，避免刚注入就再压一轮。
      suppressNextCompressionTrigger = true;
      const sent = await fillAndSend(text, true, { forceSend: true, immediate: true });
      if (!sent) {
        // 没发出去就没人消费标记，清掉免得误抑制下一条真用户消息。
        suppressNextCompressionTrigger = false;
        console.warn('[PierCode] 压缩上下文已填入但发送失败（editor 消失或发送按钮未启用）');
      }
      return sent;
    }
    await new Promise(resolve => setTimeout(resolve, TIMING.EDITOR_POLL_MS));
  }
  console.warn('[PierCode] 压缩上下文注入失败：30s 内未找到 Qwen 输入框');
  return false;
}

async function handleCompressedContextMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!text.trim()) return { ok: false, error: 'empty compressed context' };
  try {
    const sent = await fillCompressedContextWhenReady(text);
    return sent ? { ok: true } : { ok: false, error: 'editor not found' };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function handleQwenE2EFillAndSend(text: string, nonce: string): Promise<void> {
  const reply = (ok: boolean, error = '') => {
    window.postMessage({ type: 'PIERCODE_E2E_FILL_AND_SEND_RESULT', nonce, ok, error }, '*');
  };
  try {
    if (!isQwenPage()) {
      reply(false, 'not a Qwen page');
      return;
    }
    if (!text.trim()) {
      reply(false, 'empty text');
      return;
    }
    const stored = await chrome.storage.local.get(['qwenE2EBridgeEnabled']);
    if (stored.qwenE2EBridgeEnabled !== true) {
      reply(false, 'Qwen E2E bridge is disabled');
      return;
    }
    const sent = await fillAndSend(text, true, { forceSend: true, immediate: true });
    reply(sent === true, sent ? '' : 'fillAndSend returned false');
  } catch (error) {
    reply(false, String(error));
  }
}

function activateResponseSession(): void {
  if (!responseSessionActivatedAt) responseSessionActivatedAt = Date.now();
}

function isResponseSessionActive(): boolean {
  return responseSessionActivatedAt > 0;
}

function injectPageScript(fileName: string): void {
  if (!checkContext()) return;
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(fileName);
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function injectPageBridge(): void {
  if (pageBridgeInjected) return;
  pageBridgeInjected = true;
  injectPageScript('page-bridge.js');
}

// Minimal, dependency-free page-bridge injection for the earliest document_start
// moment (before checkContext / DOM helpers are needed). Idempotent with
// injectPageBridge via the shared pageBridgeInjected guard.
function injectPageBridgeEarly(): void {
  if (pageBridgeInjected) return;
  if (typeof document === 'undefined') return;
  const root = document.head || document.documentElement;
  if (!root) return;
  try {
    if (!chrome?.runtime?.id) return;
  } catch {
    return;
  }
  pageBridgeInjected = true;
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-bridge.js');
  script.onload = () => script.remove();
  root.appendChild(script);
}

function normalizeCodeText(text: string): string {
  return text.replace(/\u00A0/g, ' ').trim();
}

function requestMonacoModelText(container: Element, visibleText: string): Promise<string | null> {
  const monacoEl = container.querySelector<HTMLElement>('.monaco-editor');
  if (!monacoEl) return Promise.resolve(null);

  let domId = monacoEl.getAttribute(MONACO_ID_ATTR);
  if (!domId) {
    domId = `piercode-monaco-${Date.now()}-${++monacoIdSeq}`;
    monacoEl.setAttribute(MONACO_ID_ATTR, domId);
  }

  injectPageBridge();
  const requestId = `piercode-monaco-request-${Date.now()}-${++monacoRequestSeq}`;

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 500);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== MONACO_RESPONSE || data.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      resolve(typeof data.text === 'string' ? normalizeCodeText(data.text) : null);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      type: MONACO_REQUEST,
      requestId,
      domId,
      visibleText
    }, '*');
  });
}

function clickQwenOverflowPlaceholders(container: Element): boolean {
  let clicked = false;
  container.querySelectorAll<HTMLElement>('.mtkoverflow').forEach(el => {
    if (el.dataset.piercodeClicked === '1') return;
    el.dataset.piercodeClicked = '1';
    el.click();
    clicked = true;
  });
  return clicked;
}

function isContextValid(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function notifyContextInvalid(): void {
  const now = Date.now();
  if (now - lastContextInvalidNoticeAt < 3000) return;
  lastContextInvalidNoticeAt = now;
  showToast(CONTEXT_INVALID_MESSAGE, 5000);
}

function checkContext(showNotice = false): boolean {
  if (isContextValid()) return true;
  document.querySelectorAll('[data-piercode-key]').forEach(el => el.remove());
  const btn = document.querySelector('button[style*="z-index:99999"]');
  if (btn) {
    (btn as HTMLButtonElement).disabled = true;
    (btn as HTMLButtonElement).textContent = '🔗 请刷新页面';
    (btn as HTMLButtonElement).style.background = '#666';
  }
  if (showNotice) notifyContextInvalid();
  return false;
}

function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      // JSON.parse of a non-array string (e.g. "{}" or "5") must NOT be returned
      // as string[]: downstream config.options.map() would throw and stall the
      // question flow. Only arrays are valid options.
      return Array.isArray(v) ? v.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function getNativeSetter() {
  return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
}

function resolveAutoExecute(value: unknown): boolean {
  // Keep this local so the content script stays a classic, single-file bundle.
  return typeof value === 'boolean' ? value : false;
}

function resolveAutoApproveBrowserActions(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function resolveStealthMode(value: unknown): boolean {
  // Keep this local so content.js remains a classic MV3 content script.
  return typeof value === 'boolean' ? value : false;
}

async function shouldAutoApproveBrowserActions(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(['autoApproveBrowserActions']);
    return resolveAutoApproveBrowserActions(result.autoApproveBrowserActions);
  } catch {
    return false;
  }
}

function decodeHTMLEntities(s: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

type FillMethod = 'paste' | 'execCommand' | 'value' | 'prosemirror';

interface SiteConfig {
  editor: string;
  sendBtn: string;
  // CSS selector(s) identifying the "stop generating" control. Present when the
  // stop state is expressible as plain CSS (most platforms). For platforms where
  // CSS can't distinguish the stop state (text-only buttons, send/stop sharing a
  // selector), leave stopBtn null and provide stopBtnMatch instead.
  stopBtn: string | null;
  // Custom finder for platforms where stopBtn CSS is insufficient (e.g. Chat Z's
  // text "跳过" button, AI Studio's Run/Stop button distinguished only by text).
  // Returns the live stop element, or null when not generating. Takes priority
  // over stopBtn when set.
  stopBtnMatch?: () => HTMLElement | null;
  fillMethod: FillMethod;
  useObserver: boolean;
  responseSelector?: string;
}

// findStopElement resolves the active "stop generating" control for a site,
// trying the custom matcher first then the CSS selector(s). Single source of
// truth for both the "is the response still generating?" check and the actual
// stop click, so the two can never disagree. Selector parse errors (e.g. :has()
// on old Chromium) are swallowed — a missing stop control just means "treat as
// not generating", which degrades to the settle-window fallback rather than
// crashing the caller.
function findStopElement(cfg: SiteConfig): HTMLElement | null {
  if (cfg.stopBtnMatch) {
    try {
      const el = cfg.stopBtnMatch();
      if (el) return el;
    } catch {
      // fall through to CSS
    }
  }
  if (cfg.stopBtn) return querySelectorFirst(cfg.stopBtn);
  return null;
}

interface ToolExecutionResult {
  output: string;
  stopStream: boolean;
  sendable: boolean;
  // The result was already filled into the chat input and submitted by this
  // call (e.g. spawn_agent's API route uses injectToolResult), so the batch
  // loop must NOT also accumulate it per-container / re-submit it.
  alreadyInjected?: boolean;
}

// ─── 流式工具输出分发 ─────────────────────────────────────────────────────────
// 同一个 call_id 的 ToolCard 注册自己的 stream/done 回调。WebSocket 收到事件后
// 通过 dispatch 路由。多 tab 都会收到广播，但只有对应卡片所在的 tab 命中。
type StreamChunkHandler = (stream: 'stdout' | 'stderr', text: string) => void;
type StreamDoneHandler = (exitCode: number, status: string, errMsg: string, durationMs: number) => void;

const streamChunkSubs = new Map<string, StreamChunkHandler>();
const streamDoneSubs = new Map<string, StreamDoneHandler>();
let streamDispatchersRegistered = false;
let attachmentUploadDispatcherRegistered = false;

function ensureStreamDispatchers() {
  if (streamDispatchersRegistered) return;
  streamDispatchersRegistered = true;
  onToolStream(msg => {
    const id = msg.call_id || msg.task_id;
    if (!id) return;
    const handler = streamChunkSubs.get(id);
    if (handler) handler(msg.stream, msg.text);
  });
  onToolDone(msg => {
    const id = msg.call_id || msg.task_id;
    if (!id) return;
    dismissBrowserApprovalPopupForCall(id);
    const handler = streamDoneSubs.get(id);
    if (handler) handler(msg.exit_code, msg.status, msg.error || '', msg.duration_ms);
  });
  onQuestionAsk(msg => {
    showRemoteQuestionPopup(msg.call_id, msg.question, Array.isArray(msg.options) ? msg.options : []);
  });
  onQuestionCancel(msg => {
    dismissRemoteQuestionPopup(msg.call_id);
  });
  onBrowserApprovalAsk(msg => {
    void handleBrowserApprovalAsk(msg);
  });
  onBrowserApprovalDone(msg => {
    dismissBrowserApprovalPopup(msg.approval_id, msg.call_id);
  });
}

interface AttachmentPayload {
  name: string;
  mimeType: string;
  dataBase64: string;
  bytes?: number;
}

function ensureAttachmentUploadDispatcher() {
  if (attachmentUploadDispatcherRegistered) return;
  attachmentUploadDispatcherRegistered = true;
  onBrowserAttachmentUpload(async msg => {
    try {
      const payload = await fetchScreenshotAttachment(msg.path);
      const file = new File([base64ToArrayBuffer(payload.dataBase64)], payload.name || msg.name || 'screenshot.jpg', {
        type: payload.mimeType || msg.mimeType || 'image/jpeg',
        lastModified: Date.now(),
      });
      await attachFileToCurrentChat(file);
      sendBrowserAttachmentUploadResult(msg.call_id, true);
      showToast(`截图已作为附件添加：${file.name}`, 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendBrowserAttachmentUploadResult(msg.call_id, false, message);
      showToast(`截图附件上传失败：${message}`, 5000);
    }
  });
}

async function fetchScreenshotAttachment(path: string): Promise<AttachmentPayload> {
  if (!checkContext(true)) throw new Error('扩展上下文已失效');
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) throw new Error('未配置 API 地址');
  const headers: any = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await bgFetch(`${apiEndpoint(apiUrl, '/attachments/screenshot')}?path=${encodeURIComponent(path)}`, { headers });
  if (response.status === 401) throw new Error('认证失败');
  if (!response.ok) throw new Error(response.body || `HTTP ${response.status}`);
  const payload = JSON.parse(response.body) as AttachmentPayload;
  if (!payload.dataBase64) throw new Error('截图数据为空');
  return payload;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function attachFileToCurrentChat(file: File): Promise<void> {
  await focusCurrentTabForSend();
  const editor = querySelectorFirst(getSiteConfig().editor) as HTMLElement | null;
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .filter(input => !input.disabled && acceptsImageFile(input, file));

  for (const input of prioritizeFileInputs(inputs, editor)) {
    if (tryAssignFileInput(input, file)) return;
  }
  if (editor && dispatchClipboardFile(editor, file)) return;
  if (editor && dispatchDropFile(editor, file)) return;
  throw new Error('未找到可用的附件上传入口');
}

function acceptsImageFile(input: HTMLInputElement, file: File): boolean {
  const accept = (input.getAttribute('accept') || '').trim().toLowerCase();
  if (!accept) return true;
  if (accept.includes('image/*')) return true;
  if (accept.includes(file.type.toLowerCase())) return true;
  const ext = file.name.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
  return accept.split(',').map(s => s.trim()).includes(ext);
}

function prioritizeFileInputs(inputs: HTMLInputElement[], editor: HTMLElement | null): HTMLInputElement[] {
  if (!editor) return inputs;
  const editorRect = editor.getBoundingClientRect();
  return inputs.slice().sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const ad = Math.abs(ar.top - editorRect.top) + Math.abs(ar.left - editorRect.left);
    const bd = Math.abs(br.top - editorRect.top) + Math.abs(br.left - editorRect.left);
    return ad - bd;
  });
}

function tryAssignFileInput(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!input.files && input.files.length > 0;
  } catch (error) {
    console.warn('[PierCode] file input 附件注入失败:', error);
    return false;
  }
}

function dispatchClipboardFile(target: HTMLElement, file: File): boolean {
  try {
    target.focus();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    transfer.setData('text/plain', file.name);
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return true;
  } catch (error) {
    console.warn('[PierCode] paste 附件注入失败:', error);
    return false;
  }
}

function dispatchDropFile(target: HTMLElement, file: File): boolean {
  try {
    target.focus();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const events = ['dragenter', 'dragover', 'drop'];
    for (const type of events) {
      const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    }
    return true;
  } catch (error) {
    console.warn('[PierCode] drop 附件注入失败:', error);
    return false;
  }
}

const activeQuestionPopups = new Map<string, HTMLDivElement>();
const activeBrowserApprovalPopups = new Map<string, HTMLDivElement>();

function showRemoteQuestionPopup(callID: string, question: string, options: unknown[]) {
  dismissRemoteQuestionPopup(callID);

  const panel = showInlineQuestionPanel({
    question,
    options,
    onSubmit: answer => {
      sendQuestionAnswer(callID, answer);
      dismissRemoteQuestionPopup(callID);
    },
    onCancel: () => {
      sendQuestionCancel(callID);
      dismissRemoteQuestionPopup(callID);
    },
  });
  panel.dataset.piercodeQuestionId = callID;
  activeQuestionPopups.set(callID, panel);
}

function dismissRemoteQuestionPopup(callID: string) {
  const el = activeQuestionPopups.get(callID);
  if (!el) return;
  el.remove();
  activeQuestionPopups.delete(callID);
}

function showBrowserApprovalPopup(msg: {
  approval_id: string;
  call_id?: string;
  action: string;
  tab?: { tabId?: number; title?: string; url?: string };
  target: string;
  risk: string;
}) {
  const existing = activeBrowserApprovalPopups.get(msg.approval_id);
  if (existing) existing.remove();
  if (msg.call_id) dismissBrowserApprovalPopupForCall(msg.call_id);
  const tabLine = msg.tab
    ? `tabId=${msg.tab.tabId ?? ''}\n标题：${msg.tab.title || '(untitled)'}\nURL：${msg.tab.url || '(unknown)'}`
    : '目标标签页未知';
  const panel = showInlineQuestionPanel({
    question: [
      `浏览器操作：${msg.action}`,
      '',
      tabLine,
      '',
      `目标：${msg.target || '(unknown)'}`,
      `风险：${msg.risk || '此操作会改变网页状态。'}`,
    ].join('\n'),
    options: ['允许', '拒绝'],
    onSubmit: answer => {
      const approved = answer.trim() === '允许' || answer.trim() === '1';
      sendBrowserApprovalAnswer(msg.approval_id, approved, approved ? '' : 'user rejected browser action');
      panel.remove();
      activeBrowserApprovalPopups.delete(msg.approval_id);
    },
    onCancel: () => {
      sendBrowserApprovalAnswer(msg.approval_id, false, 'user cancelled browser action');
      activeBrowserApprovalPopups.delete(msg.approval_id);
    },
  });
  panel.dataset.piercodeBrowserApprovalId = msg.approval_id;
  if (msg.call_id) panel.dataset.piercodeBrowserApprovalCallId = msg.call_id;
  activeBrowserApprovalPopups.set(msg.approval_id, panel);
}

async function handleBrowserApprovalAsk(msg: {
  approval_id: string;
  call_id?: string;
  action: string;
  tab?: { tabId?: number; title?: string; url?: string };
  target: string;
  risk: string;
}) {
  if (await shouldAutoApproveBrowserActions()) {
    if (msg.call_id) dismissBrowserApprovalPopupForCall(msg.call_id);
    dismissBrowserApprovalPopup(msg.approval_id, msg.call_id);
    const ok = sendBrowserApprovalAnswer(msg.approval_id, true, 'auto approved by extension setting');
    if (ok) showToast(`已自动允许浏览器操作：${msg.action || 'browser action'}`, 2500);
    return;
  }
  showBrowserApprovalPopup(msg);
}

function dismissBrowserApprovalPopupForCall(callID: string) {
  for (const [approvalID, el] of activeBrowserApprovalPopups) {
    if (el.dataset.piercodeBrowserApprovalCallId !== callID) continue;
    el.remove();
    activeBrowserApprovalPopups.delete(approvalID);
  }
}

function dismissBrowserApprovalPopup(approvalID: string, callID?: string) {
  const el = activeBrowserApprovalPopups.get(approvalID);
  if (el) {
    el.remove();
    activeBrowserApprovalPopups.delete(approvalID);
  }
  if (callID) dismissBrowserApprovalPopupForCall(callID);
}

type InlineQuestionPanelOptions = {
  question: string;
  options: unknown[];
  onSubmit: (answer: string) => void;
  onCancel?: () => void;
};

function showInlineQuestionPanel(config: InlineQuestionPanelOptions): HTMLDivElement {
  const options = config.options.map(opt => String(opt));
  const panel = document.createElement('div');
  panel.style.cssText = buildQuestionPanelStyle();
  let closed = false;
  const closePanel = () => {
    if (closed) return;
    closed = true;
    panel.remove();
  };
  const submitAnswer = (answer: string) => {
    if (!answer) return;
    config.onSubmit(answer);
    closePanel();
  };

  const header = document.createElement('div');
  header.textContent = 'PierCode 需要回答';
  header.style.cssText = `font-weight:600;margin-bottom:8px;color:${T_AMBER};font-family:${T_FONT}`;
  panel.appendChild(header);

  const body = document.createElement('div');
  body.textContent = config.question;
  body.style.cssText = 'white-space:pre-wrap;margin-bottom:10px;max-height:120px;overflow:auto';
  panel.appendChild(body);

  if (options.length > 0) {
    const optWrap = document.createElement('div');
    optWrap.style.cssText = 'display:grid;gap:6px;margin-bottom:10px';
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${i + 1}. ${opt}`;
      btn.style.cssText = [
        'width:100%', 'padding:7px 10px', `border:1px solid ${T_LINE}`, 'border-radius:6px',
        `background:${T_PANEL2}`, `color:${T_TXT}`, 'cursor:pointer', 'font-size:12px',
        'text-align:left', 'line-height:1.35', `font-family:${T_FONT}`,
      ].join(';');
      btn.onmouseenter = () => { btn.style.background = T_PANEL; btn.style.borderColor = T_GLOW; btn.style.color = T_GLOW; };
      btn.onmouseleave = () => { btn.style.background = T_PANEL2; btn.style.borderColor = T_LINE; btn.style.color = T_TXT; };
      btn.onclick = () => submitAnswer(opt);
      optWrap.appendChild(btn);
    });
    panel.appendChild(optWrap);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = options.length > 0 ? '自定义回答，或输入选项序号后回车' : '输入回答后回车';
  input.style.cssText = [
    'width:100%', 'padding:8px 10px', 'box-sizing:border-box',
    `border:1px solid ${T_LINE}`, 'border-radius:6px',
    `background:${T_PANEL2}`, `color:${T_TXT}`, 'font-size:13px',
    'outline:none', `font-family:${T_FONT}`,
  ].join(';');
  panel.appendChild(input);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:10px';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = `padding:5px 10px;border:1px solid ${T_LINE};border-radius:4px;background:transparent;color:${T_DIM};cursor:pointer;font-family:${T_FONT}`;
  cancelBtn.onclick = () => {
    config.onCancel?.();
    closePanel();
  };

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.textContent = '提交';
  submitBtn.style.cssText = `padding:5px 14px;border:1px solid ${T_GLOW};border-radius:4px;background:transparent;color:${T_GLOW};cursor:pointer;font-weight:600;font-family:${T_FONT};box-shadow:0 0 0 1px ${T_GLOW_SOFT}`;

  const submit = () => {
    let answer = input.value.trim();
    if (!answer) return;
    const idx = parseInt(answer, 10);
    if (options.length > 0 && !Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
      answer = options[idx - 1];
    }
    submitAnswer(answer);
  };

  submitBtn.onclick = submit;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      config.onCancel?.();
      closePanel();
    }
  });

  actions.append(cancelBtn, submitBtn);
  panel.appendChild(actions);

  document.body.appendChild(panel);
  setTimeout(() => input.focus(), 50);
  return panel;
}

function buildQuestionPanelStyle(): string {
  const editor = querySelectorFirst(getSiteConfig().editor);
  const rect = editor?.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const margin = 12;
  const availableWidth = Math.max(320, viewportWidth - margin * 2);
  const width = Math.min(680, availableWidth, Math.max(480, rect?.width ?? 560));
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const left = rect
    ? Math.min(Math.max(rect.left + rect.width - width, margin), maxLeft)
    : Math.max(margin, viewportWidth - width - 20);
  const bottom = rect && rect.top > 80
    ? Math.min(Math.max(viewportHeight - rect.top + margin, margin), viewportHeight - 80)
    : 96;

  return [
    'position:fixed', `left:${Math.round(left)}px`, `bottom:${Math.round(bottom)}px`,
    `width:${Math.round(width)}px`, 'z-index:2147483646',
    'max-height:min(420px, calc(100vh - 32px))', 'overflow:auto',
    'padding:14px 16px', 'box-sizing:border-box',
    `background:${T_PANEL}`, `color:${T_TXT}`,
    `border:1px solid ${T_LINE}`, 'border-radius:10px',
    `box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 10px 30px rgba(0,0,0,0.5)`,
    `font-family:${T_FONT}`,
    'font-size:13px', 'line-height:1.5',
  ].join(';');
}

// renderTodoChecklist renders the todo array (from todo_write args) as a
// styled checklist in the given container. Mirrors the Go-side
// formatTodoChecklist so the user sees the same picture regardless of which
// tool ran. Accepts strings or {text/content/title, status} objects.
function renderTodoChecklist(container: HTMLElement, todos: unknown[]) {
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

function getToolCallId(data: any): string {
  return String(data?.callId || data?.call_id || '');
}

function ensureToolCallId(data: any, key: string): any {
  const existing = getToolCallId(data);
  if (existing) {
    return data.callId ? data : { ...data, callId: existing };
  }
  return { ...data, callId: `ol_${Math.abs(hashStr(key)).toString(36)}` };
}

// aiStudioStopBtnMatch is the special "stop generating" finder for Google AI
// Studio. Its Run/Stop share the same ms-run-button button (type="button", not
// submit), distinguished ONLY by text content ("Run" vs containing "Stop"), so
// CSS can't express the stop state — hence platform-selectors marks aistudio's
// stopBtn as null and this callback is attached here. The page also has other
// ms-button-primary buttons (API key, Tools), so we can't take the first match;
// we narrow to ms-run-button button then check text. Lives in index.ts (not the
// selector table) because it needs the DOM helper isVisibleElement.
function aiStudioStopBtnMatch(): HTMLElement | null {
  const btn = document.querySelector('ms-run-button button') as HTMLElement | null;
  if (btn && isVisibleElement(btn) && btn.textContent?.includes('Stop')) return btn;
  return null;
}

function getSiteConfig(): SiteConfig {
  // 优先使用平台适配器的 responseSelector，回退到表里的默认值
  const adapterSelector = platformAdapter.responseSelector;
  // Selector strings/order live in the PLATFORM_SELECTORS table (single source of
  // truth); this builder applies the runtime-only bits: the adapter override and
  // the AI-Studio stopBtnMatch callback when CSS can't express the stop state.
  const base = selectorsForHost(location.hostname);
  return {
    editor: base.editor,
    sendBtn: base.sendBtn,
    stopBtn: base.stopBtn,
    // base.stopBtn === null ⇒ no CSS can distinguish the stop state (AI Studio):
    // attach the text-content callback instead.
    ...(base.stopBtn === null ? { stopBtnMatch: aiStudioStopBtnMatch } : {}),
    fillMethod: base.fillMethod,
    useObserver: true,
    responseSelector: adapterSelector || base.responseSelector
  };
}

// bootstrapContentScript holds the whole content-script init. It is DECLARED here
// but CALLED at the very bottom of the module (see end of file), so it runs only
// after every module-level `const`/`let`/IIFE below has been initialized. Init
// wires observers/timers/listeners that call functions which close over those
// later bindings (e.g. `toolCardAnimStylesInjected` at line ~1614, the
// `compressionStatusCard` IIFE at ~3033). If init ran inline at its source
// position, an observer firing during/just after eval would reach a binding still
// in its temporal dead zone → "Cannot access X before initialization" — exactly
// the crash seen in Hub iframe panes (content.js injected into a page that already
// has a Monaco/tool-block DOM, so a mutation fires a scan → renderToolCard →
// ensureToolCardAnimStyles before `let ho` ran). Deferring the WHOLE init to EOF
// removes the TDZ window entirely.
function bootstrapContentScript() {
  if ((window as any).__PIERCODE_LOADED__) return;
  (window as any).__PIERCODE_LOADED__ = true;
  // 构建标记：用于确认浏览器跑的是最新 content.js（控制台查 __PIERCODE_BUILD__）。
  (window as any).__PIERCODE_BUILD__ = 'worker-id-send-2026-06-07';
  console.log('[PierCode] content loaded, build:', (window as any).__PIERCODE_BUILD__);

  const cfg = getSiteConfig();

  if (platformAdapter.name === 'qwen') {
    injectPageBridge();
  }
  initWsLinker();
  // 启动时读取隐身模式设置，确保第一次显示指示器前外观已正确。
  try {
    chrome.storage?.local?.get(['stealthMode'], (result) => {
      visualIndicator.configure({ stealth: resolveStealthMode(result?.stealthMode) });
      statusPanel.configure({ stealth: resolveStealthMode(result?.stealthMode) });
    });
  } catch {
    // storage 不可用时保持默认（非隐身），不阻塞初始化。
  }
  // 状态面板：显示操作状态/提供商/token/受控 tab。
  // 用 queueMicrotask 延后：startTokenRefresh / tokenThreshold 依赖的 const/let
  // 声明在本顶层块之后（TDZ），同步调用会抛 ReferenceError。微任务在整个模块求值
  // 完成后执行，绕开 TDZ。try/catch 再兜底，面板异常绝不中断后续 content 初始化。
  queueMicrotask(() => {
    try {
      statusPanel.init();
      statusPanel.setProvider(platformAdapter.name, platformProfile);
      chrome.runtime?.sendMessage?.({ type: 'GET_CONTROLLED_TAB' }, (msg) => {
        if (msg?.type === 'PIERCODE_CONTROLLED_TAB') {
          statusPanel.setControlledTab((msg.info ?? null) as ControlledTabInfo | null);
        }
      });
      startTokenRefresh();
    } catch (err) {
      console.warn('[PierCode] 状态面板初始化失败:', err);
    }
  });
  // 用户手动发送消息时追加 operating reminder（同样经 queueMicrotask 绕开 TDZ）。
  queueMicrotask(() => {
    try {
      installUserSendReminderWithDeps();
    } catch (err) {
      console.warn('[PierCode] 用户发送提醒初始化失败:', err);
    }
  });

  // 后台子 agent（API 路由）生命周期广播 → 状态面板行。background 的 broadcast()
  // 用 runtime.sendMessage 只到 sidebar；CHAT_AGENT_SPAWN/DONE 另经 tabs.sendMessage
  // 转发到本内容脚本（见 chat-api.ts broadcastAgentLifecycle）。✕ 取消复用既有
  // CHAT_AGENT_ABORT 路径（StatusPanel.renderAgents 内发出）。
  try {
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'CHAT_AGENT_SPAWN' && msg.agentId) {
        statusPanel.addAgent(String(msg.agentId), String(msg.label || 'agent'));
      } else if (msg.type === 'CHAT_AGENT_DONE' && msg.agentId) {
        statusPanel.setAgentDone(String(msg.agentId), String(msg.status || 'done'));
      }
    });
  } catch {
    // runtime.onMessage 不可用时静默（不阻塞后续初始化）。
  }
  // Register WS dispatchers (tool_stream/done + question_ask/cancel) up
  // front so question popups can appear even before any ToolCard renders.
  ensureStreamDispatchers();
  ensureAttachmentUploadDispatcher();

  // 暴露无障碍树 API
  exposeAccessibilityTree();

  if (!cfg.useObserver) {
    injectPageScript('injected.js');
  } else if (cfg.responseSelector) {
    const sel = cfg.responseSelector;
    // Safe to start directly: bootstrapContentScript runs at EOF, after every
    // module-level binding the render path touches is initialized (no TDZ window).
    if (document.body) startDOMObserver(sel);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(sel));
  }

  if (document.body) injectInitButton();
  else document.addEventListener('DOMContentLoaded', injectInitButton);

  function mountInputListener() {
    const attachCurrentEditor = () => {
      const editorEl = querySelectorFirst(getSiteConfig().editor);
      if (editorEl) attachInputListener(editorEl as HTMLElement);
    };

    attachCurrentEditor();
    const obs = new MutationObserver(attachCurrentEditor);
    obs.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', event => {
      const target = event.target as HTMLElement | null;
      const editorEl = findEditorFromTarget(target);
      if (editorEl) attachInputListener(editorEl);
    }, true);
  }
  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);

  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg?.type !== 'PIERCODE_E2E_FILL_AND_SEND') return;
    if (event.source !== window) return;
    handleQwenE2EFillAndSend(String(msg.text || ''), String(msg.nonce || ''));
  });

  // 监听来自background的消息
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'HIDE_INDICATORS') {
      visualIndicator.hideAllIndicators();
      return false;
    }

    // Toggle the passive listen relay for this tab (sidebar listen mode).
    if (msg.type === 'CHAT_LISTEN_SET') {
      setApiListen(msg.on === true);
      sendResponse({ ok: true });
      return false;
    }

    // Listen-mode send: enable the relay, then drive the page to send `text`.
    // The page's own fetch is teed back to the SW (see api-listen). The relay
    // flag is set before fillAndSend submits, so the request is intercepted.
    if (msg.type === 'CHAT_LISTEN_SEND') {
      const text = String(msg.text || '');
      runListenSend(text)
        .then(r => sendResponse(r))
        .catch(error => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (msg.type === 'PIERCODE_FILL_COMPRESSED_CONTEXT') {
      handleCompressedContextMessage(String(msg.text || ''))
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    // 处理无障碍树相关请求
    if (msg.type === 'GENERATE_SNAPSHOT') {
      const { filter, maxDepth, maxChars, refId } = msg.params || {};
      try {
        const result = generateAccessibilityTree(filter, maxDepth, maxChars, refId);
        sendResponse({ success: true, ...result });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
      return true;
    }

    if (msg.type === 'GET_ELEMENT_COORDINATES') {
      const coords = getElementCoordinates(msg.ref);
      sendResponse(coords);
      return false;
    }

    if (msg.type === 'SCROLL_TO_ELEMENT') {
      const success = scrollToElement(msg.ref);
      sendResponse({ success });
      return false;
    }

    if (msg.type === 'CLICK_ELEMENT') {
      const result = clickElement(msg.ref);
      sendResponse(result);
      return false;
    }

    if (msg.type === 'SEARCH_ELEMENTS') {
      const results = searchElements(msg.query, msg.maxResults);
      sendResponse({ results });
      return false;
    }

    if (msg.type === 'PIERCODE_CONTROLLED_TAB') {
      statusPanel.setControlledTab((msg.info ?? null) as ControlledTabInfo | null);
      return false;
    }

    return false;
  });
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

// 状态面板 token 阈值：优先用已加载的压缩配置（按平台），未加载完成前回退
// 通用默认。config 由 startTokenRefresh 异步预热进 compressionConfigCache。
const STATUS_PANEL_FALLBACK_THRESHOLD = 128_000;

function tokenThreshold(): number {
  if (compressionConfigCache) return platformThreshold(compressionConfigCache);
  return STATUS_PANEL_FALLBACK_THRESHOLD;
}

// scanConversation 扫描页面会话，分类 user/assistant 消息供 token 计量。
// 压缩平台（qwen/chatgpt）复用已维护的 qwenConversationCtx；其他平台按选择器扫 DOM。
function scanConversation(): ConversationContext {
  if (isCompressionPlatform() && qwenConversationCtx) {
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
  return { messages, totalChars, lastCompressedAt: 0 };
}

let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
// 立刻按当前 ctx + 阈值刷新状态面板小点。模块级，便于阈值变更后即时重画，
// 不必等下一个 3s tick。
function refreshTokenMeterNow(): void {
  try {
    syncConversationStateForCurrentURL();
    const ctx = scanConversation();
    const meter = computeMeter(ctx, platformAdapter.name);
    statusPanel.setMeter(meter, tokenThreshold());
  } catch {}
}
let tokenVisibilityListenerBound = false;
function startTokenRefresh(): void {
  if (tokenRefreshTimer) return;
  void loadCompressionConfig(); // 预热缓存，让 tokenThreshold 用上真实平台阈值
  refreshTokenMeterNow();
  tokenRefreshTimer = setInterval(refreshTokenMeterNow, 3000);
  // 后台标签页的 setInterval 会被 Chrome 节流，导致面板数据停留在切走前的旧值。
  // 标签页重新可见时立即重算一次，保证每个标签切回来看到的是自己会话的最新数据。
  if (!tokenVisibilityListenerBound && typeof document !== 'undefined') {
    tokenVisibilityListenerBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshTokenMeterNow();
    });
  }
}

function getConversationId(): string {
  // Stable conversation identity that survives the /new -> /chat/<uuid> SPA
  // migration. Using a migration-stable key keeps exec dedup (isExecuted) keys
  // consistent across the URL flip, so a refresh after migration does not re-run
  // already-executed tools (the old pathname-derived id changed across the flip).
  const key = getConversationKey();
  if (key) return key;
  const m = location.pathname.match(/\/(?:chat|c)\/([^/?#]+)/) || location.search.match(/[?&]id=([^&]+)/);
  return m ? m[1] : `${location.hostname}${location.pathname}${location.search}`;
}

function scopedExecutionKey(key: string): string {
	return key;
}

function isExecuted(key: string): boolean {
  try {
		const scopedKey = scopedExecutionKey(key);
    const store: Record<string, number> = JSON.parse(localStorage.getItem('piercode_executed') || '{}');
		// Exact match only. The old `endsWith(':'+key)` legacy fallback could
		// cross-match a different conversation's entry when `key` is a bare
		// numeric hash (no call_id) that happens to equal another key's call_id
		// suffix, silently skipping a never-executed tool. Legacy-format entries
		// age out via the 7-day TTL in markExecuted.
		return !!store[scopedKey];
  } catch { return false; }
}

const TTL = 7 * 24 * 60 * 60 * 1000;

function markExecuted(key: string): void {
  try {
    key = scopedExecutionKey(key);
    const store: Record<string, number> = JSON.parse(localStorage.getItem('piercode_executed') || '{}');
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - store[k] > TTL) delete store[k];
    }
    store[key] = now;
    localStorage.setItem('piercode_executed', JSON.stringify(store));
  } catch {}
}

async function executeToolCallRaw(toolCall: any): Promise<string | null> {
  if (!checkContext(true)) return null;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return '请先在插件中配置 API 地址';
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const request = withPlatformProfile(toolCall);
  const response = await bgFetch(apiEndpoint(apiUrl, '/exec'), { method: 'POST', headers, body: JSON.stringify(request) });
  if (!isConversationURLForCurrentPage(request.conversation_url)) return null;
  if (response.status === 401) return '认证失败，请在插件中重新输入 Token';
  if (!response.ok) return `[PierCode 错误] HTTP ${response.status}`;
  const result = JSON.parse(response.body);
  const output = result.output || result.error || '[PierCode] 空响应';
  const name = result.name || request.name || '';
  const callId = result.callId || result.call_id || request.callId || request.call_id || '';
  return name ? `### ${name} #${callId}\n${output}` : output;
}

// ── Recoverable spawn-agent batch ───────────────────────────────────────────
// Chrome can kill the background service worker mid-batch (30s idle / 5-min
// cap), which used to reject the single long-lived sendMessage and lose all
// sub-agent work. Recoverable mode: background acks the start immediately and
// persists progress; we resolve on a pushed CONTENT_SPAWN_RESULT, with a 20s
// status poll as fallback — each poll also wakes a killed SW, which then
// resumes the batch from its checkpoints.
const SPAWN_POLL_INTERVAL_MS = 20 * 1000;
const SPAWN_BATCH_TIMEOUT_MS = 30 * 60 * 1000;

function runSpawnBatchRecoverable(spawns: any[]): Promise<any[]> {
  const batchKey = `cbatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let unknownStreak = 0;
    const deadline = Date.now() + SPAWN_BATCH_TIMEOUT_MS;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      try { chrome.runtime?.onMessage?.removeListener(onPush); } catch {}
      fn();
    };

    const onPush = (msg: any) => {
      if (msg?.type === 'CONTENT_SPAWN_RESULT' && msg.batchKey === batchKey) {
        finish(() => resolve(msg.results || []));
      }
    };
    try { chrome.runtime?.onMessage?.addListener(onPush); } catch {}

    const poll = async () => {
      if (settled) return;
      if (Date.now() > deadline) {
        finish(() => reject(new Error('子 agent 批次超时')));
        return;
      }
      try {
        const st = await chrome.runtime.sendMessage({ type: 'CONTENT_SPAWN_STATUS', batchKey });
        if (settled) return;
        if (st?.state === 'done') {
          finish(() => resolve(st.results || []));
        } else if (st?.state === 'unknown') {
          // Record gone AND batch not live: storage.session lost (browser
          // restart) or record swept. Tolerate transient races, then give up.
          unknownStreak++;
          if (unknownStreak >= 3) finish(() => reject(new Error('后台子 agent 批次状态丢失')));
        } else {
          unknownStreak = 0;
        }
      } catch {
        // SW mid-restart — this sendMessage already woke it; next tick reads state.
      }
    };

    void (async () => {
      const start = { type: 'CONTENT_SPAWN_AGENT', spawns, platform: platformProfile, batchKey };
      try {
        const resp = await chrome.runtime.sendMessage(start);
        if (!resp?.ok) {
          finish(() => reject(new Error(String(resp?.error || '未知错误'))));
          return;
        }
        // Old background without recoverable mode answers with results inline.
        if (!resp.accepted && resp.results) {
          finish(() => resolve(resp.results));
          return;
        }
      } catch (err) {
        // SW died during kickoff; the failed sendMessage restarts it — retry once.
        try {
          const retry = await chrome.runtime.sendMessage(start);
          if (!retry?.ok) {
            finish(() => reject(new Error(String(retry?.error || err))));
            return;
          }
          if (!retry.accepted && retry.results) {
            finish(() => resolve(retry.results));
            return;
          }
        } catch (err2) {
          finish(() => reject(err2 instanceof Error ? err2 : new Error(String(err2))));
          return;
        }
      }
      if (!settled) pollTimer = setInterval(() => { void poll(); }, SPAWN_POLL_INTERVAL_MS);
    })();
  });
}

async function executeToolCallReturn(toolCall: any, withGuidance = true): Promise<ToolExecutionResult> {
  if (!checkContext(true)) return { output: '', stopStream: false, sendable: false };
  if (toolCall.name === 'question') {
    const q: string = toolCall.args?.question ?? '';
    const rawOpts = toolCall.args?.options;
    const opts: string[] = parseOptions(rawOpts);
    const answer = await showQuestionPopup(q, opts);
    return { output: answer, stopStream: false, sendable: true };
  }

  // spawn_agent on API-client platforms (qwen/chatgpt/claude/openai) runs the
  // sub-agent as an in-memory API sub-conversation in the background worker
  // (NO new tab) and injects the result back into the chat. Other platforms
  // fall through to /exec, where the server opens a tab-worker (unchanged).
  if (toolCall.name === 'spawn_agent' && hasApiClient(platformProfile)) {
    const spawn = {
      name: toolCall.name,
      args: toolCall.args || {},
      call_id: getToolCallId(toolCall),
    };
    try {
      const results = await runSpawnBatchRecoverable([spawn]);
      injectToolResult(maybeTruncate(formatToolResults(results)));
    } catch (error) {
      injectToolResult(`子 agent 失败: ${error instanceof Error ? error.message : error}`);
    }
    // Result already filled + submitted via injectToolResult; mark executed but
    // don't let the batch loop accumulate it per-container / submit it again.
    return { output: '', stopStream: false, sendable: true, alreadyInjected: true };
  }

  try {
    if (!checkContext(true)) return { output: '', stopStream: false, sendable: false };
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (!apiUrl) return { output: '请先在插件中配置 API 地址', stopStream: false, sendable: true };

    const request = withPlatformProfile(toolCall, withGuidance);
    const response = await bgFetch(apiEndpoint(apiUrl, '/exec'), {
      method: 'POST',
      headers,
      body: JSON.stringify(request)
    });

    if (!isConversationURLForCurrentPage(request.conversation_url)) return { output: '', stopStream: false, sendable: false };

    if (response.status === 401) return { output: '认证失败，请在插件中重新输入 Token', stopStream: false, sendable: true };
    if (!response.ok) return { output: `[PierCode 错误] HTTP ${response.status}`, stopStream: false, sendable: true };

    const result = JSON.parse(response.body);
    return {
      output: result.output || result.error || '[PierCode] 空响应',
      stopStream: !!result.stopStream,
      sendable: true
    };
  } catch (error) {
    return { output: `[PierCode 错误] ${error}`, stopStream: false, sendable: true };
  }
}

// 注入工具卡动画样式（一次）。状态点脉冲动画给「执行中/后台执行」用。
let toolCardAnimStylesInjected = false;
function ensureToolCardAnimStyles(): void {
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
function findToolBlockElement(sourceEl: Element, data: any): HTMLElement | null {
  const callId = getToolCallId(data);
  const name = String(data?.name || '');
  const candidates = Array.from(
    sourceEl.querySelectorAll<HTMLElement>(
      'pre, .qwen-markdown-code, .language-piercode-tool, .language-tool'
    )
  ).filter(el => !el.closest('[data-piercode-key]')); // skip already-decorated

  const looksLikeTool = (t: string) => t.includes('"name"') || t.includes('piercode-tool') || t.includes("'name'");
  // 1) exact call_id match
  if (callId) {
    for (const el of candidates) {
      const t = el.textContent || '';
      if (looksLikeTool(t) && t.includes(callId)) return el;
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

function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>) {
  data = ensureToolCallId(data, key);

  // Prefer in-place decoration of the AI's ```piercode-tool code block. Fall back
  // to inserting above the message only when the block can't be located.
  const blockEl = findToolBlockElement(sourceEl, data);
  // Find stable anchor: message-content's parent, which Angular doesn't rebuild
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = blockEl?.parentElement ?? messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return;

  // Prevent duplicate cards
  if (anchor.querySelector(`[data-piercode-key="${CSS.escape(key)}"]`)) return;
  if (blockEl?.getAttribute('data-piercode-decorated') === '1') return;

  ensureStreamDispatchers();

  const args = data.args || {};
  const card = document.createElement('div');
  card.setAttribute('data-piercode-key', key);
  card.style.cssText = `border:1px solid ${T_LINE};border-radius:10px;padding:12px 14px;margin:10px 0;background:${T_PANEL};color:${T_TXT};font-size:13px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 2px 10px rgba(0,0,0,0.4);font-family:${T_FONT}`;

  ensureToolCardAnimStyles();

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
  const nameBadge = document.createElement('span');
  nameBadge.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:13px;color:${T_GLOW};background:${T_PANEL2};border:1px solid ${T_LINE};border-radius:6px;padding:2px 8px`;
  nameBadge.textContent = `◆ ${data.name}`;
  header.appendChild(nameBadge);
  const callId = document.createElement('span');
  callId.style.cssText = `color:${T_DIM};font-size:11px;font-family:${T_FONT}`;
  callId.textContent = `#${getToolCallId(data)}`;
  header.appendChild(callId);

  // 状态药丸：展示 未执行/执行中/已执行/后台执行/失败 + 动画。
  const statePill = document.createElement('span');
  statePill.style.cssText = 'margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;border-radius:999px;padding:2px 10px';
  const stateDot = document.createElement('span');
  stateDot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex-shrink:0';
  const stateText = document.createElement('span');
  statePill.append(stateDot, stateText);
  header.appendChild(statePill);

  type CardState = 'pending' | 'running' | 'background' | 'done' | 'error';
  const STATE_META: Record<CardState, { label: string; color: string; pulse: boolean }> = {
    pending:    { label: '[run]',  color: T_AMBER, pulse: false },
    running:    { label: '[run]',  color: T_AMBER, pulse: true },
    background: { label: '[run]',  color: T_AMBER, pulse: true },
    done:       { label: '[done]', color: T_GLOW,  pulse: false },
    error:      { label: '[fail]', color: T_RED,   pulse: false },
  };
  function setCardState(s: CardState): void {
    const meta = STATE_META[s];
    statePill.style.background = meta.color + '22';
    statePill.style.color = meta.color;
    stateDot.style.background = meta.color;
    stateDot.style.animation = meta.pulse ? 'piercodeCardPulse 1s ease-in-out infinite' : 'none';
    stateText.textContent = meta.label;
  }
  setCardState('pending');
  card.appendChild(header);

  // 折叠区：工具名/id 已在 header 识别出来；参数详情默认隐藏，点标题展开。
  const details = document.createElement('details');
  details.style.cssText = `margin:8px 0;background:${T_PANEL2};border-radius:6px;padding:0;border:1px solid ${T_LINE}`;
  const summary = document.createElement('summary');
  summary.style.cssText = `cursor:pointer;list-style:none;padding:6px 8px;font-size:11px;color:${T_DIM};user-select:none`;
  summary.textContent = '参数详情（点击展开）';
  details.appendChild(summary);
  const argsBox = document.createElement('div');
  argsBox.style.cssText = 'padding:8px';
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
      val.style.cssText = `color:${T_TXT};font-size:12px;font-family:${T_FONT};white-space:pre-wrap;max-height:80px;overflow-y:auto`;
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
    rawDetails.style.cssText = `margin:8px 0 0;background:${T_PANEL2};border-radius:6px;padding:0;border:1px solid ${T_LINE}`;
    const rawSummary = document.createElement('summary');
    rawSummary.style.cssText = `cursor:pointer;list-style:none;padding:6px 8px;font-size:11px;color:${T_DIM};user-select:none`;
    rawSummary.textContent = '原始工具调用（点击展开）';
    rawDetails.appendChild(rawSummary);
    card.appendChild(rawDetails);
    // Keep the original block in its original DOM position (don't move it — some
    // SPAs re-read/rebuild it), just hide it by default and reveal it when the
    // user expands "原始工具调用". prevDisplay preserves the platform's own value.
    const prevDisplay = blockEl.style.display;
    blockEl.style.display = 'none';
    rawDetails.addEventListener('toggle', () => {
      blockEl.style.display = rawDetails.open ? prevDisplay : 'none';
    });
  }

  // Destructive-command warning banner (exec_cmd only). Informational, does not
  // block execution — surfaces what the command may do before the user clicks 执行.
  if (String(data.name).toLowerCase() === 'exec_cmd') {
    const cmdStr = typeof args.command === 'string' ? args.command : (typeof args.cmd === 'string' ? args.cmd : '');
    const warning = getDestructiveCommandWarning(cmdStr);
    if (warning) {
      const warnBox = document.createElement('div');
      warnBox.style.cssText = `margin:8px 0;background:${T_PANEL2};border:1px solid ${T_AMBER};border-left:3px solid ${T_AMBER};border-radius:6px;padding:8px 10px;color:${T_AMBER};font-size:12px;line-height:1.45;font-family:${T_FONT}`;
      warnBox.textContent = `⚠️ 危险命令：${warning}`;
      card.appendChild(warnBox);
    }
  }

  // streamBox: only shown once we actually start receiving live chunks.
  // exec_cmd uses this for both foreground streaming and background tasks.
  let streamBox: HTMLDivElement | null = null;
  function ensureStreamBox(): HTMLDivElement {
    if (streamBox) return streamBox;
    streamBox = document.createElement('div');
    streamBox.style.cssText = `margin-top:10px;background:${T_PANEL2};border:1px solid ${T_LINE};border-radius:6px;padding:8px;max-height:240px;overflow-y:auto;font-family:${T_FONT};font-size:12px;color:${T_TXT};white-space:pre-wrap`;
    card.insertBefore(streamBox, btnRow);
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

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center';
  const execBtn = document.createElement('button');
  execBtn.textContent = '执行';
  execBtn.style.cssText = `padding:5px 16px;background:transparent;color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:${T_FONT};box-shadow:0 0 0 1px ${T_GLOW_SOFT}`;
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '忽略';
  skipBtn.style.cssText = `padding:5px 12px;background:transparent;color:${T_DIM};border:1px solid ${T_LINE};border-radius:6px;cursor:pointer;font-size:12px;margin-left:auto;font-family:${T_FONT}`;
  btnRow.appendChild(execBtn);
  let bgBtn: HTMLButtonElement | null = null;
  if (String(data.name).toLowerCase() === 'exec_cmd') {
    bgBtn = document.createElement('button');
    bgBtn.textContent = '后台执行';
    bgBtn.style.cssText = `padding:5px 12px;background:transparent;color:${T_AMBER};border:1px solid ${T_AMBER};border-radius:6px;cursor:pointer;font-size:12px;font-family:${T_FONT}`;
    btnRow.appendChild(bgBtn);
  }
  btnRow.appendChild(skipBtn);
  card.appendChild(btnRow);

  const callIdForStream = getToolCallId(data);
  const isExecCmd = String(data.name).toLowerCase() === 'exec_cmd';
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
      execBtn.textContent = ok
        ? `✅ 完成 (exit=${exitCode}, ${(durationMs / 1000).toFixed(1)}s)`
        : `❌ ${status} (exit=${exitCode}${errMsg ? `, ${errMsg}` : ''})`;
      execBtn.disabled = true;
      if (bgBtn) bgBtn.disabled = true;
    });
  }

  execBtn.onclick = async () => {
    execBtn.disabled = true;
    execBtn.textContent = '执行中...';
    setCardState('running');
    subscribe();

    // 显示可视化指示器
    visualIndicator.showPulsingBorder();
    visualIndicator.showStatusBadge('loading');
    statusPanel.setOpState('executing');

    try {
      const text = await executeToolCallRaw(data);
      if (text === null) {
        execBtn.textContent = '请刷新页面';
        setCardState('error');
        unsubscribeStream();
        visualIndicator.hideAllIndicators();
        return;
      }
      markExecuted(key);
      setCardState('done');

      // 显示完成状态
      visualIndicator.showStatusBadge('completed');
      statusPanel.setOpState('done');
      setTimeout(() => visualIndicator.hideAllIndicators(), 1500);

      // For exec_cmd whose live stream already populated streamBox, don't
      // duplicate the full output in a second box — just append a small
      // separator and the insert-to-chat button. Non-stream tools (and
      // exec_cmd runs that produced no chunks at all) get the original
      // resultBox so the user can copy/insert.
      if (isExecCmd && sawStreamChunk) {
        const insertBtn = document.createElement('button');
        insertBtn.textContent = '插入到对话';
        insertBtn.style.cssText = `margin-top:6px;padding:4px 12px;background:transparent;color:${T_GLOW};border:1px solid ${T_LINE};border-radius:6px;cursor:pointer;font-size:12px;font-family:${T_FONT}`;
        insertBtn.onclick = () => fillAndSend(text, true);
        card.appendChild(insertBtn);
      } else {
        const resultBox = document.createElement('div');
        resultBox.style.cssText = `margin-top:10px;background:${T_PANEL2};border-radius:6px;padding:8px;max-height:200px;overflow-y:auto;font-family:${T_FONT};font-size:12px;color:${T_TXT};white-space:pre-wrap;border:1px solid ${T_LINE}`;
        resultBox.textContent = text;
        const insertBtn = document.createElement('button');
        insertBtn.textContent = '插入到对话';
        insertBtn.style.cssText = `margin-top:6px;padding:4px 12px;background:transparent;color:${T_GLOW};border:1px solid ${T_LINE};border-radius:6px;cursor:pointer;font-size:12px;font-family:${T_FONT}`;
        insertBtn.onclick = () => fillAndSend(text, true);
        card.appendChild(resultBox);
        card.appendChild(insertBtn);
      }
      if (execBtn.textContent === '执行中...') execBtn.textContent = '✅ 已执行';
      // For foreground exec_cmd, the HTTP response already carries the final
      // output and the server will not send any tool_done for this call_id.
      // Drop the subscription so the map doesn't leak.
      if (!isExecCmd || (isExecCmd && !data.args?.background)) {
        unsubscribeStream();
      }
    } catch {
      execBtn.textContent = '❌ 执行失败';
      execBtn.disabled = false;
      setCardState('error');
      unsubscribeStream();
      visualIndicator.showStatusBadge('error');
      statusPanel.setOpState('error');
      setTimeout(() => visualIndicator.hideAllIndicators(), 2000);
    }
  };

  if (bgBtn) {
    bgBtn.onclick = async () => {
      bgBtn!.disabled = true;
      execBtn.disabled = true;
      execBtn.textContent = '后台执行中...';
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
          execBtn.textContent = '请刷新页面';
          setCardState('error');
          unsubscribeStream();
          return;
        }
        markExecuted(key);
        // text contains "[backgrounded as task ...]" — show it under the args
        // so the user can correlate the task_id with the live stream below.
        const info = document.createElement('div');
        info.style.cssText = `margin-top:6px;color:${T_GLOW};font-size:11px;font-family:${T_FONT};white-space:pre-wrap`;
        info.textContent = text;
        card.insertBefore(info, btnRow);
      } catch {
        execBtn.textContent = '❌ 后台启动失败';
        execBtn.disabled = false;
        bgBtn!.disabled = false;
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
}

// 把 piercode-context 包渲染成完整字段卡（带复制按钮），替代聊天里的裸 JSON。
// 锚定到响应消息上方，packetHash 去重防止流式重扫重复插卡。
function renderContextPacketCard(packet: PierCodeContextPacket, sourceEl: Element, packetHash: number): void {
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return;

  const cardKey = `ctx:${packetHash}`;
  if (anchor.querySelector(`[data-piercode-key="${CSS.escape(cardKey)}"]`)) return;

  const fields = extractContextPacketFields(packet);
  const card = document.createElement('div');
  card.setAttribute('data-piercode-key', cardKey);
  card.style.cssText = `border:1px solid ${T_LINE};border-left:3px solid ${T_GLOW};border-radius:10px;padding:12px 14px;margin:10px 0;background:${T_PANEL};color:${T_TXT};font-size:13px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 2px 10px rgba(0,0,0,0.4);font-family:${T_FONT}`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px';
  const badge = document.createElement('span');
  badge.style.cssText = `display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:13px;color:${T_GLOW};background:${T_PANEL2};border:1px solid ${T_LINE};border-radius:6px;padding:2px 8px`;
  badge.textContent = '📦 上下文已压缩';
  header.appendChild(badge);
  if (fields.reason) {
    const reasonTag = document.createElement('span');
    reasonTag.style.cssText = `color:${T_DIM};font-size:11px;font-family:${T_FONT}`;
    reasonTag.textContent = fields.reason;
    header.appendChild(reasonTag);
  }
  card.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = `background:${T_PANEL2};border-radius:6px;padding:8px 10px;border:1px solid ${T_LINE}`;

  const addTextRow = (label: string, value: string) => {
    if (!value.trim()) return;
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px';
    const lab = document.createElement('div');
    lab.style.cssText = `color:${T_GLOW};font-size:11px;margin-bottom:2px`;
    lab.textContent = label;
    const val = document.createElement('div');
    val.style.cssText = `color:${T_TXT};font-size:12px;white-space:pre-wrap;word-break:break-word`;
    val.textContent = value;
    row.append(lab, val);
    body.appendChild(row);
  };
  const addListRow = (label: string, items: string[]) => {
    if (!items.length) return;
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px';
    const lab = document.createElement('div');
    lab.style.cssText = `color:${T_GLOW};font-size:11px;margin-bottom:2px`;
    lab.textContent = `${label} (${items.length})`;
    row.appendChild(lab);
    const ul = document.createElement('ul');
    ul.style.cssText = `margin:0;padding-left:18px;color:${T_TXT};font-size:12px`;
    for (const item of items) {
      const li = document.createElement('li');
      li.style.cssText = 'margin-bottom:2px;white-space:pre-wrap;word-break:break-word';
      li.textContent = item;
      ul.appendChild(li);
    }
    row.appendChild(ul);
    body.appendChild(row);
  };

  addTextRow('目标', fields.goal);
  addListRow('关键技术概念', fields.key_concepts);
  addListRow('关键文件', fields.key_files);
  addListRow('错误与修复', fields.errors_fixes);
  addListRow('问题求解', fields.problem_solving);
  addListRow('用户消息', fields.user_messages);
  addTextRow('当前状态', fields.current_state);
  addListRow('已完成', fields.completed);
  addListRow('证据', fields.evidence);
  addListRow('待办', fields.pending);
  addListRow('约束', fields.constraints);
  addTextRow('下一步', fields.next_action);
  // 本地摘要包：没有结构化字段，只有 context 文本。
  addTextRow('摘要', fields.context);

  // 解析不出任何字段时，至少展示原始内容，避免空卡。
  if (!body.childElementCount) {
    addTextRow('原始内容', packet.content);
  }
  card.appendChild(body);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制';
  copyBtn.style.cssText = `padding:5px 16px;background:transparent;color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:${T_FONT};box-shadow:0 0 0 1px ${T_GLOW_SOFT}`;
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(packet.raw || packet.content);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    } catch {
      copyBtn.textContent = '复制失败';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    }
  };
  btnRow.appendChild(copyBtn);
  card.appendChild(btnRow);

  anchor.insertBefore(card, messageContent);
}

function startDOMObserver(_responseSelector: string) {
  const processed = new Set<string>();
  const ignoredPreSessionContainers = new WeakSet<Element>();
  // 内容脚本初始化那一刻就已存在的回复容器（历史对话）。任何在此之后**新出现**
  // 的回复容器都视为本会话的新回复 —— 无论它来自插件注入、用户直接在网页里
  // 提交、还是点"重新生成"。用它来自动激活会话，避免只靠 PIERCODE_PROMPT_SUBMITTED
  // 事件（该事件只在插件注入提交时触发，用户直接提交/重新生成都不触发，导致
  // 首次回复被当历史漏掉、只有二次触发才识别）。
  const preInitContainers = new WeakSet<Element>();
  // 记录每个 preInit 容器在初始化时的文本长度。"重新生成"常常**原地复用**旧容器
  // 并重写其文本，此时容器仍在快照里，但文本长度会先归零再增长 —— 据此识别原地
  // 重新生成并激活会话。
  const preInitTextLen = new WeakMap<Element, number>();
  let preInitMarked = false;
  // Response containers seen before the backend connected. Replayed on
  // PIERCODE_BACKEND_CONNECTED instead of being dropped, so the first assistant
  // answer's tool calls aren't silently lost to the session gate.
  const preConnectionBuffer = new Set<Element>();
  const markCurrentResponsesAsHistory = () => {
    document.querySelectorAll(responseContainerSelector()).forEach(el => {
      ignoredPreSessionContainers.add(el);
      preInitContainers.add(el);
      preInitTextLen.set(el, (el.textContent || '').length);
    });
    preInitMarked = true;
  };
  // 若容器是初始化后新出现的回复（不在 preInit 快照里），或是被原地重写的旧容器
  // （重新生成），自动激活会话。返回 true 表示已激活/会话处于活跃。
  const activateIfFreshResponse = (container: Element): boolean => {
    if (isResponseSessionActive()) return true;
    // 快照尚未建立时不能判断"新旧"，保守地不激活（交给 markCurrentResponsesAsHistory）。
    if (!preInitMarked && !isResponseSessionActive()) {
      preConnectionBuffer.add(container);
      return false;
    }
    if (preInitContainers.has(container)) {
      // 原地重新生成检测：文本相对初始快照显著变化（被清空重写）。
      const baseline = preInitTextLen.get(container) ?? 0;
      const nowLen = (container.textContent || '').length;
      if (nowLen >= baseline) return false;
      // 文本变短 = 被清空准备重写 → 视为新回复，且后续不再用旧基线拦截。
      preInitContainers.delete(container);
      preInitTextLen.delete(container);
    }
    activateResponseSession();
    return true;
  };
  window.addEventListener('PIERCODE_PROMPT_SUBMITTED', activateResponseSession);
  window.addEventListener('PIERCODE_BACKEND_CONNECTED', () => {
    // A backend connection can finish after the user already submitted the
    // first prompt. Do not reset that active response session, otherwise the
    // first assistant answer is marked as history and never scanned.
    if (!isResponseSessionActive()) {
      markCurrentResponsesAsHistory();
    }
    // Any response container seen before the backend connected was the genuine
    // first answer (the gate dropped it because the snapshot wasn't ready yet).
    // Activate the session, then replay-scan the buffered containers via the
    // fresh-response path so their tool calls aren't lost. scheduleActiveScan
    // un-ignores each container before scheduling, so containers added to
    // ignoredPreSessionContainers when the gate returned false are recovered.
    if (preConnectionBuffer.size > 0) {
      activateResponseSession();
      for (const el of preConnectionBuffer) scheduleActiveScan(el);
      preConnectionBuffer.clear();
    }
  });
  let autoExecute: boolean | null = null;
  const pendingAutoExecute = new Map<string, { data: any; key: string; container: Element }>();
  // Worker pages run unattended in a background tab — no human is there to click
  // 执行. Force auto-execute on for them regardless of the user's global setting,
  // otherwise the worker's tools never run until the tab is brought to the front.
  let isWorkerPage = !!workerAgentId();
  // Worker pages are driven entirely by server `inject` (never a user-typed
  // prompt), so the response-session gate (`isResponseSessionActive`) might never
  // flip on — which would stop `scanText` from ever running, so the worker's
  // tool calls AND its `piercode-agent-result` callback packet are never
  // detected (= "worker never reports back"). Activate the session immediately
  // for worker pages so scanning is live from the first assistant token.
  const applyWorkerBehavior = () => {
    activateResponseSession();
    autoExecute = true;
    flushPendingAutoExecute();
  };
  if (isWorkerPage) {
    applyWorkerBehavior();
  }
  // The agent id may resolve late (URL query stripped before init; ws-linker
  // recovers it from the background). Re-apply worker behavior when it does.
  window.addEventListener('PIERCODE_WORKER_AGENT_RESOLVED', () => {
    if (isWorkerPage) return;
    isWorkerPage = true;
    applyWorkerBehavior();
  });
  // The user reclaimed this worker tab for their own conversation (ws-linker
  // released the worker identity): forced auto-execute must drop back to the
  // user's own setting, or their chat keeps running tools unattended.
  window.addEventListener('PIERCODE_WORKER_AGENT_RELEASED', () => {
    if (!isWorkerPage) return;
    isWorkerPage = false;
    chrome.storage.local.get(['autoExecute']).then(r => {
      autoExecute = resolveAutoExecute(r.autoExecute);
      flushPendingAutoExecute();
    }).catch(() => {
      autoExecute = false;
      flushPendingAutoExecute();
    });
  });
  chrome.storage.local.get(['autoExecute']).then(r => {
    autoExecute = isWorkerPage ? true : resolveAutoExecute(r.autoExecute);
    flushPendingAutoExecute();
  }).catch(() => {
    autoExecute = isWorkerPage ? true : false;
    // Flush queued tools even on storage failure — autoExecute is already
    // resolved (to false for non-worker), so flushPendingAutoExecute will
    // only fire manual-execute cards, not silently discard them.
    flushPendingAutoExecute();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('autoExecute' in changes && !isWorkerPage) {
      autoExecute = resolveAutoExecute(changes.autoExecute.newValue);
      flushPendingAutoExecute();
    }
  });

  // ── 批量自动执行 ──────────────────────────────────────────────────────────
  let pendingBatch: any[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let submitTimer: ReturnType<typeof setTimeout> | null = null;
  let batchExecuting = false;
  // 输出按响应容器分组，避免不同响应的工具结果混进同一次提交（问题 E）。
  // WeakMap 不可遍历，配活跃容器 Set 供 scheduleFinalSubmit 遍历；提交后移除。
  const outputsByContainer = new WeakMap<Element, string[]>();
  const activeOutputContainers = new Set<Element>();
  const submitDeferByContainer = new WeakMap<Element, number>();
  let lastResponseMutationAt = 0;
  let lastAutoToolSeenAt = 0;
  // 静默窗口：流式输出停止后等待 quietMs 再触发批量执行/提交。
  // 取代旧的固定 batchWaitMs 双等待 —— 既把一次响应里的多个工具调用聚成一批，
  // 又能在慢速响应时自动顺延（每来一个新工具/新变动就重置计时）。
  let quietMs = 400;
  chrome.storage.local.get(['batchQuietMs']).then(r => { quietMs = resolveBatchQuietMs(r.batchQuietMs); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    if ('batchQuietMs' in changes) quietMs = resolveBatchQuietMs(changes.batchQuietMs!.newValue);
  });

  function clearSubmitTimer() {
    if (submitTimer) {
      clearTimeout(submitTimer);
      submitTimer = null;
    }
  }

  // AI 是否还在生成（仅在平台暴露停止控件时可靠）。用于在静默窗口到点后
  // 仍判断流是否真的结束；未结束则顺延，把同一响应的多个工具结果攒成一批提交。
  function isResponseGenerating(): boolean {
    return !!findStopElement(getSiteConfig());
  }

  function scheduleBatchExecution() {
    if (batchExecuting) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = null;
      // 执行不再等响应结束：工具一到就流式逐个执行（quietMs=0 即立即）。
      // 执行期间陆续到达的同一响应的其它工具，靠 batchExecuting 锁 +
      // executeBatch 收尾时重查 pendingBatch（见 executeBatch 末尾）继续并入
      // 同一执行轮；攒到响应结束才在 scheduleFinalSubmit 里一次性提交。
      executeBatch();
    }, quietMs);
  }

  function scheduleToBatch(toolCall: any, key: string, container: Element) {
    clearSubmitTimer();
    lastAutoToolSeenAt = Date.now();
    pendingBatch.push({ data: ensureToolCallId(toolCall, key), key, container });
    // 每来一个新工具就重置静默计时，确保同一响应里的多个工具聚成一批。
    scheduleBatchExecution();
  }

  function responseSettleRemainingMs(): number {
    return autoSubmitSettleRemainingMs(Date.now(), lastResponseMutationAt, lastAutoToolSeenAt);
  }

  // 提交顺延的死锁上限：stopBtn 选择器若误命中常驻元素，isResponseGenerating
  // 会恒 true，导致结果永不提交。设一个上限：自首个待提交结果产生起，最多顺延
  // MAX_SUBMIT_DEFER_MS 就强制提交，确保 stopBtn 误判不会吞掉工具结果。
  const MAX_SUBMIT_DEFER_MS = 15000;

  function scheduleFinalSubmit() {
    if (activeOutputContainers.size === 0) return;
    clearSubmitTimer();
    submitTimer = setTimeout(async () => {
      submitTimer = null;
      if (batchExecuting) return;
      // 还有待执行工具 → 不提交，重新进入批量流程（执行完会再次 scheduleFinalSubmit）。
      if (pendingBatch.length > 0) {
        scheduleBatchExecution();
        return;
      }

      const stillGenerating = isResponseGenerating();
      const settleRemainingMs = responseSettleRemainingMs();

      // 每个响应容器独立累积/提交：B 响应的结果不会混进 A 响应的提交（问题 E）。
      // fillAndSend 是 async 且内部 await focusTab + clickSendWhenReady（Qwen 可达 90s），
      // 同 tick 提交两个容器会抢同一个聊天输入框，故循环内 await 串行提交。
      for (const c of Array.from(activeOutputContainers)) {
        const arr = outputsByContainer.get(c);
        if (!arr || arr.length === 0) { activeOutputContainers.delete(c); continue; }

        // 顺延起点按容器记录：自该容器首个待提交结果产生起最多顺延 MAX_SUBMIT_DEFER_MS，
        // 防 stopBtn 误判导致 isResponseGenerating 恒 true 而永不提交。
        let startedAt = submitDeferByContainer.get(c);
        if (startedAt == null) { startedAt = Date.now(); submitDeferByContainer.set(c, startedAt); }
        const deferredTooLong = Date.now() - startedAt >= MAX_SUBMIT_DEFER_MS;

        // 流仍在生成 → 顺延，等响应结束再一次性提交该容器全部结果。
        if (!deferredTooLong && stillGenerating) continue;
        // settle 窗口未到 → 顺延。
        if (!deferredTooLong && settleRemainingMs > 0) continue;

        const combinedOutput = arr.join('\n\n');
        outputsByContainer.delete(c);
        activeOutputContainers.delete(c);
        submitDeferByContainer.delete(c);
        if (combinedOutput) {
          await fillAndSend(prepareToolOutputForChat(combinedOutput), true);
        }
      }

      // 仍有顺延中的容器 → 重排。settle 未到且非生成中时用剩余 settle 时间重排，
      // 与旧逻辑的嵌套 settle setTimeout 等价。
      if (activeOutputContainers.size > 0) {
        if (settleRemainingMs > 0 && !isResponseGenerating()) {
          submitTimer = setTimeout(() => { submitTimer = null; scheduleFinalSubmit(); }, settleRemainingMs);
        } else {
          scheduleFinalSubmit();
        }
      }
    }, quietMs);
  }

  function prepareToolOutputForChat(output: string): string {
    if (!isCompressionPlatform()) return output;
    const compacted = compactToolOutputForChat(output);
    if (compacted.compacted) {
      showToast('工具结果过长，已压缩后回填', 5000);
    }
    return compacted.text;
  }

  async function executeBatch() {
    if (batchExecuting) return;
    batchTimer = null;
    batchExecuting = true;

    // 显示批量执行指示器
    visualIndicator.showPulsingBorder();
    visualIndicator.showStatusBadge('loading');
    statusPanel.setOpState('executing');

    try {
      while (pendingBatch.length > 0) {
        const batch = pendingBatch;
        pendingBatch = [];

        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const { data: toolCall, key } = item;
          if (isExecuted(key)) continue;

          // 更新卡片状态为"执行中..."
          const cardEl = document.querySelector(`[data-piercode-key="${CSS.escape(key)}"]`);
          const btnEl = cardEl?.querySelector('button') as HTMLButtonElement | null;
          if (btnEl) { btnEl.disabled = true; btnEl.textContent = '执行中...'; }

          // Carry the server's prompt guidance on at most one tool per turn: the
          // last tool of this drain when nothing else is queued. Other tools opt
          // out so the AI sees the operating reminder once, not once per tool.
          const withGuidance = i === batch.length - 1 && pendingBatch.length === 0;
          const { output, stopStream, sendable, alreadyInjected } = await executeToolCallReturn(toolCall, withGuidance);
          if (sendable) {
            markExecuted(key);
          }
          // alreadyInjected tools (spawn_agent's API route) filled + submitted
          // their own result via injectToolResult; don't re-queue it here.
          if (sendable && !alreadyInjected && output.trim()) {
            const callId = getToolCallId(toolCall);
            const c = item.container;
            let arr = outputsByContainer.get(c);
            if (!arr) { arr = []; outputsByContainer.set(c, arr); }
            arr.push(`### ${toolCall.name} #${callId}\n${output}`);
            activeOutputContainers.add(c);
          }

          // 更新卡片状态为"已执行"
          if (btnEl) btnEl.textContent = sendable ? '✅ 已执行' : '请刷新页面';

          if (stopStream) {
            clickStopButton();
            showToast('✅ 文件已写入成功，已停止生成');
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }
    } finally {
      batchExecuting = false;
      // 隐藏批量执行指示器
      visualIndicator.showStatusBadge('completed');
      statusPanel.setOpState('done');
      setTimeout(() => visualIndicator.hideAllIndicators(), 1500);
    }

    if (pendingBatch.length > 0) {
      scheduleBatchExecution();
      return;
    }
    scheduleFinalSubmit();
  }

  function maybeScheduleAutoExecute(toolCall: any, key: string, container: Element) {
    if (isExecuted(key)) return;
    // Listen mode: the SW listen channel owns tool execution + send-back. The DOM
    // observer renders the card but must not also run the tool (single source).
    if (isListenModeActive()) return;
    // A worker the coordinator stopped (stop_agent → agent_control "stop") must
    // not keep auto-running tools. The card still renders for inspection; the
    // unattended tool loop halts here, so the model starves of results and the
    // run ends with the current turn. send_to_agent's "resume" re-arms it.
    if (isWorkerPage && isWorkerStopped()) return;
    if (autoExecute === true) {
      scheduleToBatch(toolCall, key, container);
    } else if (autoExecute === null) {
      pendingAutoExecute.set(key, { data: toolCall, key, container });
    }
  }

  function flushPendingAutoExecute() {
    if (autoExecute !== true) {
      if (autoExecute === false) pendingAutoExecute.clear();
      return;
    }
    const pending = [...pendingAutoExecute.values()];
    pendingAutoExecute.clear();
    for (const item of pending) {
      if (!isExecuted(item.key)) scheduleToBatch(item.data, item.key, item.container);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const qwenOverflowNotified = new Set<string>();
  const aiLogTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const aiLastLoggedText = new WeakMap<Element, string>();
  const aiLogKeys = new WeakMap<Element, string>();
  const aiLastSentAt = new WeakMap<Element, number>();
  let loadingLastSentAt = 0;

  function notifyQwenOverflowOnce(codeText: string): void {
    const key = String(hashStr(codeText.slice(0, 500)));
    if (qwenOverflowNotified.has(key)) return;
    qwenOverflowNotified.add(key);
    showToast('Qwen 工具代码块被 Show more 省略，正在等待完整内容', 5000);
  }

  async function scanText(text: string, sourceEl?: Element) {
    if (!isResponseSessionActive()) return;
    const lower = text.toLowerCase();

    // Worker result-packet detection runs FIRST, before any platform-specific DOM
    // path that early-returns (Qwen `parsedQwenTool` return, Chat Z unconditional
    // return). Otherwise a worker on those platforms would emit its
    // piercode-agent-result packet but the scan would bail before reaching the
    // forwarder, so the coordinator never gets the callback. Idempotent via the
    // packet-hash dedup inside maybeForwardAgentResult.
    maybeForwardAgentResult(text, processed);

    // ── Phase 0: 直接从 DOM 提取 tool 代码块（Qwen Monaco Editor 专用） ──
    if (sourceEl && platformAdapter.name === 'qwen') {
      let parsedQwenTool = false;
      // 流式中遇到未平衡 JSON 时置位：本次 scan 不再 fallthrough 到 Phase 1。
      // 两路径现在都对解析后的 {name,args} 取 toolDedupHash，无 callId 时 fallback
      // key 一致，processed 去重兜得住；置位仍保留以省一次重复解析，并让 settle
      // retry 600ms 后全量重扫接管未流完的块。
      let pendingQwenTool = false;
      const toolPres = sourceEl.querySelectorAll(DOM_EXTRACT.qwenToolBlock);
      for (const pre of toolPres) {
        const block = findQwenPierCodeBody(pre);
        if (!block) continue;
        const blockBody = block.body;

        let extraction = extractMonacoText(blockBody);
        let codeText = extraction.text;

        if (extraction.hasOverflow) {
          const modelText = await requestMonacoModelText(blockBody, codeText);
          if (modelText) {
            codeText = modelText;
            extraction = { text: modelText, hasOverflow: false };
          } else {
            const clicked = clickQwenOverflowPlaceholders(blockBody);
            if (clicked) {
              setTimeout(() => scheduleScan(sourceEl), TIMING.MONACO_OVERFLOW_RESCAN_MS);
            }
            notifyQwenOverflowOnce(codeText);
            continue;
          }
        }

        // 子 agent 回传包：worker 完成时输出一行 piercode-agent-result JSON。它和
        // 工具块一样被 Monaco 渲染/虚拟化，所以必须走上面这套溢出恢复后再解析，
        // 否则截断的 JSON 永远匹配不上，coordinator 收不到回调。完整才转发，残缺
        // （流式中途/溢出未恢复）安排兜底重扫。
        if (block.kind === 'agent-result') {
          if (forwardAgentResultJSON(codeText, codeText, processed)) {
            parsedQwenTool = true;
          } else if (sourceEl) {
            scheduleSettleRetry(sourceEl);
          }
          continue;
        }

        // 流式渲染中：内容可能不完整，跳过本次解析。安排一次兜底重扫，
        // 防止工具块是响应最后一段、后续无变动时永久漏掉。
        if (!isBalancedJson(codeText)) {
          pendingQwenTool = true;
          if (sourceEl) scheduleSettleRetry(sourceEl);
          continue;
        }
        const data = parseJsonFenceToolCall(codeText) || tryParseToolJSON(codeText);
        if (!data) {
          if (extraction.hasOverflow) {
            notifyQwenOverflowOnce(codeText);
            continue;
          }
          console.warn('[PierCode] Qwen DOM提取解析失败:', codeText);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const callId = getToolCallId(data);
        // The no-call_id fallback hash must still be conversation-scoped:
        // identical command text (e.g. the same `go test ./...` fence) in two
        // conversations would otherwise share one dedup key, and a repeat in
        // conversation B got silently skipped because A had run it within TTL.
        // Hash the parsed semantics, NOT codeText — Monaco virtualizes finished
        // blocks, so codeText drifts across a refresh and re-ran every tool.
        const key = callId ? `${convId}:${data.name}:${callId}` : `${convId}:${toolDedupHash(data)}`;
        if (processed.has(key)) continue;
        console.log('[PierCode] 提取到工具调用(Qwen DOM):', data);

        if (sourceEl) {
          processed.add(key);
          parsedQwenTool = true;
          renderToolCard(data, codeText, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key, sourceEl ?? document.body);
        }
      }
      // 更新 Qwen 上下文追踪 (assistant 响应)
      if (platformAdapter.name === 'qwen' && sourceEl) {
        updateQwenContext('assistant', text, aiResponseLogKey(sourceEl), sourceEl);
      }
      scheduleAIResponseLog(sourceEl, text);
      // Qwen DOM 专用路径解析到工具、或检测到仍在流式的工具块（settle retry
      // 已排程）时结束；否则继续走通用 fence/XML 兜底，避免新版 DOM 结构让
      // 工具块静默漏掉。
      if (parsedQwenTool || pendingQwenTool) return;
    }

    // ── Phase 0b: 直接从 DOM 提取 tool 代码块（Chat Z CodeMirror6 专用） ──
    if (sourceEl && platformAdapter.name === 'chatz') {
      const toolContainers = sourceEl.querySelectorAll(DOM_EXTRACT.chatzToolContainer);
      for (const container of toolContainers) {
        // 从 CodeMirror6 提取文本
        const cmContent = container.querySelector(DOM_EXTRACT.codeMirrorContent);
        if (!cmContent) continue;

        const lines: string[] = [];
        for (const line of cmContent.querySelectorAll('.cm-line')) {
          lines.push(line.textContent || '');
        }
        const codeText = lines.join('\n').replace(/\u00A0/g, ' ').trim();

        // 流式渲染中：内容可能不完整，跳过本次解析并安排兜底重扫。
        if (!isBalancedJson(codeText)) {
          if (sourceEl) scheduleSettleRetry(sourceEl);
          continue;
        }
        const data = parseJsonFenceToolCall(codeText) || tryParseToolJSON(codeText);
        if (!data) {
          console.warn('[PierCode] Chat Z DOM提取解析失败:', codeText);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const callId = getToolCallId(data);
        // The no-call_id fallback hash must still be conversation-scoped:
        // identical command text (e.g. the same `go test ./...` fence) in two
        // conversations would otherwise share one dedup key, and a repeat in
        // conversation B got silently skipped because A had run it within TTL.
        // Hash the parsed semantics, NOT codeText — DOM-rendered code drifts
        // across a refresh and re-ran every tool.
        const key = callId ? `${convId}:${data.name}:${callId}` : `${convId}:${toolDedupHash(data)}`;
        if (processed.has(key)) continue;
        console.log('[PierCode] 提取到工具调用(Chat Z DOM):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, codeText, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key, sourceEl ?? document.body);
        }
      }
      scheduleAIResponseLog(sourceEl, text);
      // Chat Z 已通过 DOM 直接提取，不再走文本解析
      return;
    }

    // ── Phase 1: JSON 围栏格式（优先） ──
    if (lower.includes('```piercode-tool') || lower.includes('```tool')) {
      FENCE_RE.lastIndex = 0;
      let fenceMatch;
      while ((fenceMatch = FENCE_RE.exec(text)) !== null) {
        const jsonStr = fenceMatch[1];
        // 清理 fence 内容：去除不可见字符和非断空格，去除首尾空白
        const cleanedJsonStr = jsonStr.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
        // 流式渲染中：内容可能不完整，跳过本次解析并安排兜底重扫。
        if (!isBalancedJson(cleanedJsonStr)) {
          if (sourceEl) scheduleSettleRetry(sourceEl);
          continue;
        }
        const data = parseJsonFenceToolCall(cleanedJsonStr) || tryParseToolJSON(cleanedJsonStr);
        if (!data) {
          console.warn('[PierCode] JSON 围栏解析失败:', cleanedJsonStr);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const callId = getToolCallId(data);
        // Conversation-scoped fallback hash — see the Qwen DOM path above.
        const key = callId ? `${convId}:${data.name}:${callId}` : `${convId}:${toolDedupHash(data)}`;
        if (processed.has(key)) continue;
        console.log('[PierCode] 提取到工具调用(JSON):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, fenceMatch[0], sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key, sourceEl ?? document.body);
        } else {
          if (isExecuted(key)) continue;
          processed.add(key);
          scheduleToBatch(data, key, document.body);
        }
      }
    }

    // ── Phase 2: XML 格式（兼容回退） ──
    if (lower.includes('<tool')) {
      TOOL_RE.lastIndex = 0;
      let match;
      while ((match = TOOL_RE.exec(text)) !== null) {
        const full = match[0];
        const inner = full.replace(/^<tool[^>]*>|<\/(?:tool|function)(?:_call)?>$/g, '').trim();
        const data = parseXmlToolCall(full, decodeHTMLEntities) || tryParseToolJSON(inner);
        if (!data) {
          console.warn('[PierCode] 工具调用解析失败:', full);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const callId = getToolCallId(data);
        // Conversation-scoped fallback hash — see the Qwen DOM path above.
        const key = callId ? `${convId}:${data.name}:${callId}` : `${convId}:${toolDedupHash(data)}`;
        if (processed.has(key)) continue;
        console.log('[PierCode] 提取到工具调用(XML):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, full, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key, sourceEl ?? document.body);
        } else {
          if (isExecuted(key)) continue;
          processed.add(key);
          scheduleToBatch(data, key, document.body);
        }
      }
    }

    // (Worker result-packet detection already ran at the top of scanText, before
    // the platform-specific early-returns.)

    scheduleAIResponseLog(sourceEl, text);
  }

  function scheduleAIResponseLog(sourceEl: Element | undefined, text: string): void {
    if (!sourceEl) return;
    const clean = cleanAIResponseLogText(text);
    if (!clean) return;
    if (aiLastLoggedText.get(sourceEl) === clean) return;

    const oldTimer = aiLogTimers.get(sourceEl);
    if (oldTimer) clearTimeout(oldTimer);
    const elapsed = Date.now() - (aiLastSentAt.get(sourceEl) || 0);
    const delay = Math.max(0, 350 - elapsed);
    const send = () => {
      if (aiLastLoggedText.get(sourceEl) === clean) return;
      aiLastLoggedText.set(sourceEl, clean);
      aiLastSentAt.set(sourceEl, Date.now());
      const logKey = aiResponseLogKey(sourceEl);
      sendAIResponseLog(logKey, clean);
      // 非 Qwen 压缩平台（如 ChatGPT）的 assistant 上下文在这里捕获 —— Qwen 走
      // 专用 DOM 路径捕获原始文本，避免重复计入。updateQwenContext 内部按
      // sourceKey 去重，会随流式增量原地更新同一条消息。
      if (isCompressionPlatform() && platformAdapter.name !== 'qwen') {
        updateQwenContext('assistant', clean, logKey, sourceEl);
      }
    };
    if (delay === 0) {
      send();
    } else {
      aiLogTimers.set(sourceEl, setTimeout(() => {
        // Skip logging for containers removed while the debounce was pending.
        if (sourceEl.isConnected) send();
      }, delay));
    }
  }

  // maybeForwardAgentResult detects a worker's piercode-agent-result packet in
  // its own AI output and forwards it to the server, which routes it back to the
  // dispatcher as a <task-notification>. No-op on non-worker pages.
  function maybeForwardAgentResult(text: string, processed: Set<string>): void {
    if (!workerAgentId()) return;
    if (!text.toLowerCase().includes('```piercode-agent-result')) return;
    AGENT_RESULT_FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AGENT_RESULT_FENCE_RE.exec(text)) !== null) {
      // Generic fence fallback for non-Monaco platforms (Claude/ChatGPT/plain
      // markdown) where the captured body keeps real newlines. Qwen Monaco blocks
      // are handled in Phase 0 with overflow recovery; see scanText.
      forwardAgentResultJSON(match[1], match[0], processed);
    }
  }

  // forwardAgentResultJSON parses one piercode-agent-result body and forwards it
  // to the server exactly once. Returns true when a complete packet was sent (or
  // already de-duped); false when the body is incomplete/malformed so the caller
  // can schedule a settle-retry. The dedup key is derived from the PARSED packet
  // content (id+status+summary+result), NOT the raw source string: the generic
  // fence path passes `match[0]` (with backticks) while the Qwen Monaco path
  // passes the recovered body (no fence), so hashing the source produced two
  // different keys for the same packet → the coordinator got the same callback
  // twice. Hashing the parsed content makes both paths collapse to one key.
  function forwardAgentResultJSON(jsonStr: string, _dedupSource: string, processed: Set<string>): boolean {
    const agentId = workerAgentId();
    if (!agentId) return false;
    const packet = parseAgentResultPacket(jsonStr);
    if (!packet) return false; // incomplete (streaming / Monaco overflow) or malformed
    const reportedId = packet.agentId || agentId;
    // Dedup by agent id + a hash of the parsed packet body, persisted to
    // sessionStorage. The in-memory `processed` set only lives for one scan pass,
    // so a DOM re-scan or a page reload would otherwise re-forward (re-run) a
    // packet already sent; the sessionStorage key survives both within the tab
    // session. Keying off the parsed content (not the raw fence/body source) also
    // de-dupes the generic-fence and Qwen-Monaco paths against each other.
    const contentKey = `${reportedId}${packet.status}${packet.summary}${packet.result}`;
    const key = `agent-result:${reportedId}:${hashStr(contentKey)}`;
    if (processed.has(key) || agentResultAlreadySent(key)) return true;
    processed.add(key);
    markAgentResultSent(key);
    // Trust the worker's echoed agent_id when present; otherwise fall back to
    // this tab's own id so the server can still route the result.
    console.log('[PierCode] worker 回传 result packet:', reportedId, packet.status);
    sendAgentResult(reportedId, packet.status, packet.summary, packet.result);
    return true;
  }

  // sessionStorage-backed dedup for forwarded result packets. Survives DOM
  // re-scans / reload within the tab session; falls back to in-memory-only on any
  // storage failure (sandboxed frame) — the `processed` set still covers the pass.
  const AGENT_RESULT_SENT_KEY = 'piercode_agent_result_sent';
  function loadAgentResultSent(): Set<string> {
    try {
      const raw = window.sessionStorage.getItem(AGENT_RESULT_SENT_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* unavailable */ }
    return new Set();
  }
  function agentResultAlreadySent(key: string): boolean {
    return loadAgentResultSent().has(key);
  }
  function markAgentResultSent(key: string): void {
    try {
      const set = loadAgentResultSent();
      set.add(key);
      window.sessionStorage.setItem(AGENT_RESULT_SENT_KEY, JSON.stringify(Array.from(set)));
    } catch { /* unavailable; in-memory `processed` still dedups this pass */ }
  }

  function aiResponseLogKey(sourceEl: Element): string {
    let key = aiLogKeys.get(sourceEl);
    if (!key) {
      key = `ai:${getConversationId()}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      aiLogKeys.set(sourceEl, key);
    }
    return key;
  }

  function cleanAIResponseLogText(text: string): string {
    const clean = text
      .replace(/```(?:piercode-tool|tool)\s*\n([\s\S]*?)\n```/gi, (_full, body) => `\n${summarizeToolCallForLog(body)}\n`)
      .replace(/<tool[\s\S]*?<\/(?:tool|function)(?:_call)?>/gi, (full) => `\n${summarizeToolCallForLog(full)}\n`)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!clean) return '';
    if (tryParseToolJSON(clean)) return summarizeToolCallForLog(clean);
    return clean;
  }

  function summarizeToolCallForLog(raw: string): string {
    const parsed = parseJsonFenceToolCall(raw) ||
      parseXmlToolCall(raw, decodeHTMLEntities) ||
      tryParseToolJSON(raw);
    const name = typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'tool';
    const callId = typeof parsed?.callId === 'string' && parsed.callId.trim()
      ? parsed.callId.trim()
      : (typeof parsed?.call_id === 'string' ? parsed.call_id.trim() : '');
    return callId ? `调用工具 ${name} #${callId} …` : `调用工具 ${name} …`;
  }

  function scheduleActiveScan(container: Element): void {
    ignoredPreSessionContainers.delete(container);
    lastResponseMutationAt = Date.now();
    scheduleScan(container);
  }

  function scanNode(node: Node) {
    let el: Element | null;
    if (node.nodeType === Node.TEXT_NODE) {
      el = (node as Text).parentElement;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      el = node as Element;
    } else {
      return;
    }
    if (!el) return;
    notifyResponseLoading(el);
    const mc = findResponseContainer(el);
    if (mc) {
      if (activateIfFreshResponse(mc)) {
        scheduleActiveScan(mc);
      } else {
        ignoredPreSessionContainers.add(mc);
      }
    }
    if (el.nodeType === Node.ELEMENT_NODE) {
      el.querySelectorAll?.(responseContainerSelector()).forEach(container => {
        if (activateIfFreshResponse(container)) {
          scheduleActiveScan(container);
        } else {
          ignoredPreSessionContainers.add(container);
        }
      });
    }
  }

  function notifyResponseLoading(el: Element): void {
    const loading = el.matches?.('.response-loading') ? el : el.querySelector?.('.response-loading');
    if (!loading) return;
    const now = Date.now();
    if (now - loadingLastSentAt < 1200) return;
    loadingLastSentAt = now;
    sendAIResponseLog(`ai:${getConversationId()}:loading`, '思考中...');
    statusPanel.setOpState('thinking');
  }

  function responseContainerSelector(): string {
    return [
      platformAdapter.responseSelector,
      'message-content',
      'ms-chat-turn',
      '.model-response-text',
      '.qwen-chat-message-assistant',
      '.response-message-content.phase-answer',
      '#response-content-container',
      '.segment-assistant',
      '.font-claude-response',
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]'
    ].filter(Boolean).join(',');
  }

  function findResponseContainer(el: Element | null): Element | null {
    while (el) {
      const tag = el.tagName.toLowerCase();
      if (platformAdapter.responseSelector && el.matches?.(platformAdapter.responseSelector)) return el;
      if (tag === 'message-content') return el;
      if (tag === 'ms-chat-turn') return el;
      if (el.matches?.('.qwen-chat-message-assistant')) return el;
      if (el.matches?.('.response-message-content.phase-answer')) return el;
      if (el.matches?.('#response-content-container')) return el;
      if (el.matches?.('.segment-assistant')) return el;
      if (el.matches?.('.font-claude-response')) return el;
      if (el.matches?.('[data-message-author-role="assistant"] .markdown')) return el;
      if (el.matches?.('[data-message-author-role="assistant"]')) return el;
      if (el.id === 'response-content-container') return el;
      el = el.parentElement;
    }
    return null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingContainers = new Set<Element>();

  // 兜底重扫：当一次扫描里检测到工具块但内容尚未流完（未以 } 收尾）而被静默
  // 跳过时，主动安排一次重扫，避免"工具块是响应最后一段、后续无 DOM 变动 →
  // 永远不再触发扫描 → 工具静默漏掉"的情况。每个容器只保留一个待重扫计时。
  const settleRetryTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  function scheduleSettleRetry(container: Element): void {
    if (settleRetryTimers.has(container)) return;
    const t = setTimeout(() => {
      settleRetryTimers.delete(container);
      // Container removed from DOM (regenerate / delete) before the retry
      // fired: scanning the detached subtree could auto-execute a tool from a
      // response the user already regenerated away.
      if (!container.isConnected) return;
      if (!isResponseSessionActive()) return;
      if (ignoredPreSessionContainers.has(container)) return;
      scanText(getCleanText(container), container);
    }, 600);
    settleRetryTimers.set(container, t);
  }

  // 块级标签：遍历到这些元素时在前面插入换行
  const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // 跳过这些元素及其子树（UI 噪声）
  const SKIP_TAGS = new Set(['MS-THOUGHT-CHUNK', 'MAT-ICON', 'SCRIPT', 'STYLE', 'BUTTON', 'MAT-EXPANSION-PANEL-HEADER', 'SVG']);

  function extractText(node: Node, buf: string[]): void {
    if (node.nodeType === Node.TEXT_NODE) {
      buf.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;

    // 跳过 aria-hidden 元素（Material Icons 图标文字）和噪声标签
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (SKIP_TAGS.has(el.tagName)) return;

    // 如果 <tool> 被渲染为 HTML 元素，将其序列化回文本以便正则匹配
    if (el.tagName.toLowerCase() === 'tool') {
      buf.push(el.outerHTML);
      return;
    }

    // 使用平台适配器处理特定平台的代码块渲染
    if (platformAdapter.extractText(el, buf)) {
      return;
    }

    // 块级元素前插换行，保证多行结构
    if (BLOCK_TAGS.has(el.tagName)) buf.push('\n');

    for (const child of el.childNodes) {
      extractText(child, buf);
    }
  }

  function getCleanText(el: Element): string {
    const buf: string[] = [];
    extractText(el, buf);
    return buf.join('');
  }

  function scheduleScan(container: Element) {
    if (ignoredPreSessionContainers.has(container)) return;
    pendingContainers.add(container);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        const els = [...pendingContainers];
        pendingContainers.clear();
        requestAnimationFrame(() => {
          for (const el of els) scanText(getCleanText(el), el);
        });
      }, 700);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
      const els = [...pendingContainers];
      pendingContainers.clear();
      requestAnimationFrame(() => {
        for (const el of els) scanText(getCleanText(el), el);
      });
    }, 250);
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const container = findResponseContainer((mutation.target as Text).parentElement);
        if (container) {
          if (activateIfFreshResponse(container)) {
            scheduleActiveScan(container);
          } else {
            ignoredPreSessionContainers.add(container);
          }
        }
      } else {
        mutation.addedNodes.forEach(scanNode);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // Mark already-rendered history as out-of-scope. The TUI should only mirror
  // prompts and answers that happen after this content script session starts.
  requestAnimationFrame(() => {
    markCurrentResponsesAsHistory();
  });
}

function injectInitButton() {
  const btn = document.createElement('button');
  btn.textContent = '⌁ 初始化';
  btn.style.cssText = `position:fixed;bottom:80px;right:20px;z-index:99999;padding:8px 14px;background:${T_PANEL};color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 2px 8px rgba(0,0,0,0.4);font-family:${T_FONT}`;
  btn.onclick = sendInitPrompt;
  document.body.appendChild(btn);
}

async function bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }> {
  if (!checkContext()) return { ok: false, status: 0, body: 'Extension context invalidated, please refresh the page' };
  const result = await chrome.runtime.sendMessage({ type: 'FETCH', url, options });
  // MV3 service worker may be asleep; sendMessage returns undefined in that case.
  return result ?? { ok: false, status: 0, body: 'Service worker unavailable' };
}

function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

function apiEndpointForProfile(apiUrl: string, path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${apiEndpoint(apiUrl, path)}${sep}adapter=${encodeURIComponent(platformProfile)}`;
}

function withPlatformProfile(toolCall: any, withGuidance = true): any {
  const request: any = { ...toolCall, profile: platformProfile, client_id: getPierCodeClientId(), conversation_url: observeConversationURL() };
  // Server appends prompt guidance to the response of every guidance-enabled
  // call. In an auto-executed batch we only want it on ONE tool of the turn, so
  // the AI sees the reminder once, not once per tool. Mark the others false;
  // omit the field when enabled so older servers default to the prior behavior.
  // 总开关关闭时所有调用一律不带 guidance（覆盖批量"最后一个带"的逻辑）。
  if (!withGuidance || !isSystemReminderEnabled()) request.with_guidance = false;
  return request;
}

async function fetchInitPromptForCurrentProfile(): Promise<string> {
  if (!checkContext()) return '';
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return '';
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const resp = await bgFetch(apiEndpointForProfile(apiUrl, '/prompt'), { headers });
  if (!resp.ok) {
    console.warn('[PierCode] 获取初始化提示词失败，新会话仅发送压缩上下文:', resp.status, resp.body);
    return '';
  }
  return resp.body;
}

async function sendInitPrompt() {
  const prompt = await fetchInitPromptForCurrentProfile();
  if (!prompt) { alert('获取初始化提示词失败'); return; }

  if (location.hostname.includes('aistudio.google.com')) {
    await fillAiStudioSystemInstructions(prompt);
    return;
  }

  fillAndSend(prompt, true);
}

async function fillAiStudioSystemInstructions(prompt: string) {
  const openBtn = document.querySelector<HTMLElement>('button[data-test-system-instructions-card]');
  if (!openBtn) { fillAndSend(prompt, true); return; }

  openBtn.click();
  await new Promise(r => setTimeout(r, 600));

  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="System instructions"]');
  if (!textarea) { fillAndSend(prompt, true); return; }

  const nativeSetter = getNativeSetter();
  if (nativeSetter) nativeSetter.call(textarea, prompt);
  else textarea.value = prompt;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  await new Promise(r => setTimeout(r, 300));

  const closeBtn = document.querySelector<HTMLElement>('button[data-test-close-button]');
  if (closeBtn) closeBtn.click();
}

function showQuestionPopup(question: string, options: string[]): Promise<string> {
  return new Promise(resolve => {
    const panel = showInlineQuestionPanel({
      question,
      options,
      onSubmit: answer => resolve(answer),
      onCancel: () => resolve(''),
    });
    panel.style.zIndex = '2147483647';
  });
}

// 压缩进度持久卡：替代一闪而过的 toast，常驻右下角分阶段显示压缩状态，
// 让用户能看到"请求模型中→重试中→本地兜底中→完成/失败"整条链路。
type CompressionPhase = 'requesting' | 'retrying' | 'local_fallback' | 'opening' | 'done' | 'failed' | 'cancelled' | 'manual';
const COMPRESSION_PHASE_META: Record<CompressionPhase, { icon: string; color: string; label: string }> = {
  requesting:     { icon: '⏳', color: T_AMBER, label: '正在请求模型压缩上下文…' },
  retrying:       { icon: '🔁', color: T_AMBER, label: '模型未按时输出，正在加强约束重试…' },
  local_fallback: { icon: '🧩', color: T_AMBER, label: '模型两次未输出，正在本地摘要兜底…' },
  opening:        { icon: '🚀', color: T_GLOW,  label: '正在打开新会话并注入压缩上下文…' },
  done:           { icon: '✅', color: T_GLOW,  label: '上下文已压缩并迁移到新会话' },
  failed:         { icon: '❌', color: T_RED,   label: '上下文压缩失败' },
  cancelled:      { icon: '🛑', color: T_DIM,   label: '已取消上下文压缩' },
  manual:         { icon: '📋', color: T_GLOW,  label: '上下文已压缩（手动模式）' },
};

const compressionStatusCard = (() => {
  let el: HTMLDivElement | null = null;
  let iconEl: HTMLSpanElement | null = null;
  let textEl: HTMLSpanElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function ensure(): HTMLDivElement | null {
    if (!document.body) return null;
    if (el) return el;
    el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:210px;right:20px;z-index:2147483647;display:flex;align-items:center;gap:8px;max-width:340px;background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-left:3px solid ${T_GLOW};border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.4;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT}`;
    iconEl = document.createElement('span');
    iconEl.style.cssText = 'font-size:15px;flex-shrink:0';
    textEl = document.createElement('span');
    textEl.style.cssText = 'flex:1';
    cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = `flex-shrink:0;padding:3px 10px;background:transparent;color:${T_RED};border:1px solid ${T_RED};border-radius:6px;cursor:pointer;font-size:12px;display:none;font-family:${T_FONT}`;
    el.append(iconEl, textEl, cancelBtn);
    document.body.appendChild(el);
    return el;
  }

  // set 渲染压缩状态。中间态可传 onCancel 显示「取消」按钮（手动取消模型压缩）。
  function set(phase: CompressionPhase, detail?: string, opts?: { onCancel?: () => void }): void {
    const node = ensure();
    if (!node || !iconEl || !textEl || !cancelBtn) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const meta = COMPRESSION_PHASE_META[phase];
    iconEl.textContent = meta.icon;
    node.style.borderLeftColor = meta.color;
    textEl.textContent = detail ? `${meta.label}（${detail}）` : meta.label;
    if (opts?.onCancel) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.onclick = () => { cancelBtn!.style.display = 'none'; opts.onCancel!(); };
    } else {
      cancelBtn.style.display = 'none';
      cancelBtn.onclick = null;
    }
    // 终态自动消失；中间态常驻。
    if (phase === 'done' || phase === 'failed' || phase === 'cancelled' || phase === 'manual') {
      hideTimer = setTimeout(() => clear(), phase === 'manual' ? 12000 : 6000);
    }
  }

  function clear(): void {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (el) { el.remove(); el = null; iconEl = null; textEl = null; cancelBtn = null; }
  }

  return { set, clear };
})();

// 压缩确认卡（confirm 触发模式）：到阈值时弹出，让用户选「压缩」或「跳过」。
// 与 compressionStatusCard 错开位置，避免重叠。
const compressionConfirmCard = (() => {
  let el: HTMLDivElement | null = null;

  function dismiss(): void {
    if (el) { el.remove(); el = null; }
  }

  function show(used: number, threshold: number, opts: { onCompress: () => void; onSkip: () => void }): void {
    if (!document.body) return;
    dismiss();
    el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:260px;right:20px;z-index:2147483647;max-width:340px;background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-left:3px solid ${T_GLOW};border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT}`;
    const msg = document.createElement('div');
    msg.style.cssText = 'margin-bottom:10px';
    msg.textContent = `上下文已达阈值（${formatTokenCount(used)} / ${formatTokenCount(threshold)} tokens）。是否压缩并迁移到新会话？`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = '跳过，继续执行';
    skipBtn.style.cssText = `padding:5px 12px;background:transparent;color:${T_DIM};border:1px solid ${T_LINE};border-radius:6px;cursor:pointer;font-size:12px;font-family:${T_FONT}`;
    skipBtn.onclick = () => { dismiss(); opts.onSkip(); };
    const compressBtn = document.createElement('button');
    compressBtn.textContent = '压缩';
    compressBtn.style.cssText = `padding:5px 16px;background:transparent;color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:${T_FONT};box-shadow:0 0 0 1px ${T_GLOW_SOFT}`;
    compressBtn.onclick = () => { dismiss(); opts.onCompress(); };
    row.append(skipBtn, compressBtn);
    el.append(msg, row);
    document.body.appendChild(el);
  }

  return { show, dismiss };
})();

function showToast(msg: string, durationMs = 3000): void {
  if (!document.body) return;
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:170px;right:20px;z-index:2147483647;background:${T_PANEL};color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

function clickStopButton(): void {
  const btn = findStopElement(getSiteConfig());
  if (btn) btn.click();
}


function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const sel of selectors.split(',').map(s => s.trim())) {
    if (!sel) continue;
    // Guard against selectors the engine can't parse (e.g. :has() on old
    // Chromium). A throw here would otherwise crash callers like
    // isResponseGenerating(); skip the bad selector and try the next one.
    let el: HTMLElement | null;
    try {
      el = document.querySelector(sel) as HTMLElement | null;
    } catch {
      continue;
    }
    if (el && isVisibleElement(el)) return el;
  }
  return null;
}

function findEditorFromTarget(target: HTMLElement | null): HTMLElement | null {
  if (!target) return null;
  for (const sel of getSiteConfig().editor.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      if (target.matches(sel)) return target;
      const closest = target.closest(sel) as HTMLElement | null;
      if (closest) return closest;
    } catch {
      // Ignore unsupported site selectors and continue with the next one.
    }
  }
  return null;
}

function isVisibleElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    el.getAttribute('aria-hidden') !== 'true';
}

function isQwenPage(): boolean {
  const h = location.hostname.toLowerCase();
  return h.includes('qwen.ai') || h.includes('qwenlm.ai');
}

async function focusCurrentTabForSend(): Promise<void> {
  // Worker pages live in a background tab. Filling a contenteditable via
  // execCommand('insertText') requires the document to be focused, so a worker
  // must activate its own tab before submitting a tool result / report. Qwen
  // also needs activation for its send flow. Other foreground pages don't.
  if (!isQwenPage() && !workerAgentId()) return;
  try {
    await chrome.runtime.sendMessage({ type: 'FOCUS_SELF', forceFocus: true });
    await new Promise(resolve => setTimeout(resolve, 150));
  } catch (error) {
    console.warn('[PierCode] 激活标签页失败，继续尝试发送:', error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSendBlockedByRunningResponse(siteConfig: SiteConfig): boolean {
  return !!findStopElement(siteConfig);
}

// 用户消息系统提示追加逻辑在 ./user-send-reminder（DI 解耦）；这里组装依赖。
function installUserSendReminderWithDeps(): void {
  installUserSendReminder({
    getSiteConfig: () => getSiteConfig(),
    querySelectorFirst,
    findEditorFromTarget,
    getEditorText,
    effectiveFillMethod,
    getNativeSetter,
    workerAgentId,
    checkContext: () => checkContext(),
    fetchReminderText: async () => {
      const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
      if (!apiUrl) return '';
      const headers: any = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      const resp = await bgFetch(apiEndpointForProfile(apiUrl, '/guidance'), { headers });
      if (!resp.ok) return '';
      const data = JSON.parse(resp.body);
      return typeof data.operating_reminder === 'string' ? data.operating_reminder : '';
    },
  });
}

async function clickSendWhenReady(siteConfig: SiteConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isSendBlockedByRunningResponse(siteConfig)) {
      const sendBtn = querySelectorFirst(siteConfig.sendBtn);
      if (sendBtn) {
        markProgrammaticSend();
        sendBtn.click();
        return true;
      }
    }
    await sleep(250);
  }

  if (!isQwenPage() || !isSendBlockedByRunningResponse(siteConfig)) {
    const ed = querySelectorFirst(siteConfig.editor);
    if (ed) {
      markProgrammaticSend();
      return dispatchEnterAsSendFallback(ed);
    }
  }
  return false;
}

async function fillAndSend(result: string, autoSend = false, options: { forceSend?: boolean; immediate?: boolean } = {}): Promise<boolean> {
  const siteConfig = getSiteConfig();
  const { editor: editorSel, fillMethod } = siteConfig;
  if (autoSend) {
    await focusCurrentTabForSend();
  }
  const editor = querySelectorFirst(editorSel);
  if (!editor) return false;

  editor.focus();
  const method = effectiveFillMethod(editor, fillMethod);

  if (method === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (method === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (method === 'value') {
    const ta = editor as HTMLTextAreaElement;
    const nativeInputValueSetter = getNativeSetter();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    if (nativeInputValueSetter) nativeInputValueSetter.call(ta, next);
    else ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (method === 'prosemirror') {
    const current = editor.innerText.trim();
    editor.textContent = current ? current + '\n' + result : result;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (autoSend) {
    if (!checkContext()) return true;
    const cfg = await chrome.storage.local.get(['autoSend']);
    if (cfg.autoSend === false && !options.forceSend) return true;

    // 自动提交一律即时发送（已移除随机延迟设置）。生成中时 clickSendWhenReady
    // 会等到 stop 按钮消失再点，Qwen 给更长的等待窗口。
    const clicked = await clickSendWhenReady(siteConfig, isQwenPage() ? 90000 : 5000);
    if (!clicked && options.immediate) return false;
  }
  return true;
}

// ── 斜杠命令 / @ 文件补全 ──────────────────────────────────────────────────────

let skillsCache: SkillSummary[] | null = null;
let skillsCacheTime = 0;
const filesCache = new Map<string, { ts: number; files: string[] }>();
const FILES_TTL = 5000;

async function fetchSkills(): Promise<SkillSummary[]> {
  if (!checkContext()) return [];
  if (skillsCache && Date.now() - skillsCacheTime < 30000) return skillsCache;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await bgFetch(apiEndpointForProfile(apiUrl, '/skills'), { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    skillsCache = data.skills || [];
    skillsCacheTime = Date.now();
    return skillsCache!;
  } catch { return []; }
}

async function loadSkillContent(skillName: string): Promise<string | null> {
  const callId = `skill_${Math.random().toString(36).slice(2, 8)}`;
  const result = await executeToolCallReturn({
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
  if (!checkContext()) return [];
  const cached = filesCache.get(q);
  if (cached && Date.now() - cached.ts < FILES_TTL) return cached.files;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await bgFetch(`${apiUrl}/files?q=${encodeURIComponent(q)}`, { headers });
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

function getEditorText(el: HTMLElement): string {
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

function effectiveFillMethod(el: HTMLElement, configuredFillMethod: string): string {
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
    const nativeSetter = getNativeSetter();
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
      const nativeSetter = getNativeSetter();
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
let lastPromptText = '';
let lastPromptAt = 0;

function attachInputListener(editorEl: HTMLElement) {
  if (attachedInputEditors.has(editorEl)) return;
  attachedInputEditors.add(editorEl);

  const { fillMethod } = getSiteConfig();
  let destroyPicker: (() => void) | null = null;
  let inputVersion = 0;

  function dismiss() {
    if (destroyPicker) { destroyPicker(); destroyPicker = null; }
  }

  function logSubmittedPrompt(activeEditor: HTMLElement): void {
    const text = getEditorText(activeEditor).trim();
    if (!text) return;
    activateResponseSession();
    const now = Date.now();
    if (text === lastPromptText && now - lastPromptAt < 1500) return;
    lastPromptText = text;
    lastPromptAt = now;
    // 更新上下文追踪 (user 输入)；updateQwenContext 内部按平台门控
    updateQwenContext('user', text);
    sendUserPromptLog(`user:${getConversationId()}:${now}`, text);
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
      const siteConfig = getSiteConfig();
      if (!target.closest(siteConfig.sendBtn)) return;
      const activeEditor = querySelectorFirst(siteConfig.editor) || editorEl;
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

// Run the content-script init LAST, after every module-level binding above is
// initialized — eliminates the TDZ window that crashed tool-card rendering inside
// Hub iframe panes. (injectPageBridgeEarly already ran at module top for the
// document_start visibility shim; this only defers the heavier init.)
bootstrapContentScript();
