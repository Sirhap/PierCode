function parseXmlToolCall(raw: string): any | null {
  const nameMatch = raw.match(/^<tool\s+name="([^"]+)"(?:\s+call_id="([^"]+)")?/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const callId = nameMatch[2] || null;
  const args: Record<string, string> = {};
  const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = paramRe.exec(raw)) !== null) args[m[1]] = m[2];
  return { name, args, callId };
}

function tryParseToolJSON(raw: string): any | null {
  try { return JSON.parse(raw); } catch {}
  try {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { result += ch; escaped = false; continue; }
      if (ch === '\\') { result += ch; escaped = true; continue; }
      if (ch === '"') {
        if (!inString) { inString = true; result += ch; continue; }
        let j = i + 1;
        while (j < raw.length && raw[j] === ' ') j++;
        const next = raw[j];
        if (next === ':' || next === ',' || next === '}' || next === ']') {
          inString = false; result += ch;
        } else {
          result += '\\"';
        }
        continue;
      }
      result += ch;
    }
    return JSON.parse(result);
  } catch {}
  return null;
}

type FillMethod = 'paste' | 'execCommand' | 'value' | 'prosemirror';

interface SiteConfig {
  editor: string;
  sendBtn: string;
  stopBtn: string | null;
  fillMethod: FillMethod;
  useObserver: boolean;
  responseSelector?: string;
}

function getSiteConfig(): SiteConfig {
  const h = location.hostname;
  if (h.includes('gemini.google.com'))
    return { editor: 'div.ql-editor.textarea.new-input-ui p, .ql-editor p, div[contenteditable="true"]', sendBtn: 'button.mat-mdc-icon-button.send-button, button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: true, responseSelector: 'model-response, .model-response-text, message-content' };
  if (h.includes('chatgpt.com'))
    return { editor: '#prompt-textarea, .ProseMirror[contenteditable="true"]', sendBtn: 'button[data-testid="send-button"], button[aria-label*="Send"]', stopBtn: null, fillMethod: 'prosemirror', useObserver: false };
  if (h.includes('x.com') || h.includes('grok.com'))
    return { editor: 'textarea[aria-label="Ask Grok anything"], textarea[placeholder="Ask anything"], textarea', sendBtn: 'button[aria-label="Submit"], button.send-button', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('kimi.com'))
    return { editor: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]', sendBtn: '.send-button, button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('chat.mistral.ai'))
    return { editor: 'div.ProseMirror[contenteditable="true"]', sendBtn: '.ms-auto .flex.gap-2 button[type="submit"], button.bg-state-primary', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('perplexity.ai'))
    return { editor: '#ask-input[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]', sendBtn: 'button[aria-label="Submit"], button[aria-label="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('openrouter.ai'))
    return { editor: 'textarea[data-testid="composer-input"], textarea[placeholder="Start a new message..."]', sendBtn: 'button[data-testid="send-button"], button[aria-label="Send message"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('qwen.ai'))
    return { editor: 'textarea.message-input-textarea, #chat-input', sendBtn: 'button.omni-button-content-btn, div.message-input-right-button-send button', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('t3.chat'))
    return { editor: 'textarea#chat-input, textarea[placeholder*="Type your message"]', sendBtn: 'button[type="submit"], button[aria-label*="Send"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('aistudio.google.com'))
    return { editor: 'textarea.textarea[placeholder="Start typing a prompt"]', sendBtn: 'button[aria-label*="Run"], button[mattooltip*="Run"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('github.com'))
    return { editor: '#copilot-chat-textarea, textarea[placeholder*="How can I help"]', sendBtn: 'button[aria-labelledby*="Send"], button:has(.octicon-paper-airplane)', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('z.ai'))
    return { editor: '#chat-input', sendBtn: '#send-message-button', stopBtn: null, fillMethod: 'value', useObserver: false };
  // Default: DeepSeek
  return { editor: '[data-slate-editor="true"]', sendBtn: '.operateBtn-JsB9e2:not(.disabled-ZaDDJC)', stopBtn: '.stop-yGpvO2 img', fillMethod: 'paste', useObserver: false };
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();

  if (!cfg.useObserver) {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
  } else if (cfg.responseSelector) {
    const sel = cfg.responseSelector;
    if (document.body) startDOMObserver(sel);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(sel));
  }

  let execQueue = Promise.resolve();
  window.addEventListener('message', (event) => {
    if (event.data.type === 'TOOL_CALL') {
      execQueue = execQueue.then(() => executeToolCall(event.data.data));
    }
  });

  if (document.body) {
    injectInitButton();
  } else {
    document.addEventListener('DOMContentLoaded', injectInitButton);
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function isExecuted(key: string): boolean {
  try {
    const store = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    return !!(store[location.href]?.[key]);
  } catch { return false; }
}

function markExecuted(key: string): void {
  try {
    const store = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    if (!store[location.href]) store[location.href] = {};
    store[location.href][key] = 1;
    localStorage.setItem('openlink_executed', JSON.stringify(store));
  } catch {}
}

function startDOMObserver(_responseSelector: string) {
  const processed = new Set<string>();
  const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/tool>/g;

  function scanText(text: string) {
    if (!text.includes('<tool')) return;
    TOOL_RE.lastIndex = 0;
    let match;
    while ((match = TOOL_RE.exec(text)) !== null) {
      const full = match[0];
      const inner = full.replace(/^<tool[^>]*>|<\/tool>$/g, '').trim();
      const data = parseXmlToolCall(full) || tryParseToolJSON(inner);
      if (!data) { console.warn('[OpenLink] 工具调用解析失败:', full); continue; }
      // Use call_id as dedup key if present, otherwise fall back to content hash
      const key = data.callId ? `${data.name}:${data.callId}` : String(hashStr(full));
      if (processed.has(key) || isExecuted(key)) continue;
      processed.add(key);
      markExecuted(key);
      console.log('[OpenLink] 提取到工具调用:', data);
      window.postMessage({ type: 'TOOL_CALL', data }, '*');
    }
  }

  function scanNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      scanText(node.textContent || '');
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'pre' || tag === 'code') {
        scanText(el.textContent || '');
      } else {
        el.querySelectorAll('pre, code').forEach(c => scanText(c.textContent || ''));
      }
    }
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        scanText(mutation.target.textContent || '');
      } else {
        mutation.addedNodes.forEach(scanNode);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

function injectInitButton() {
  const btn = document.createElement('button');
  btn.textContent = '🔗 初始化';
  btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:99999;padding:8px 14px;background:#1677ff;color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  btn.onclick = sendInitPrompt;
  document.body.appendChild(btn);
}

async function bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }> {
  return chrome.runtime.sendMessage({ type: 'FETCH', url, options });
}

async function sendInitPrompt() {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) { alert('请先在插件中配置 API 地址'); return; }
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await bgFetch(`${apiUrl}/prompt`, { headers });
  if (!resp.ok) { alert('获取初始化提示词失败'); return; }
  fillAndSend(resp.body, true);
}

function showQuestionPopup(question: string, options: string[]): Promise<string> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
    const title = document.createElement('p');
    title.style.cssText = 'margin:0 0 16px;font-size:15px;line-height:1.5;white-space:pre-wrap';
    title.textContent = question;
    box.appendChild(title);
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.textContent = `${i + 1}. ${opt}`;
      btn.style.cssText = 'display:block;width:100%;margin-bottom:8px;padding:10px 14px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:8px;cursor:pointer;font-size:13px;text-align:left';
      btn.onmouseenter = () => { btn.style.background = '#45475a'; };
      btn.onmouseleave = () => { btn.style.background = '#313244'; };
      btn.onclick = () => { overlay.remove(); resolve(opt); };
      box.appendChild(btn);
    });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function executeToolCall(toolCall: any) {
  if (toolCall.name === 'question') {
    const q: string = toolCall.args?.question ?? '';
    const rawOpts = toolCall.args?.options;
    const opts: string[] = Array.isArray(rawOpts) ? rawOpts : (typeof rawOpts === 'string' ? (() => { try { return JSON.parse(rawOpts); } catch { return []; } })() : []);
    const answer = opts.length > 0 ? await showQuestionPopup(q, opts) : (prompt(q) ?? '');
    fillAndSend(answer, false);
    return;
  }

  try {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    if (!apiUrl) { fillAndSend('请先在插件中配置 API 地址', false); return; }

    const response = await bgFetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) { fillAndSend('认证失败，请在插件中重新输入 Token', false); return; }
    if (!response.ok) { fillAndSend(`[OpenLink 错误] HTTP ${response.status}`, false); return; }

    const result = JSON.parse(response.body);
    const text = result.output || result.error || '[OpenLink] 空响应';

    if (result.stopStream) {
      clickStopButton();
      showToast('✅ 文件已写入成功，已停止生成');
      await new Promise(r => setTimeout(r, 600));
      fillAndSend(text, true);
      return;
    }

    fillAndSend(text, true);
  } catch (error) {
    fillAndSend(`[OpenLink 错误] ${error}`, false);
  }
}

