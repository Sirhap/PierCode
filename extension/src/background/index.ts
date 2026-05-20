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
  if (msg.type === 'FOCUS_SELF') {
    focusSenderTab(_sender)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

async function focusSenderTab(sender: chrome.runtime.MessageSender): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };

  const windowId = sender.tab?.windowId;
  if (typeof windowId === 'number' && windowId >= 0) {
    await chrome.windows.update(windowId, { focused: true, state: 'normal' });
  }
  await chrome.tabs.update(tabId, { active: true });
  return { ok: true };
}
