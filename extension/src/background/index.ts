import { browserRelayWsUrl, isAiPageUrl } from './browser-relay-utils';
import { registerChatApiHandler, setListenSendHook } from './chat-api';
import { installBrowserAgent } from './browser-agent';
import { syncPhantomCursor } from './phantom-cursor';
import { initController, getController } from './browser/controller';
import { registerBrowserTools } from './browser/register';
import { dispatchBrowserTool } from './browser/dispatch';
import { approval as browserApproval } from './browser/approval-singleton';
import {
  DOWNLOAD_STORAGE_KEY,
  MAX_DOWNLOAD_RECORDS,
  DownloadRecord,
  applyDownloadDelta,
  downloadItemToRecord,
  filterDownloadRecords,
  upsertDownloadRecord,
} from './downloads';
import { resolveBackgroundInput, resolveStealthMode } from '../settings';

// Cached `backgroundInput` setting (default true): when true, CDP Input.* is
// dispatched without raising/activating the tab, so a background worker tab is
// driven without stealing the user's foreground. Refreshed on storage change.
let backgroundInputEnabled = true;
// Cached `stealthMode` (default false): when on, the phantom cursor is
// suppressed so automation leaves no identifiable overlay in the page DOM.
let stealthModeEnabled = false;
// SW-direct browser execution (default ON). browser_* tools execute inside THIS
// service worker (EXEC_BROWSER_TOOL → dispatchBrowserTool), so each SW only ever
// touches its own browser's tabs. The legacy Go→WS browser_cmd relay — where the Go
// server broadcasts a CDP command to EVERY connected browser-relay — is therefore
// disabled: it was the cross-browser leak (Chrome's browser_new_tab opening a tab in
// Edge too). Flip to false only to debug the old relay path.
const SW_DIRECT_BROWSER = true;
chrome.storage.local.get(['backgroundInput', 'stealthMode'], result => {
  backgroundInputEnabled = resolveBackgroundInput(result.backgroundInput);
  stealthModeEnabled = resolveStealthMode(result.stealthMode);
});

const AI_PAGE_URLS = [
  '*://*.gemini.google.com/*',
  '*://aistudio.google.com/*',
  '*://qwen.ai/*',
  '*://chat.qwen.ai/*',
  '*://*.qwen.ai/*',
  '*://*.qwenlm.ai/*',
  '*://chat.z.ai/*',
  '*://*.kimi.com/*',
  '*://claude.ai/*',
  '*://*.claude.ai/*',
  '*://free.easychat.top/*',
  '*://aistudio.xiaomimimo.com/*',
  '*://chatgpt.com/*',
  '*://*.chatgpt.com/*',
  '*://chat.openai.com/*'
];

type AuthInfo = {
  apiUrl: string;
  token: string;
}

type BrowserCommand = {
  type: 'browser_cmd';
  id: string;
  tabId?: number;
  sessionId?: string;
  domain: string;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

type BrowserResult = {
  type: 'browser_result';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type BrowserRelayStatus = {
  state: 'not_configured' | 'connecting' | 'open' | 'closed' | 'error';
  controlledTabId: number | null;
  lastError?: string;
  updatedAt: number;
}

type BridgeProbe = {
  loaded: boolean;
  wsConnected: boolean;
  wsState: string;
  updatedAt: number;
}

type BridgeStatus = {
  tabs: number;
  loaded: number;
  wsConnected: number;
  failed: number;
}

type EnsureContentResult = BridgeStatus & {
  injected: number;
}

let browserWs: WebSocket | null = null;
let browserReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let browserPingTimer: ReturnType<typeof setInterval> | null = null;
let browserReconnectAttempt = 0;
let browserConnectionSeq = 0;
let controlledTabId: number | null = null;
let configuredBrowserAuth: AuthInfo | null = null;
const attachedTabs = new Set<number>();
const perTabQueues = new Map<number, Promise<unknown>>();
const DEBUGGER_EVENTS_TO_RELAY = new Set([
  'Page.javascriptDialogOpening',
  'Page.frameNavigated',
  'Page.loadEventFired',
  'Page.lifecycleEvent',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFailed',
  // Renderer crash: fires when the tab's render process dies. Unlike a closed
  // tab it triggers neither tabs.onRemoved nor debugger.onDetach, so without
  // relaying this the controller keeps a stale CDP state for a dead tab.
  'Inspector.targetCrashed',
]);

async function probeBridge(tabId: number): Promise<BridgeProbe> {
  const probe = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const w = window as any;
      const status = w.__PIERCODE_WS_STATUS__ || {};
      const loaded = !!w.__PIERCODE_LOADED__;
      const state = typeof status.state === 'string'
        ? status.state
        : loaded ? 'unknown' : 'missing';
      return {
        loaded,
        wsConnected: status.connected === true || state === 'open',
        wsState: state,
        updatedAt: typeof status.updatedAt === 'number' ? status.updatedAt : 0,
      };
    },
  });
  return probe[0]?.result || { loaded: false, wsConnected: false, wsState: 'missing', updatedAt: 0 };
}

async function getBridgeStatus(): Promise<BridgeStatus> {
  const tabs = await chrome.tabs.query({ url: AI_PAGE_URLS });
  let loaded = 0;
  let wsConnected = 0;
  let failed = 0;

  await Promise.all(tabs.map(async tab => {
    if (!tab.id) return;
    try {
      const status = await probeBridge(tab.id);
      if (status.loaded) loaded += 1;
      if (status.wsConnected) wsConnected += 1;
    } catch (error) {
      failed += 1;
      console.warn('[PierCode] 查询 AI 页面连接状态失败:', tab.url, error);
    }
  }));

  return { tabs: tabs.length, loaded, wsConnected, failed };
}

