import { browserRelayWsUrl, isAiPageUrl } from './browser-relay-utils';

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
const attachedTabs = new Set<number>();
const perTabQueues = new Map<number, Promise<unknown>>();

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

function sendBrowserMessage(payload: unknown): boolean {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return false;
  browserWs.send(JSON.stringify(payload));
  return true;
}

function sendBrowserResult(result: BrowserResult) {
  sendBrowserMessage(result);
}

function queueBrowserCommand<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = perTabQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  perTabQueues.set(tabId, next.finally(() => {
    if (perTabQueues.get(tabId) === next) perTabQueues.delete(tabId);
  }));
  return next;
}

async function connectBrowserRelay() {
  const seq = ++browserConnectionSeq;
  const info = await getAuthInfo();
  if (!info) {
    setBrowserRelayStatus({ state: 'not_configured' });
    return;
  }
  const wsUrl = browserRelayWsUrl(info.apiUrl, info.token);
  if (!wsUrl) {
    setBrowserRelayStatus({ state: 'error', lastError: 'invalid browser relay URL' });
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
      capabilities: ['cdp', 'tabs', 'selectorRect'],
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
        const key = typeof msg.tabId === 'number' ? msg.tabId : 0;
        queueBrowserCommand(key, () => handleBrowserCommand(msg))
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
    const delays = [1000, 3000, 5000, 10000, 30000];
    const delay = delays[Math.min(browserReconnectAttempt++, delays.length - 1)];
    if (browserReconnectTimer) clearTimeout(browserReconnectTimer);
    browserReconnectTimer = setTimeout(() => connectBrowserRelay(), delay);
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
  const result = await chrome.debugger.sendCommand({ tabId: msg.tabId }, `${msg.domain}.${msg.method}`, params);
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
      return createControlledTab(typeof params.url === 'string' ? params.url : 'about:blank');
    case 'getTab':
      return tabToDTO(await chrome.tabs.get(Number(params.tabId)));
    case 'resolveSelectorRect':
      return resolveSelectorRect(Number(params.tabId), String(params.selector || ''));
    default:
      throw new Error(`unknown PierCode browser method: ${method}`);
  }
}

async function listBrowserTabs(includeAiPages: boolean): Promise<{ tabs: ReturnType<typeof tabToDTO>[] }> {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter(tab => tab.id && tab.url && (includeAiPages || !isAiPageUrl(tab.url)))
      .map(tabToDTO),
  };
}

async function createControlledTab(url: string) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  if (!tab.id) throw new Error('created tab has no id');
  controlledTabId = tab.id;
  await waitForTabComplete(tab.id, 30000).catch(() => undefined);
  const fresh = await chrome.tabs.get(tab.id);
  setBrowserRelayStatus({ state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed' });
  return tabToDTO(fresh);
}

async function ensureAttached(tabId: number) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
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

async function resolveSelectorRect(tabId: number, selector: string) {
  if (!selector) throw new Error('selector is required');
  await ensureAttached(tabId);
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
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
  if (msg.type === 'FOCUS_SELF') {
    // FOCUS_SELF from content script: default to non-intrusive mode
    focusSenderTab(_sender, { forceFocus: msg.forceFocus === true })
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number') {
    attachedTabs.delete(source.tabId);
    sendBrowserMessage({ type: 'browser_event', event: 'debugger_detached', tabId: source.tabId, reason });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId);
  perTabQueues.delete(tabId);
  if (controlledTabId === tabId) {
    controlledTabId = null;
    setBrowserRelayStatus({ state: browserWs?.readyState === WebSocket.OPEN ? 'open' : 'closed' });
  }
  sendBrowserMessage({ type: 'browser_event', event: 'tab_removed', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (controlledTabId !== tabId) return;
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    sendBrowserMessage({
      type: 'browser_event',
      event: 'tab_updated',
      tabId,
      url: tab.url || '',
      title: tab.title || '',
    });
  }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && (changes.apiUrl || changes.authToken || changes.authPort)) {
    connectBrowserRelay();
  }
});

connectBrowserRelay();

async function focusSenderTab(sender: chrome.runtime.MessageSender, options?: { forceFocus?: boolean }): Promise<{ ok: boolean }> {
  // Default: do NOT steal window focus. Only activate tab if explicitly requested.
  // This respects the user's current workflow (e.g., working in terminal/IDE).
  const shouldFocus = options?.forceFocus === true;
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };

  if (shouldFocus) {
    const windowId = sender.tab?.windowId;
    if (typeof windowId === 'number' && windowId >= 0) {
      await chrome.windows.update(windowId, { focused: true, state: 'normal' });
    }
    await chrome.tabs.update(tabId, { active: true });
  } else {
    // Lightweight activation: just mark tab as active without stealing window focus
    await chrome.tabs.update(tabId, { active: true });
  }
  return { ok: true };
}
