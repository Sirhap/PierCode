const AI_PAGE_URLS = [
  '*://*.gemini.google.com/*',
  '*://aistudio.google.com/*',
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

async function ensureContentScripts(): Promise<{ tabs: number; injected: number; failed: number }> {
  const tabs = await chrome.tabs.query({ url: AI_PAGE_URLS });
  let injected = 0;
  let failed = 0;

  await Promise.all(tabs.map(async tab => {
    if (!tab.id) return;
    try {
      // Check whether the content script has already been loaded by the
      // manifest's content_scripts section. Injecting the same script
      // twice causes "Identifier has already been declared" errors
      // because classic (non-module) content scripts share a global scope.
      const probe = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!(window as any).__PIERCODE_LOADED__,
      });
      if (probe[0]?.result) {
        injected += 1;
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      injected += 1;
    } catch (error) {
      failed += 1;
      console.warn('[PierCode] 注入 AI 页面失败:', tab.url, error);
    }
  }));

  return { tabs: tabs.length, injected, failed };
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
      .catch(error => sendResponse({ tabs: 0, injected: 0, failed: 1, error: String(error) }));
    return true;
  }
  return false;
});