async function ensureContentScripts(): Promise<EnsureContentResult> {
  const tabs = await chrome.tabs.query({ url: AI_PAGE_URLS });
  let injected = 0;
  let loaded = 0;
  let wsConnected = 0;
  let failed = 0;

  await Promise.all(tabs.map(async tab => {
    if (!tab.id) return;
    try {
      // Check whether the content script has already been loaded by the
      // manifest's content_scripts section. Injecting the same script
      // twice causes "Identifier has already been declared" errors
      // because classic (non-module) content scripts share a global scope.
      const status = await probeBridge(tab.id);
      if (status.loaded) {
        loaded += 1;
        if (status.wsConnected) wsConnected += 1;
        injected += 1;
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      injected += 1;
      loaded += 1;
    } catch (error) {
      failed += 1;
      console.warn('[PierCode] 注入 AI 页面失败:', tab.url, error);
    }
  }));

  return { tabs: tabs.length, injected, loaded, wsConnected, failed };
}

function setBrowserRelayStatus(status: Omit<BrowserRelayStatus, 'controlledTabId' | 'updatedAt'>) {
  const next: BrowserRelayStatus = {
    ...status,
    controlledTabId,
    updatedAt: Date.now(),
  };
  chrome.storage.local.set({ browserRelayStatus: next });
  void broadcastControlledTab();
}

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

// broadcastControlledTab 把当前受控 tab 推给所有 content（面板用）。controlledTabId
// 每次变化都伴随 setBrowserRelayStatus，故从那里统一广播。失败静默。
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

function getAuthInfo(): Promise<AuthInfo | null> {
  return new Promise(resolve => {
    chrome.storage.local.get(['apiUrl', 'authToken', 'authPort'], result => {
      if (result.apiUrl && result.authToken) {
        resolve({ apiUrl: result.apiUrl, token: result.authToken });
      } else if (result.authPort && result.authToken) {
        resolve({ apiUrl: `http://127.0.0.1:${result.authPort}`, token: result.authToken });
      } else {
        resolve(null);
      }
    });
  });
}

function clearStoredAuth(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(['authToken', 'apiUrl', 'authPort'], () => resolve());
  });
}

function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

async function verifyStoredAuth(info: AuthInfo): Promise<'valid' | 'unauthorized' | 'unknown'> {
  try {
    const response = await fetch(apiEndpoint(info.apiUrl, '/stats'), {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    if (response.status === 401) return 'unauthorized';
    if (response.ok) return 'valid';
  } catch {}
  return 'unknown';
}

function sendBrowserMessage(payload: unknown): boolean {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return false;
  browserWs.send(JSON.stringify(payload));
  return true;
}

function sendBrowserResult(result: BrowserResult) {
  sendBrowserMessage(result);
}

function sameBrowserAuth(info: AuthInfo | null): boolean {
  return !!info &&
    !!configuredBrowserAuth &&
    info.apiUrl === configuredBrowserAuth.apiUrl &&
    info.token === configuredBrowserAuth.token;
}

function disconnectBrowserRelay(state: BrowserRelayStatus['state'] = 'not_configured', lastError?: string) {
  browserConnectionSeq++;
  configuredBrowserAuth = null;
  browserReconnectAttempt = 0;
  if (browserReconnectTimer) {
    clearTimeout(browserReconnectTimer);
    browserReconnectTimer = null;
  }
  if (browserPingTimer) {
    clearInterval(browserPingTimer);
    browserPingTimer = null;
  }
  const current = browserWs;
  browserWs = null;
  if (current) {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try { current.close(); } catch {}
  }
  setBrowserRelayStatus(lastError ? { state, lastError } : { state });
}

function queueBrowserCommand<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = perTabQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  perTabQueues.set(tabId, next.finally(() => {
    if (perTabQueues.get(tabId) === next) perTabQueues.delete(tabId);
  }));
  return next;
}

function shouldBypassTabQueue(msg: BrowserCommand): boolean {
  return msg.domain === 'Page' && msg.method === 'handleJavaScriptDialog';
}

async function connectBrowserRelay() {
  const seq = ++browserConnectionSeq;
  const info = await getAuthInfo();
  if (seq !== browserConnectionSeq) return;
  if (!info) {
    disconnectBrowserRelay('not_configured');
    return;
  }
  const authState = await verifyStoredAuth(info);
  if (seq !== browserConnectionSeq) return;
  if (authState === 'unauthorized') {
    await clearStoredAuth();
    disconnectBrowserRelay('not_configured', 'token expired');
    return;
  }
  configuredBrowserAuth = info;
  const wsUrl = browserRelayWsUrl(info.apiUrl, info.token);
  if (!wsUrl) {
    disconnectBrowserRelay('error', 'invalid browser relay URL');
    return;
  }
  if (browserWs) browserWs.close();
  setBrowserRelayStatus({ state: 'connecting' });
  browserWs = new WebSocket(wsUrl);
  browserWs.onopen = () => {
    if (seq !== browserConnectionSeq) return;
    browserReconnectAttempt = 0;
    setBrowserRelayStatus({ state: 'open' });
    sendBrowserMessage({
      type: 'browser_hello',
      capabilities: ['cdp', 'tabs', 'selectorRect', 'debuggerEvents', 'downloads'],
      version: chrome.runtime.getManifest().version,
    });
    if (browserPingTimer) clearInterval(browserPingTimer);
    browserPingTimer = setInterval(() => {
      sendBrowserMessage({ type: 'browser_ping', controlledTabId });
    }, 20000);
  };
  browserWs.onmessage = event => {
    try {
      const msg = JSON.parse(event.data) as BrowserCommand;
      if (msg.type === 'browser_cmd') {
        // browser_* tools now execute SW-natively (EXEC_BROWSER_TOOL → dispatchBrowserTool),
        // so the legacy Go→WS CDP-relay path is dead. CRITICAL: a Go /exec browser tool
        // with an unknown tabId BROADCASTS browser_cmd to EVERY connected browser-relay
        // (ws.go SendBrowserCommand → SendToRole), so if multiple browsers (e.g. Chrome +
        // Edge) obey it, one browser's browser_new_tab opens a tab in ALL of them. We must
        // NOT execute relayed commands anymore. Reply with an error so Go's pending
        // SendCommand resolves immediately (no 30s hang) instead of silently dropping.
        if (SW_DIRECT_BROWSER) {
          sendBrowserResult({
            type: 'browser_result', id: msg.id, success: false,
            error: 'browser tools run in the extension service worker now; the Go relay path is disabled (set SW_DIRECT_BROWSER=false to re-enable legacy relay)',
          });
          return;
        }
        const key = typeof msg.tabId === 'number' ? msg.tabId : 0;
        const run = shouldBypassTabQueue(msg)
          ? handleBrowserCommand(msg)
          : queueBrowserCommand(key, () => handleBrowserCommand(msg));
        run
          .then(data => sendBrowserResult({ type: 'browser_result', id: msg.id, success: true, data }))
          .catch(error => sendBrowserResult({ type: 'browser_result', id: msg.id, success: false, error: errorMessage(error) }));
      }
    } catch (error) {
      console.warn('[PierCode] browser relay message failed:', error);
    }
  };
  browserWs.onclose = () => {
    if (seq !== browserConnectionSeq) return;
    browserWs = null;
    if (browserPingTimer) {
      clearInterval(browserPingTimer);
      browserPingTimer = null;
    }
    setBrowserRelayStatus({ state: 'closed' });
    // Stop after a finite number of attempts: the Go server is optional now (browser_*
    // runs in this SW), so an absent server must not reconnect forever. A config/auth
    // change (connectBrowserRelay from storage.onChanged) resets browserReconnectAttempt
    // and starts a fresh round. Backoff caps the delay; this caps the count.
    const MAX_BROWSER_RECONNECT = 6;
    if (browserReconnectAttempt >= MAX_BROWSER_RECONNECT) {
      setBrowserRelayStatus({ state: 'not_configured', lastError: 'browser relay reconnect cap reached; start the PierCode server and reconnect from the popup' });
      return;
    }
    const delays = [1000, 3000, 5000, 10000, 30000];
    const delay = delays[Math.min(browserReconnectAttempt++, delays.length - 1)];
    if (browserReconnectTimer) clearTimeout(browserReconnectTimer);
    browserReconnectTimer = setTimeout(async () => {
      browserReconnectTimer = null;
      const fresh = await getAuthInfo();
      if (!fresh || !sameBrowserAuth(fresh)) {
        disconnectBrowserRelay(fresh ? 'closed' : 'not_configured');
        if (fresh) connectBrowserRelay();
        return;
      }
      const authState = await verifyStoredAuth(fresh);
      if (authState === 'unauthorized') {
        await clearStoredAuth();
        disconnectBrowserRelay('not_configured', 'token expired');
        return;
      }
      connectBrowserRelay();
    }, delay);
  };
  browserWs.onerror = () => {
    setBrowserRelayStatus({ state: 'error', lastError: 'browser relay websocket error' });
    browserWs?.close();
  };
}

async function handleBrowserCommand(msg: BrowserCommand): Promise<unknown> {
  const params = msg.params || {};
  if (msg.domain === 'PierCode') {
    return handleNativeBrowserCommand(msg.method, params);
  }
  if (typeof msg.tabId !== 'number') {
    throw new Error('tabId is required for CDP browser commands');
  }
  await ensureAttached(msg.tabId);
  if (msg.domain === 'Input') {
    // CDP input is delivered to the renderer by tabId regardless of foreground
    // state, so by default we do NOT raise/activate the tab (keeps a background
    // worker from stealing the user's foreground). Opt back in via backgroundInput=false.
    if (!backgroundInputEnabled) {
      await activateTabForInput(msg.tabId);
    }
    if (msg.method === 'dispatchMouseEvent' && !stealthModeEnabled) {
      await syncPhantomCursor(msg.tabId, params);
    }
  }
  // 给 CDP 命令加超时，防止扩展 relay 卡死
  const cmdTimeout = Math.max(msg.timeoutMs || 30000, 10000);
  // A sessionId targets a child OOPIF session (flat sessions, Chrome 125+);
  // omitting it targets the tab's top-level page session. @types/chrome predates
  // DebuggerSession, so the target is built as a loose object and cast.
  const target = (msg.sessionId
    ? { tabId: msg.tabId, sessionId: msg.sessionId }
    : { tabId: msg.tabId }) as chrome.debugger.Debuggee;
  const sendPromise = chrome.debugger.sendCommand(target, `${msg.domain}.${msg.method}`, params);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`CDP command ${msg.domain}.${msg.method} timed out after ${cmdTimeout}ms`)), cmdTimeout)
  );
  const result = await Promise.race([sendPromise, timeoutPromise]);
  if (msg.domain === 'Page' && msg.method === 'navigate') {
    await waitForTabComplete(msg.tabId, navigationLoadWaitMs(msg.timeoutMs));
  }
  return result || {};
}