function showToast(msg: string, durationMs = 3000): void {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:170px;right:20px;z-index:2147483647;background:#1e1e2e;color:#a6e3a1;border:1px solid #a6e3a1;border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.4)';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

function clickStopButton(): void {
  const stopSel = getSiteConfig().stopBtn;
  if (!stopSel) return;
  const btn = document.querySelector(stopSel) as HTMLElement;
  if (btn) btn.click();
}

function showCountdownToast(ms: number, onFire: () => void): void {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:130px;right:20px;z-index:2147483647;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,0.4)';
  const label = document.createElement('span');
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'background:#313244;color:#f38ba8;border:1px solid #f38ba8;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px';
  toast.appendChild(label);
  toast.appendChild(cancelBtn);
  document.body.appendChild(toast);

  let remaining = Math.ceil(ms / 1000);
  let cancelled = false;
  label.textContent = `${remaining}s 后自动提交`;
  const interval = setInterval(() => {
    remaining--;
    label.textContent = `${remaining}s 后自动提交`;
    if (remaining <= 0) { clearInterval(interval); toast.remove(); if (!cancelled) onFire(); }
  }, 1000);
  cancelBtn.onclick = () => { cancelled = true; clearInterval(interval); toast.remove(); };
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const sel of selectors.split(',').map(s => s.trim())) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

async function fillAndSend(result: string, autoSend = false) {
  const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = getSiteConfig();
  const editor = querySelectorFirst(editorSel);
  if (!editor) return;

  editor.focus();

  if (fillMethod === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (fillMethod === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (fillMethod === 'value') {
    const ta = editor as HTMLTextAreaElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(ta, result);
    else ta.value = result;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (fillMethod === 'prosemirror') {
    editor.innerHTML = result;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (autoSend) {
    const cfg = await chrome.storage.local.get(['autoSend', 'delayMin', 'delayMax']);
    if (cfg.autoSend === false) return;

    const min = (cfg.delayMin ?? 1) * 1000;
    const max = (cfg.delayMax ?? 4) * 1000;
    const delay = Math.random() * (max - min) + min;

    showCountdownToast(delay, () => {
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) return;
        const sendBtn = querySelectorFirst(sendBtnSel);
        if (sendBtn) {
          sendBtn.click();
        } else {
          setTimeout(() => checkAndClick(attempts + 1), 100);
        }
      };
      checkAndClick();
    });
  }
}