async function handleNativeBrowserCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'listTabs':
      return listBrowserTabs(params.includeAiPages === true);
    case 'createTab':
      return createControlledTab(typeof params.url === 'string' ? params.url : 'about:blank', params.controlled !== false);
    case 'getTab':
      return tabToDTO(await chrome.tabs.get(Number(params.tabId)));
    case 'resolveSelectorRect':
      return resolveSelectorRect(Number(params.tabId), String(params.selector || ''));
    case 'navigate':
      return navigateTab(Number(params.tabId), String(params.url || ''));
    case 'cookies':
      return getCookies(params);
    case 'setCookie':
      return setCookieNative(params);
    case 'finalizeTabs':
      return finalizeTabs(params);
    case 'downloads':
      return getRecentDownloads(params);
    case 'viewport':
      return setViewportOverride(params);
    case 'resizeWindow':
      return resizeWindow(params);
    case 'listFrameSessions':
      return { sessions: listFrameSessions(Number(params.tabId)) };
    default:
      throw new Error(`unknown PierCode browser method: ${method}`);
  }
}

// 导航到 URL
async function navigateTab(tabId: number, url: string): Promise<unknown> {
  if (!tabId) throw new Error('tabId is required');
  if (!url) throw new Error('url is required');

  try {
    // 检查 URL 是否安全
    const dangerousProtocols = ['javascript:', 'data:', 'vbscript:'];
    const lowerUrl = url.toLowerCase();
    if (dangerousProtocols.some(p => lowerUrl.startsWith(p))) {
      return { success: false, error: `Blocked dangerous protocol: ${url.split(':')[0]}` };
    }

    // 如果没有协议，添加 https://
    if (!url.match(/^https?:\/\//i)) {
      url = 'https://' + url;
    }

    await chrome.tabs.update(tabId, { url });

    // 等待页面加载
    await waitForTabComplete(tabId, 30000);

    const tab = await chrome.tabs.get(tabId);
    return {
      success: true,
      url: tab.url,
      title: tab.title
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function getCookies(params: Record<string, unknown>): Promise<unknown> {
  const domain = typeof params.domain === 'string' ? params.domain.trim() : '';
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  const includeValue = params.includeValue !== false;
  const rawLimit = typeof params.limit === 'number' ? params.limit : 200;
  const limit = Math.max(1, Math.min(1000, Math.floor(rawLimit)));

  if (!domain && !url) {
    throw new Error('cookie scope required: provide domain or url');
  }

  const details: chrome.cookies.GetAllDetails = {};
  if (domain) details.domain = domain;
  if (url) details.url = url;

  const cookies = await chrome.cookies.getAll(details);
  return {
    cookies: cookies.slice(0, limit).map(cookie => ({
      name: cookie.name,
      value: includeValue ? cookie.value : undefined,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expirationDate: cookie.expirationDate,
      storeId: cookie.storeId,
    })),
    count: Math.min(cookies.length, limit),
    total: cookies.length,
    truncated: cookies.length > limit,
    includeValue,
  };
}

function cookieScopeURL(params: Record<string, unknown>): string {
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  if (url) return url;
  const domain = typeof params.domain === 'string' ? params.domain.trim() : '';
  if (!domain) throw new Error('cookie scope required: provide domain or url');
  const secure = params.secure === true;
  const host = domain.replace(/^\./, '');
  const scheme = secure ? 'https' : 'http';
  return `${scheme}://${host}/`;
}

async function setCookieNative(params: Record<string, unknown>): Promise<unknown> {
  const action = typeof params.action === 'string' ? params.action.toLowerCase() : '';
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!name) throw new Error('cookie name is required');
  const url = cookieScopeURL(params);

  if (action === 'delete') {
    await chrome.cookies.remove({ url, name });
    return { ok: true, name, domain: typeof params.domain === 'string' ? params.domain : '' };
  }
  if (action !== 'set') {
    throw new Error(`unsupported set_cookie action: ${action}`);
  }

  const details: chrome.cookies.SetDetails = {
    url,
    name,
    value: typeof params.value === 'string' ? params.value : String(params.value ?? ''),
  };
  if (typeof params.domain === 'string' && params.domain.trim()) details.domain = params.domain.trim();
  if (typeof params.path === 'string' && params.path.trim()) details.path = params.path.trim();
  if (params.secure === true) details.secure = true;
  if (params.httpOnly === true) details.httpOnly = true;
  if (typeof params.sameSite === 'string' && params.sameSite.trim()) {
    details.sameSite = params.sameSite.trim() as chrome.cookies.SameSiteStatus;
  }
  if (typeof params.expirationDate === 'number' && params.expirationDate > 0) {
    details.expirationDate = params.expirationDate;
  }

  const cookie = await chrome.cookies.set(details);
  if (!cookie) {
    throw new Error(`failed to set cookie ${name} for ${url}; the target domain may be outside the extension host permissions`);
  }
  return { ok: true, name: cookie.name, domain: cookie.domain };
}

async function finalizeTabs(params: Record<string, unknown>): Promise<unknown> {
  const closeTabIds = arrayOfPositiveInts(params.closeTabIds);
  const closed: number[] = [];
  const skipped: string[] = [];

  for (const tabId of closeTabIds) {
    try {
      if (attachedTabs.has(tabId)) {
        try { await chrome.debugger.detach({ tabId }); } catch {}
        attachedTabs.delete(tabId);
      }
      await chrome.tabs.remove(tabId);
      perTabQueues.delete(tabId);
      if (controlledTabId === tabId) controlledTabId = null;
      closed.push(tabId);
    } catch (error) {
      skipped.push(`tabId=${tabId} close failed: ${errorMessage(error)}`);
    }
  }

  if (closed.length > 0) {
    setBrowserRelayStatus({ state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed' });
  }
  return { closed, skipped };
}

async function setViewportOverride(params: Record<string, unknown>): Promise<unknown> {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('tabId is required');
  await ensureAttached(tabId);
  if (params.reset === true) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {});
    return {};
  }
  const width = Number(params.width);
  const height = Number(params.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('width and height are required');
  }
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return {};
}

async function resizeWindow(params: Record<string, unknown>): Promise<unknown> {
  const tabId = Number(params.tabId);
  const width = Number(params.width);
  const height = Number(params.height);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('tabId is required');
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('width and height are required');
  }
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.windowId !== 'number') throw new Error('tab windowId is unavailable');
  await chrome.windows.update(tab.windowId, { width, height });
  return {};
}

async function getRecentDownloads(params: Record<string, unknown>): Promise<unknown> {
  const queriedRecords = await queryRecentDownloads().catch(() => []);
  // Run the read-merge-write inside the shared queue so it cannot interleave
  // with the onCreated/onChanged listeners and lose their updates.
  const merged = await enqueueDownloadWrite(async () => {
    const records = await loadDownloadRecords();
    const next = queriedRecords.reduce(
      (acc, record) => upsertDownloadRecord(acc, record),
      records,
    );
    if (queriedRecords.length > 0) await saveDownloadRecords(next);
    return next;
  });
  const limit = typeof params.limit === 'number' ? params.limit : 20;
  const state = typeof params.state === 'string' ? params.state : 'all';
  return filterDownloadRecords(merged, state, limit);
}

async function queryRecentDownloads(): Promise<DownloadRecord[]> {
  const items = await chrome.downloads.search({
    orderBy: ['-startTime'],
    limit: MAX_DOWNLOAD_RECORDS,
  });
  return items.map(item => downloadItemToRecord(item));
}

function arrayOfPositiveInts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of raw) {
    const value = Number(item);
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function loadDownloadRecords(): Promise<DownloadRecord[]> {
  const result = await chrome.storage.local.get(DOWNLOAD_STORAGE_KEY);
  const records = result[DOWNLOAD_STORAGE_KEY];
  return Array.isArray(records) ? records.filter(isDownloadRecord) : [];
}

async function saveDownloadRecords(records: DownloadRecord[]): Promise<void> {
  await chrome.storage.local.set({ [DOWNLOAD_STORAGE_KEY]: records });
}

// onCreated and onChanged fire concurrently, and getRecentDownloads also
// merges. Each does an un-serialized read-modify-write on the same
// chrome.storage.local key, so a later write can clobber an earlier one and
// drop an update. Serialize every record mutation through a single promise
// chain so the read-modify-write is atomic with respect to the others.
let downloadWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueDownloadWrite<T>(mutate: () => Promise<T>): Promise<T> {
  const run = downloadWriteQueue.then(mutate, mutate);
  // Keep the chain alive even if a mutation rejects; swallow only for the
  // queue tail, callers still receive the original (possibly rejected) result.
  downloadWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isDownloadRecord(value: unknown): value is DownloadRecord {
  return !!value && typeof value === 'object' &&
    typeof (value as DownloadRecord).id === 'string' &&
    typeof (value as DownloadRecord).state === 'string';
}

async function recordDownloadCreated(item: chrome.downloads.DownloadItem): Promise<void> {
  await enqueueDownloadWrite(async () => {
    const records = await loadDownloadRecords();
    await saveDownloadRecords(upsertDownloadRecord(records, downloadItemToRecord(item)));
  });
}

async function recordDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
  await enqueueDownloadWrite(async () => {
    const records = await loadDownloadRecords();
    const id = String(delta.id);
    const existing = records.find(item => item.id === id) || {
      id,
      state: 'in_progress' as const,
      startedAt: new Date().toISOString(),
    };
    await saveDownloadRecords(upsertDownloadRecord(records, applyDownloadDelta(existing, delta)));
  });
}

async function listBrowserTabs(includeAiPages: boolean): Promise<{ tabs: ReturnType<typeof tabToDTO>[] }> {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter(tab => tab.id && tab.url && (includeAiPages || !isAiPageUrl(tab.url)))
      .map(tabToDTO),
  };
}

// Maps a worker tab id to its agent id. spawn_agent encodes the id into the tab
// URL (?piercode_agent=<id>), but AI-site SPAs may strip the query before the
// content script reads it. The background parses it from the create URL here so
// the worker content can recover it durably via GET_WORKER_AGENT_ID.
const workerAgentIdByTabId = new Map<number, string>();

function parsePiercodeAgentId(url: string): string {
  try {
    return new URL(url).searchParams.get('piercode_agent') || '';
  } catch {
    return '';
  }
}

// Reused tab-group id (per window) so all controlled tabs land in one group.
let piercodeTabGroupId: number | null = null;

// groupControlledTab puts an automated tab into a visible "PierCode" tab group
// and sets an action badge, so the user can see which tabs the agent drives.
// Best-effort: tabGroups may be unavailable or the tab may close mid-call.
async function groupControlledTab(tabId: number): Promise<void> {
  try {
    if (!chrome.tabs.group || !chrome.tabGroups) return;
    const opts: chrome.tabs.GroupOptions = { tabIds: tabId };
    if (piercodeTabGroupId != null) {
      try {
        await chrome.tabGroups.get(piercodeTabGroupId);
        opts.groupId = piercodeTabGroupId;
      } catch {
        piercodeTabGroupId = null; // stale (window closed) → make a new group
      }
    }
    const groupId = await chrome.tabs.group(opts);
    piercodeTabGroupId = groupId;
    await chrome.tabGroups.update(groupId, { title: 'PierCode', color: 'blue' }).catch(() => undefined);
  } catch {
    // tabGroups unavailable / tab gone — ignore.
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: '●' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b8cff' });
  } catch {
    // action badge best-effort.
  }
}

async function createControlledTab(url: string, controlled = true) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  if (!tab.id) throw new Error('created tab has no id');
  // spawn_agent worker tabs pass controlled=false: they must not become the
  // "controlled tab" the popup/status surfaces (and must never be the implicit
  // target of tabID-less browser tools — the Go side enforces that part).
  if (controlled) controlledTabId = tab.id;
  const agentId = parsePiercodeAgentId(url);
  if (agentId) workerAgentIdByTabId.set(tab.id, agentId);
  // Group the automated tab under a visible "PierCode" tab group + badge it, so
  // the user can always see which tabs the agent controls. Best-effort.
  void groupControlledTab(tab.id);
  await waitForTabComplete(tab.id, 30000).catch(() => undefined);
  const fresh = await chrome.tabs.get(tab.id);
  setBrowserRelayStatus({ state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed' });
  return tabToDTO(fresh);
}

async function openQwenCompressedContextTab(url: string, text: string): Promise<{ ok: boolean; tab?: ReturnType<typeof tabToDTO>; error?: string }> {
  if (!text.trim()) return { ok: false, error: 'empty compressed context' };
  const tab = await chrome.tabs.create({ url: url || 'https://chat.qwen.ai/', active: true });
  if (!tab.id) return { ok: false, error: 'created tab has no id' };
  await waitForTabComplete(tab.id, 30000).catch(() => undefined);
  const result = await sendCompressedContextToTab(tab.id, text);
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
  return result.ok
    ? { ok: true, tab: tabToDTO(fresh) }
    : { ok: false, tab: tabToDTO(fresh), error: result.error };
}

async function sendCompressedContextToTab(tabId: number, text: string): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + 30000;
  let lastError = 'content script not ready';
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'PIERCODE_FILL_COMPRESSED_CONTEXT',
        text,
      });
      if (response?.ok === true) return { ok: true };
      lastError = response?.error || 'content script did not accept compressed context';
    } catch (error) {
      lastError = errorMessage(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { ok: false, error: lastError };
}

// enableDebuggerDomains turns on the CDP domains whose events we relay. Each
// enable is best-effort: a domain that fails to enable (e.g. on a restricted
// page) must not abort the attach. Network.enable bounds captured POST data.
async function enableDebuggerDomains(tabId: number): Promise<void> {
  const enables: Array<[string, Record<string, unknown>]> = [
    ['Page.enable', {}],
    ['Page.setLifecycleEventsEnabled', { enabled: true }],
    ['Runtime.enable', {}],
    ['Network.enable', { maxPostDataSize: 65536 }],
    // Subscribe to Inspector.targetCrashed so a renderer crash is surfaced to
    // the controller (which then marks the tab stale instead of failing every
    // subsequent browser_* call against dead CDP state).
    ['Inspector.enable', {}],
    // Flat-session auto-attach (Chrome 125+) so cross-origin OOPIF child frames
    // surface as addressable sessions via Target.attachedToTarget. Harmless on
    // older Chrome (the command simply errors and is ignored).
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
  ];
  for (const [method, params] of enables) {
    try {
      await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch {
      // best-effort: ignore per-domain enable failure
    }
  }
}

// Maps an OOPIF child session to its owning tab + frame metadata, learned from
// Target.attachedToTarget. Used to (a) enumerate frame sessions for snapshots
// and (b) recurse auto-attach into nested OOPIFs.
type FrameSession = { tabId: number; sessionId: string; targetId: string; url: string };
const frameSessionsByTab = new Map<number, Map<string, FrameSession>>();

function recordFrameSession(tabId: number, fs: FrameSession): void {
  let m = frameSessionsByTab.get(tabId);
  if (!m) {
    m = new Map();
    frameSessionsByTab.set(tabId, m);
  }
  m.set(fs.sessionId, fs);
}

function dropFrameSession(tabId: number, sessionId: string): void {
  frameSessionsByTab.get(tabId)?.delete(sessionId);
}

function clearFrameSessions(tabId: number): void {
  frameSessionsByTab.delete(tabId);
}

// listFrameSessions returns the known OOPIF sessions for a tab (for snapshot
// merging on the Go side, surfaced via a native command).
function listFrameSessions(tabId: number): FrameSession[] {
  return Array.from(frameSessionsByTab.get(tabId)?.values() ?? []);
}

async function ensureAttached(tabId: number) {
  if (attachedTabs.has(tabId)) return;
  // chrome-extension:// 和某些特殊页面无法 attach debugger，加超时避免卡死
  const attachPromise = chrome.debugger.attach({ tabId }, '1.3');
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`debugger attach timed out for tab ${tabId}`)), 8000)
  );
  try {
    await Promise.race([attachPromise, timeoutPromise]);
    attachedTabs.add(tabId);
    // Eagerly enable the domains whose events we relay, so navigation lifecycle
    // and load-time console/network events are captured from attach onward
    // (lazy enable used to lose everything before the first read call).
    await enableDebuggerDomains(tabId);
  } catch (error) {
    if (errorMessage(error).includes('Another debugger is already attached')) {
      attachedTabs.delete(tabId);
      sendBrowserMessage({
        type: 'browser_event',
        event: 'debugger_detached',
        tabId,
        reason: 'another_debugger_attached',
      });
    }
    throw error;
  }
}

// ── SW-direct browser tool execution ────────────────────────────────────────
// browser_* tools run inside this SW (no /exec round-trip): each SW only sees its
// own browser's tabs, so the old cross-browser WS broadcast race cannot happen.
// The controller's low-level CDP transport ensures the debugger is attached (+ its
// domains enabled) before issuing the command, mirroring the relay path.
const browserCdpSend = async (
  target: chrome.debugger.Debuggee, method: string, params?: object,
): Promise<any> => {
  const anyTarget = target as { tabId?: number; sessionId?: string };
  if (typeof anyTarget.tabId === 'number') await ensureAttached(anyTarget.tabId);
  return chrome.debugger.sendCommand(target, method, params ?? {});
};
initController({
  send: browserCdpSend,
  // Expose the SW's OOPIF session registry so browser_snapshot can include cross-origin
  // child frames' elements (FrameSession is structurally {sessionId, url, …}).
  listFrameSessions: (tabId: number) => listFrameSessions(tabId).map(fs => ({ sessionId: fs.sessionId, url: fs.url })),
});
registerBrowserTools();

async function activateTabForInput(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  await chrome.tabs.update(tabId, { active: true });
}

async function resolveSelectorRect(tabId: number, selector: string) {
  if (!selector) throw new Error('selector is required');
  await ensureAttached(tabId);
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
  })()`;
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  }) as { result?: { value?: unknown } };
  const value = result.result?.value as { x?: number; y?: number; width?: number; height?: number } | null | undefined;
  if (!value || !value.width || !value.height) throw new Error(`selector not found or not visible: ${selector}`);
  return value;
}

function navigationLoadWaitMs(commandTimeoutMs: number | undefined): number {
  const softWaitMs = 15000;
  const relayReturnBufferMs = 5000;
  if (!Number.isFinite(commandTimeoutMs) || !commandTimeoutMs || commandTimeoutMs <= relayReturnBufferMs + 1000) {
    return softWaitMs;
  }
  return Math.max(1000, Math.min(softWaitMs, commandTimeoutMs - relayReturnBufferMs));
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, Math.max(1000, timeoutMs));
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
  });
}

function tabToDTO(tab: chrome.tabs.Tab) {
  return {
    tabId: tab.id || 0,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active === true,
    controlled: !!tab.id && tab.id === controlledTabId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH') {
    const { url, options } = msg;
    fetch(url, options)
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(e => ({ ok: false, status: 0, body: String(e) }))
      .then(sendResponse);
    return true;
  }
  if (msg.type === 'ENSURE_CONTENT_SCRIPTS') {
    ensureContentScripts()
      .then(sendResponse)
      .catch(error => sendResponse({ tabs: 0, injected: 0, loaded: 0, wsConnected: 0, failed: 1, error: String(error) }));
    return true;
  }
  if (msg.type === 'EXEC_BROWSER_TOOL') {
    const callId = msg.callId || `bsw-${Date.now()}`;
    // The sender tab IS the AI page that emitted the tool — approval cards + the
    // screenshot attachment target this tab only (no broadcast to other AI tabs).
    const originTabId = _sender?.tab?.id;
    dispatchBrowserTool(msg.name, msg.args || {}, callId, { originTabId })
      .then(sendResponse)
      .catch(e => sendResponse({ callId, name: msg.name, output: String(e), error: String(e), success: false }));
    return true;
  }
  if (msg.type === 'BROWSER_APPROVAL_ANSWER') {
    browserApproval.deliver({ approvalId: msg.approvalId, approved: msg.approved, reason: msg.reason, scope: msg.scope });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_BRIDGE_STATUS') {
    getBridgeStatus()
      .then(sendResponse)
      .catch(error => sendResponse({ tabs: 0, loaded: 0, wsConnected: 0, failed: 1, error: String(error) }));
    return true;
  }
  if (msg.type === 'GET_BROWSER_RELAY_STATUS') {
    chrome.storage.local.get(['browserRelayStatus'], result => {
      sendResponse(result.browserRelayStatus || {
        state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed',
        controlledTabId,
        updatedAt: Date.now(),
      });
    });
    return true;
  }
  if (msg.type === 'GET_WORKER_AGENT_ID') {
    // Worker content asks for its agent id when the URL query was stripped by the
    // site SPA before it could read ?piercode_agent. Look it up by the sender's
    // tab id (recorded at createControlledTab).
    const tabId = _sender?.tab?.id;
    const agentId = typeof tabId === 'number' ? (workerAgentIdByTabId.get(tabId) || '') : '';
    sendResponse({ agentId });
    return true;
  }
  if (msg.type === 'RELEASE_WORKER_AGENT') {
    // The worker tab was reclaimed by the user for their own conversation;
    // forget the tabId -> agentId mapping so GET_WORKER_AGENT_ID cannot
    // re-teach the page its old worker identity.
    const tabId = _sender?.tab?.id;
    if (typeof tabId === 'number') workerAgentIdByTabId.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_CONTROLLED_TAB') {
    if (controlledTabId == null) {
      sendResponse({ type: 'PIERCODE_CONTROLLED_TAB', info: null });
    } else {
      chrome.tabs.get(controlledTabId)
        .then(tab => sendResponse(buildControlledTabMessage(tab)))
        .catch(() => sendResponse({ type: 'PIERCODE_CONTROLLED_TAB', info: null }));
    }
    return true;
  }
  if (msg.type === 'FOCUS_SELF') {
    // FOCUS_SELF from content script: default to non-intrusive mode
    focusSenderTab(_sender, { forceFocus: msg.forceFocus === true })
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg.type === 'OPEN_QWEN_COMPRESSED_CONTEXT') {
    openQwenCompressedContextTab(String(msg.url || 'https://chat.qwen.ai/'), String(msg.text || ''))
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg.type === 'STOP_BROWSER_OPERATION') {
    // 停止当前浏览器操作：detach所有调试器
    console.log('[PierCode] Stopping browser operations...');
    const detachedTabs = Array.from(attachedTabs);
    for (const tabId of detachedTabs) {
      try {
        chrome.debugger.detach({ tabId });
      } catch {}
    }
    attachedTabs.clear();
    // 通知所有content script隐藏指示器
    chrome.tabs.query({ url: AI_PAGE_URLS }, tabs => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'HIDE_INDICATORS' }).catch(() => {});
        }
      }
    });
    sendResponse({ success: true, detachedCount: detachedTabs.length });
    return false;
  }
  return false;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number') {
    attachedTabs.delete(source.tabId);
    sendBrowserMessage({ type: 'browser_event', event: 'debugger_detached', tabId: source.tabId, reason });
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== 'number') return;
  if (!attachedTabs.has(tabId)) return;

  // Track OOPIF child sessions (flat sessions). auto-attach is NOT recursive:
  // attaching to a frame only attaches its direct children, so on each new
  // child we re-issue setAutoAttach on that child's session to reach grandkids.
  if (method === 'Target.attachedToTarget') {
    const p = (params || {}) as { sessionId?: string; targetInfo?: { targetId?: string; type?: string; url?: string } };
    const ti = p.targetInfo;
    if (p.sessionId && ti && (ti.type === 'iframe' || ti.type === 'page')) {
      recordFrameSession(tabId, { tabId, sessionId: p.sessionId, targetId: ti.targetId || '', url: ti.url || '' });
      // Recurse into this child's own subframes + enable the domains we read.
      const childTarget = { tabId, sessionId: p.sessionId } as chrome.debugger.Debuggee;
      void chrome.debugger.sendCommand(childTarget, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      void chrome.debugger.sendCommand(childTarget, 'DOM.enable', {}).catch(() => undefined);
      void chrome.debugger.sendCommand(childTarget, 'Accessibility.enable', {}).catch(() => undefined);
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    const p = (params || {}) as { sessionId?: string };
    if (p.sessionId) dropFrameSession(tabId, p.sessionId);
    return;
  }

  // Feed console/network CDP events into the SW controller's EventBus so
  // browser_console / browser_network can read them without the Go server.
  if (method === 'Runtime.consoleAPICalled') {
    const p = (params || {}) as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
    getController().events.recordConsole(tabId, {
      level: p.type || 'log',
      text: (p.args || []).map(a => (a.value != null ? String(a.value) : a.description || '')).join(' '),
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const p = (params || {}) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    getController().events.recordConsole(tabId, {
      level: 'error',
      text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'uncaught exception',
    });
  } else if (method === 'Network.responseReceived') {
    const p = (params || {}) as { requestId?: string; response?: { url?: string; status?: number } };
    getController().events.recordNetwork(tabId, {
      requestId: p.requestId || '',
      url: p.response?.url || '',
      method: 'GET',
      status: p.response?.status,
    });
  } else if (method === 'Network.requestWillBeSent') {
    const p = (params || {}) as { requestId?: string; request?: { url?: string; method?: string } };
    getController().events.recordNetwork(tabId, {
      requestId: p.requestId || '',
      url: p.request?.url || '',
      method: p.request?.method || 'GET',
    });
  } else if (method === 'Page.frameNavigated') {
    // Resolve a pending browser_wait_for_navigation: only main-frame nav counts
    // (a subframe navigating is not "the page navigated"). parentId absent = main.
    const p = (params || {}) as { frame?: { url?: string; parentId?: string } };
    if (p.frame && !p.frame.parentId) getController().events.handleNavEvent(tabId, { url: p.frame.url || '' });
  } else if (method === 'Page.javascriptDialogOpening') {
    // Surface the dialog to a pending browser_handle_dialog waiter (if any).
    const p = (params || {}) as { message?: string; type?: string; url?: string };
    getController().events.handleDialogEvent(tabId, { message: p.message || '', dialogType: p.type || '', url: p.url || '' });
  }

  if (!DEBUGGER_EVENTS_TO_RELAY.has(method)) return;
  sendBrowserMessage({
    type: 'browser_event',
    event: method,
    tabId,
    params: params || {},
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId);
  perTabQueues.delete(tabId);
  workerAgentIdByTabId.delete(tabId);
  clearFrameSessions(tabId);
  // SW controller: drop this tab's snapshots/refs/console/network so a recycled
  // tabId can't resolve a stale ref (the ref-staleness invariant across tab death).
  getController().registry.clearDefault(tabId);
  getController().events.clearTab(tabId);
  if (controlledTabId === tabId) {
    controlledTabId = null;
    setBrowserRelayStatus({ state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed' });
  }
  sendBrowserMessage({ type: 'browser_event', event: 'tab_removed', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (controlledTabId !== tabId) return;
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    void broadcastControlledTab();
    sendBrowserMessage({
      type: 'browser_event',
      event: 'tab_updated',
      tabId,
      url: tab.url || '',
      title: tab.title || '',
    });
  }
});

chrome.downloads.onCreated.addListener(item => {
  recordDownloadCreated(item).catch(error => {
    console.warn('[PierCode] failed to record download:', error);
  });
});

chrome.downloads.onChanged.addListener(delta => {
  recordDownloadChanged(delta).catch(error => {
    console.warn('[PierCode] failed to update download:', error);
  });
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && (changes.apiUrl || changes.authToken || changes.authPort)) {
    getAuthInfo().then(info => {
      if (info) connectBrowserRelay();
      else disconnectBrowserRelay('not_configured');
    });
  }
  if (namespace === 'local' && changes.backgroundInput) {
    backgroundInputEnabled = resolveBackgroundInput(changes.backgroundInput.newValue);
  }
  if (namespace === 'local' && changes.stealthMode) {
    stealthModeEnabled = resolveStealthMode(changes.stealthMode.newValue);
  }
});

connectBrowserRelay();

// Register the sidebar chat API handler (SSE streaming + tool auto-exec)
registerChatApiHandler();

// Register the browser-agent orchestrator (BROWSER_AGENT_* messages + the
// AI-iframe bridge's runtime.connect port). Independent of the CHAT_*/API
// sub-agent engine above — disjoint message namespace, its own listeners. The
// iframe bridge's tool-readback is parsed in-frame and posted as
// BROWSER_AGENT_TOOLS, so this does NOT register a second api-listen receiver
// (chat-api already owns that with continueListenTurn).
installBrowserAgent();

// ── Listen-mode tab driver ───────────────────────────────────────────────────
//
// Listen platforms (qwen/chatgpt) don't fetch from the SW. The sidebar drives a
// background AI tab: we find or open one for the platform, then ask its content
// script to enable the listen relay and DOM-submit the message. The page sends
// its own authenticated request; the teed response flows back through the listen
// receiver. One tab is reused per platform across a conversation's turns.
const LISTEN_TAB_URLS: Record<string, { match: string[]; open: string }> = {
  qwen: { match: ['*://chat.qwen.ai/*', '*://qwen.ai/*', '*://*.qwen.ai/*', '*://*.qwenlm.ai/*'], open: 'https://chat.qwen.ai/' },
  chatgpt: { match: ['*://chatgpt.com/*', '*://*.chatgpt.com/*', '*://chat.openai.com/*'], open: 'https://chatgpt.com/' },
};
// Only tabs WE created are tracked here. Never adopt the user's own AI tabs:
// DOM-submitting into one would append the sidebar conversation into whatever
// chat the user has open (the "sidebar shares the page's conversation" bug).
// Persisted in chrome.storage.session so an SW restart doesn't orphan the tab.
const listenTabByPlatform = new Map<string, number>();

async function restoreListenTabs(): Promise<void> {
  if (listenTabByPlatform.size > 0) return;
  const stored = await chrome.storage.session.get(['listenTabs']).catch(() => ({} as any));
  const saved = stored?.listenTabs as Record<string, number> | undefined;
  if (!saved) return;
  for (const [p, id] of Object.entries(saved)) listenTabByPlatform.set(p, id);
}

function persistListenTabs(): void {
  const obj: Record<string, number> = {};
  listenTabByPlatform.forEach((id, p) => { obj[p] = id; });
  chrome.storage.session.set({ listenTabs: obj }).catch(() => undefined);
}

async function ensureListenTab(platform: string, fresh: boolean): Promise<number | null> {
  const cfg = LISTEN_TAB_URLS[platform];
  if (!cfg) return null;
  await restoreListenTabs();
  const pinned = listenTabByPlatform.get(platform);
  if (pinned != null) {
    const alive = await chrome.tabs.get(pinned).catch(() => null);
    if (alive) {
      if (fresh) {
        // New sidebar conversation → point the dedicated tab at a new chat so
        // we never continue the previous one.
        await chrome.tabs.update(pinned, { url: cfg.open });
        await waitForTabComplete(pinned, 30000).catch(() => undefined);
      }
      return pinned;
    }
    listenTabByPlatform.delete(platform);
    persistListenTabs();
  }
  // Open a dedicated background tab (active:false → user stays in the sidebar).
  // The keep-alive shim (page-bridge) keeps the background tab streaming.
  const tab = await chrome.tabs.create({ url: cfg.open, active: false });
  if (tab.id == null) return null;
  listenTabByPlatform.set(platform, tab.id);
  persistListenTabs();
  await waitForTabComplete(tab.id, 30000).catch(() => undefined);
  return tab.id;
}

setListenSendHook(async (platform, text, opts) => {
  const tabId = await ensureListenTab(platform, opts?.fresh === true);
  if (tabId == null) return { ok: false, error: `无法为 ${platform} 找到或打开页面` };
  // Poll-send: the content script may not be ready right after a fresh open.
  const deadline = Date.now() + 30000;
  let lastError = 'content script not ready';
  while (Date.now() < deadline) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'CHAT_LISTEN_SEND', text });
      if (resp?.ok === true) return { ok: true };
      lastError = resp?.error || 'page did not accept the message';
      if (resp && resp.ok === false && lastError !== 'content script not ready') break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, error: lastError };
});

async function focusSenderTab(sender: chrome.runtime.MessageSender, options?: { forceFocus?: boolean }): Promise<{ ok: boolean }> {
  // Default: do NOT steal window focus. Only activate tab if explicitly requested.
  // This respects the user's current workflow (e.g., working in terminal/IDE).
  const shouldFocus = options?.forceFocus === true;
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };

  if (shouldFocus) {
    const windowId = sender.tab?.windowId;
    if (typeof windowId === 'number' && windowId >= 0) {
      // Focus the window WITHOUT forcing state:'normal' — that would yank a
      // fullscreen/maximized browser back to a floating window on every tool
      // inject (the "工具调用就给我干成非全屏" bug). Just bring it to front.
      await chrome.windows.update(windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } else {
    // Lightweight activation: just mark tab as active without stealing window focus
    await chrome.tabs.update(tabId, { active: true });
  }
  return { ok: true };
}
