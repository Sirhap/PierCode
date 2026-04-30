import { FENCE_RE, TOOL_RE, parseJsonFenceToolCall, parseXmlToolCall, tryParseToolJSON } from '../parser';
import { extractMonacoText, getPlatformAdapter, PlatformAdapter } from '../platform-adapters';
import { resolveAutoExecute } from '../settings';
import { initWsLinker } from './ws-linker';

// 获取当前平台适配器
const platformAdapter: PlatformAdapter = getPlatformAdapter();

const MONACO_ID_ATTR = 'data-openlink-monaco-id';
const MONACO_REQUEST = 'OPENLINK_MONACO_TEXT_REQUEST';
const MONACO_RESPONSE = 'OPENLINK_MONACO_TEXT_RESPONSE';

let pageBridgeInjected = false;
let monacoIdSeq = 0;
let monacoRequestSeq = 0;

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

function normalizeCodeText(text: string): string {
  return text.replace(/\u00A0/g, ' ').trim();
}

function requestMonacoModelText(container: Element, visibleText: string): Promise<string | null> {
  const monacoEl = container.querySelector<HTMLElement>('.monaco-editor');
  if (!monacoEl) return Promise.resolve(null);

  let domId = monacoEl.getAttribute(MONACO_ID_ATTR);
  if (!domId) {
    domId = `openlink-monaco-${Date.now()}-${++monacoIdSeq}`;
    monacoEl.setAttribute(MONACO_ID_ATTR, domId);
  }

  injectPageBridge();
  const requestId = `openlink-monaco-request-${Date.now()}-${++monacoRequestSeq}`;

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
    if (el.dataset.openlinkClicked === '1') return;
    el.dataset.openlinkClicked = '1';
    el.click();
    clicked = true;
  });
  return clicked;
}

function isContextValid(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function checkContext(): boolean {
  if (isContextValid()) return true;
  document.querySelectorAll('[data-openlink-key]').forEach(el => el.remove());
  const btn = document.querySelector('button[style*="z-index:99999"]');
  if (btn) {
    (btn as HTMLButtonElement).disabled = true;
    (btn as HTMLButtonElement).textContent = '🔗 请刷新页面';
    (btn as HTMLButtonElement).style.background = '#666';
  }
  return false;
}

function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

function getNativeSetter() {
  return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
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
  stopBtn: string | null;
  fillMethod: FillMethod;
  useObserver: boolean;
  responseSelector?: string;
}

function getSiteConfig(): SiteConfig {
  const h = location.hostname;
  // 优先使用平台适配器的 responseSelector
  const adapterSelector = platformAdapter.responseSelector;

  if (h.includes('kimi.com'))
    return { editor: 'div.chat-input-editor[contenteditable="true"]', sendBtn: 'div.send-button-container', stopBtn: null, fillMethod: 'execCommand', useObserver: true, responseSelector: adapterSelector || '.segment-assistant' };
  if (h.includes('chat.z.ai'))
    return { editor: 'textarea#chat-input', sendBtn: 'button#send-message-button', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: adapterSelector || '#response-content-container' };
  if (h.includes('gemini.google.com'))
    return { editor: 'div.ql-editor[contenteditable="true"]', sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: true, responseSelector: adapterSelector || 'model-response, .model-response-text, message-content' };
  if (h.includes('qwen.ai') || h.includes('qwenlm.ai'))
    return { editor: 'textarea.message-input-textarea', sendBtn: 'button.send-button', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: adapterSelector || '.qwen-chat-message-assistant' };
  // Default: AI Studio
  return { editor: 'textarea[placeholder*="Start typing a prompt"]', sendBtn: 'button.ctrl-enter-submits.ms-button-primary[type="submit"], button[aria-label*="Run"]', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: adapterSelector || 'ms-chat-turn' };
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();

  if (platformAdapter.name === 'qwen') {
    injectPageBridge();
  }
  initWsLinker();

  if (!cfg.useObserver) {
    injectPageScript('injected.js');
  } else if (cfg.responseSelector) {
    const sel = cfg.responseSelector;
    if (document.body) startDOMObserver(sel);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(sel));
  }

  if (document.body) injectInitButton();
  else document.addEventListener('DOMContentLoaded', injectInitButton);

  function mountInputListener() {
    const editorEl = querySelectorFirst(cfg.editor);
    if (editorEl) {
      attachInputListener(editorEl as HTMLElement);
    } else {
      const obs = new MutationObserver(() => {
        const el = querySelectorFirst(cfg.editor);
        if (el) { obs.disconnect(); attachInputListener(el as HTMLElement); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function getConversationId(): string {
  const m = location.pathname.match(/\/chat\/([^/?#]+)/) || location.search.match(/[?&]id=([^&]+)/);
  return m ? m[1] : '__default__';
}

function isExecuted(key: string): boolean {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    return !!store[key];
  } catch { return false; }
}

const TTL = 7 * 24 * 60 * 60 * 1000;

function markExecuted(key: string): void {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - store[k] > TTL) delete store[k];
    }
    store[key] = now;
    localStorage.setItem('openlink_executed', JSON.stringify(store));
  } catch {}
}

async function executeToolCallRaw(toolCall: any): Promise<string> {
  if (!checkContext()) return '扩展已失效，请刷新页面';
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return '请先在插件中配置 API 地址';
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await bgFetch(`${apiUrl}/exec`, { method: 'POST', headers, body: JSON.stringify(toolCall) });
  if (response.status === 401) return '认证失败，请在插件中重新输入 Token';
  if (!response.ok) return `[OpenLink 错误] HTTP ${response.status}`;
  const result = JSON.parse(response.body);
  const output = result.output || result.error || '[OpenLink] 空响应';
  const name = result.name || toolCall.name || '';
  const callId = result.callId || result.call_id || toolCall.callId || toolCall.call_id || '';
  return name ? `### ${name} #${callId}\n${output}` : output;
}

async function executeToolCallReturn(toolCall: any): Promise<{ output: string; stopStream: boolean }> {
  if (!checkContext()) return { output: '扩展已失效，请刷新页面', stopStream: false };
  if (toolCall.name === 'question') {
    const q: string = toolCall.args?.question ?? '';
    const rawOpts = toolCall.args?.options;
    const opts: string[] = parseOptions(rawOpts);
    const answer = opts.length > 0 ? await showQuestionPopup(q, opts) : (prompt(q) ?? '');
    return { output: answer, stopStream: false };
  }

  try {
    if (!checkContext()) return { output: '扩展已失效，请刷新页面', stopStream: false };
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    if (!apiUrl) return { output: '请先在插件中配置 API 地址', stopStream: false };

    const response = await bgFetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) return { output: '认证失败，请在插件中重新输入 Token', stopStream: false };
    if (!response.ok) return { output: `[OpenLink 错误] HTTP ${response.status}`, stopStream: false };

    const result = JSON.parse(response.body);
    return {
      output: result.output || result.error || '[OpenLink] 空响应',
      stopStream: !!result.stopStream
    };
  } catch (error) {
    return { output: `[OpenLink 错误] ${error}`, stopStream: false };
  }
}

function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>) {
  // Find stable anchor: message-content's parent, which Angular doesn't rebuild
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return;

  // Prevent duplicate cards
  if (anchor.querySelector(`[data-openlink-key="${CSS.escape(key)}"]`)) return;

  const args = data.args || {};
  const card = document.createElement('div');
  card.setAttribute('data-openlink-key', key);
  card.style.cssText = 'border:1px solid #444;border-radius:8px;padding:12px;margin:8px 0;background:#1e1e2e;color:#cdd6f4;font-size:13px';

  const header = document.createElement('div');
  header.style.cssText = 'font-weight:bold;margin-bottom:8px';
  header.append(document.createTextNode(`🔧 ${data.name} `));
  const callId = document.createElement('span');
  callId.style.cssText = 'color:#888;font-size:11px';
  callId.textContent = `#${data.callId || ''}`;
  header.appendChild(callId);
  card.appendChild(header);

  const argsBox = document.createElement('div');
  argsBox.style.cssText = 'margin:8px 0;background:#181825;border-radius:6px;padding:8px';
  for (const [k, v] of Object.entries(args)) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:4px';
    const keyLabel = document.createElement('span');
    keyLabel.style.cssText = 'color:#89b4fa;font-size:11px';
    keyLabel.textContent = k;
    row.appendChild(keyLabel);
    const val = document.createElement('div');
    val.style.cssText = 'color:#cdd6f4;font-size:12px;font-family:monospace;white-space:pre-wrap;max-height:80px;overflow-y:auto';
    val.textContent = typeof v === 'string' ? v : JSON.stringify(v);
    row.appendChild(val);
    argsBox.appendChild(row);
  }
  card.appendChild(argsBox);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px';
  const execBtn = document.createElement('button');
  execBtn.textContent = '执行';
  execBtn.style.cssText = 'padding:4px 12px;background:#1677ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px';
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '忽略';
  skipBtn.style.cssText = 'padding:4px 12px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;cursor:pointer;font-size:12px';
  btnRow.appendChild(execBtn);
  btnRow.appendChild(skipBtn);
  card.appendChild(btnRow);

  execBtn.onclick = async () => {
    execBtn.disabled = true;
    execBtn.textContent = '执行中...';
    markExecuted(key);
    try {
      const text = await executeToolCallRaw(data);
      const resultBox = document.createElement('div');
      resultBox.style.cssText = 'margin-top:10px;background:#181825;border-radius:6px;padding:8px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:12px;color:#cdd6f4;white-space:pre-wrap';
      resultBox.textContent = text;
      const insertBtn = document.createElement('button');
      insertBtn.textContent = '插入到对话';
      insertBtn.style.cssText = 'margin-top:6px;padding:4px 12px;background:#313244;color:#89b4fa;border:1px solid #89b4fa;border-radius:6px;cursor:pointer;font-size:12px';
      insertBtn.onclick = () => fillAndSend(text, true);
      card.appendChild(resultBox);
      card.appendChild(insertBtn);
      execBtn.textContent = '✅ 已执行';
    } catch {
      execBtn.textContent = '❌ 执行失败';
      execBtn.disabled = false;
    }
  };

  skipBtn.onclick = () => { card.remove(); processed.delete(key); markExecuted(key); };

  anchor.insertBefore(card, messageContent);
}

function startDOMObserver(_responseSelector: string) {
  const processed = new Set<string>();
  let autoExecute: boolean | null = null;
  const pendingAutoExecute = new Map<string, { data: any; key: string }>();
  chrome.storage.local.get(['autoExecute']).then(r => {
    autoExecute = resolveAutoExecute(r.autoExecute);
    flushPendingAutoExecute();
  }).catch(() => {
    autoExecute = false;
    pendingAutoExecute.clear();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('autoExecute' in changes) {
      autoExecute = resolveAutoExecute(changes.autoExecute.newValue);
      flushPendingAutoExecute();
    }
  });

  // ── 批量自动执行 ──────────────────────────────────────────────────────────
  let pendingBatch: any[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let batchExecuting = false;
  let batchWaitMs = 1500;
  chrome.storage.local.get(['batchWaitMs']).then(r => { if (r.batchWaitMs) batchWaitMs = r.batchWaitMs; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    if ('batchWaitMs' in changes) batchWaitMs = changes.batchWaitMs!.newValue ?? 1500;
  });

  function scheduleToBatch(toolCall: any, key: string) {
    pendingBatch.push({ data: toolCall, key });
    // 如果有批次正在执行中，不启动新计时器，等当前批次完成后统一处理
    if (batchExecuting) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      executeBatch();
    }, batchWaitMs);
  }

  async function executeBatch() {
    batchTimer = null;
    batchExecuting = true;
    const batch = pendingBatch;
    pendingBatch = [];
    if (batch.length === 0) { batchExecuting = false; return; }

    let combinedOutput = '';

    for (const item of batch) {
      const { data: toolCall, key } = item;
      if (isExecuted(key)) continue;
      markExecuted(key);

      // 更新卡片状态为"执行中..."
      const cardEl = document.querySelector(`[data-openlink-key="${CSS.escape(key)}"]`);
      const btnEl = cardEl?.querySelector('button') as HTMLButtonElement | null;
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = '执行中...'; }

      const { output, stopStream } = await executeToolCallReturn(toolCall);
      if (combinedOutput) combinedOutput += '\n\n';
      const callId = toolCall.callId || toolCall.call_id || '';
      combinedOutput += `### ${toolCall.name} #${callId}\n${output}`;

      // 更新卡片状态为"已执行"
      if (btnEl) btnEl.textContent = '✅ 已执行';

      if (stopStream) {
        clickStopButton();
        showToast('✅ 文件已写入成功，已停止生成');
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (combinedOutput) {
      fillAndSend(combinedOutput, true);
    }

    // 当前批次执行完毕，如果期间有新工具调用累积，继续执行
    batchExecuting = false;
    if (pendingBatch.length > 0) {
      batchTimer = setTimeout(() => {
        executeBatch();
      }, batchWaitMs);
    }
  }

  function maybeScheduleAutoExecute(toolCall: any, key: string) {
    if (isExecuted(key)) return;
    if (autoExecute === true) {
      scheduleToBatch(toolCall, key);
    } else if (autoExecute === null) {
      pendingAutoExecute.set(key, { data: toolCall, key });
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
      if (!isExecuted(item.key)) scheduleToBatch(item.data, item.key);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const qwenOverflowNotified = new Set<string>();

  function notifyQwenOverflowOnce(codeText: string): void {
    const key = String(hashStr(codeText.slice(0, 500)));
    if (qwenOverflowNotified.has(key)) return;
    qwenOverflowNotified.add(key);
    showToast('Qwen 工具代码块被 Show more 省略，正在等待完整内容', 5000);
  }

  async function scanText(text: string, sourceEl?: Element) {
    const lower = text.toLowerCase();

    // ── Phase 0: 直接从 DOM 提取 tool 代码块（Qwen Monaco Editor 专用） ──
    if (sourceEl && platformAdapter.name === 'qwen') {
      const toolPres = sourceEl.querySelectorAll('pre.qwen-markdown-code');
      for (const pre of toolPres) {
        const toolBody = pre.querySelector('.qwen-markdown-code-body.tool, .qwen-markdown-code-body.openlink-tool');
        if (!toolBody) continue;

        let extraction = extractMonacoText(toolBody);
        let codeText = extraction.text;

        if (extraction.hasOverflow) {
          const modelText = await requestMonacoModelText(toolBody, codeText);
          if (modelText) {
            codeText = modelText;
            extraction = { text: modelText, hasOverflow: false };
          } else {
            const clicked = clickQwenOverflowPlaceholders(toolBody);
            if (clicked) {
              setTimeout(() => scheduleScan(sourceEl), 300);
            }
            notifyQwenOverflowOnce(codeText);
            continue;
          }
        }

        // 流式渲染中：内容可能不完整，静默跳过等下次 Observer 触发再解析
        if (!codeText.trim().endsWith('}')) {
          continue;
        }
        const data = parseJsonFenceToolCall(codeText) || tryParseToolJSON(codeText);
        if (!data) {
          if (extraction.hasOverflow) {
            notifyQwenOverflowOnce(codeText);
            continue;
          }
          console.warn('[OpenLink] Qwen DOM提取解析失败:', codeText);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const key = data.callId ? `${convId}:${data.name}:${data.callId}` : String(hashStr(codeText));
        if (processed.has(key)) continue;
        console.log('[OpenLink] 提取到工具调用(Qwen DOM):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, codeText, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key);
        }
      }
      // Qwen 已通过 DOM 直接提取，不再走文本解析
      return;
    }

    // ── Phase 0b: 直接从 DOM 提取 tool 代码块（Chat Z CodeMirror6 专用） ──
    if (sourceEl && platformAdapter.name === 'chatz') {
      const toolContainers = sourceEl.querySelectorAll('.language-openlink-tool, .language-tool');
      for (const container of toolContainers) {
        // 从 CodeMirror6 提取文本
        const cmContent = container.querySelector('.cm-content');
        if (!cmContent) continue;

        const lines: string[] = [];
        for (const line of cmContent.querySelectorAll('.cm-line')) {
          lines.push(line.textContent || '');
        }
        const codeText = lines.join('\n').replace(/\u00A0/g, ' ').trim();

        // 流式渲染中：内容可能不完整，静默跳过等下次 Observer 触发再解析
        if (!codeText.trim().endsWith('}')) {
          continue;
        }
        const data = parseJsonFenceToolCall(codeText) || tryParseToolJSON(codeText);
        if (!data) {
          console.warn('[OpenLink] Chat Z DOM提取解析失败:', codeText);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const key = data.callId ? `${convId}:${data.name}:${data.callId}` : String(hashStr(codeText));
        if (processed.has(key)) continue;
        console.log('[OpenLink] 提取到工具调用(Chat Z DOM):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, codeText, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key);
        }
      }
      // Chat Z 已通过 DOM 直接提取，不再走文本解析
      return;
    }

    // ── Phase 1: JSON 围栏格式（优先） ──
    if (lower.includes('```openlink-tool') || lower.includes('```tool')) {
      FENCE_RE.lastIndex = 0;
      let fenceMatch;
      while ((fenceMatch = FENCE_RE.exec(text)) !== null) {
        const jsonStr = fenceMatch[1];
        // 清理 fence 内容：去除不可见字符和非断空格，去除首尾空白
        const cleanedJsonStr = jsonStr.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
        // 流式渲染中：内容可能不完整，静默跳过
        if (!cleanedJsonStr.endsWith('}')) {
          continue;
        }
        const data = parseJsonFenceToolCall(cleanedJsonStr) || tryParseToolJSON(cleanedJsonStr);
        if (!data) {
          console.warn('[OpenLink] JSON 围栏解析失败:', cleanedJsonStr);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const key = data.callId ? `${convId}:${data.name}:${data.callId}` : String(hashStr(fenceMatch[0]));
        if (processed.has(key)) continue;
        console.log('[OpenLink] 提取到工具调用(JSON):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, fenceMatch[0], sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key);
        } else {
          if (isExecuted(key)) continue;
          processed.add(key);
          scheduleToBatch(data, key);
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
          console.warn('[OpenLink] 工具调用解析失败:', full);
          showToast('工具调用格式错误，请检查 AI 输出是否正确', 5000);
          continue;
        }
        const convId = getConversationId();
        const key = data.callId ? `${convId}:${data.name}:${data.callId}` : String(hashStr(full));
        if (processed.has(key)) continue;
        console.log('[OpenLink] 提取到工具调用(XML):', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, full, sourceEl, key, processed);
          maybeScheduleAutoExecute(data, key);
        } else {
          if (isExecuted(key)) continue;
          processed.add(key);
          scheduleToBatch(data, key);
        }
      }
    }
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
    const mc = findResponseContainer(el);
    if (mc) scheduleScan(mc);
  }

  function findResponseContainer(el: Element | null): Element | null {
    while (el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'message-content') return el;
      if (tag === 'ms-chat-turn') return el;
      if (el.matches?.('.qwen-chat-message-assistant')) return el;
      if (el.matches?.('#response-content-container')) return el;
      if (el.matches?.('.segment-assistant')) return el;
      if (el.id === 'response-content-container') return el;
      el = el.parentElement;
    }
    return null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingContainers = new Set<Element>();

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
      }, 3000);
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
    }, 800);
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const container = findResponseContainer((mutation.target as Text).parentElement);
        if (container) scheduleScan(container);
      } else {
        mutation.addedNodes.forEach(scanNode);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // Initial scan for already-rendered tool calls (e.g. after page refresh)
  requestAnimationFrame(() => {
    document.querySelectorAll('message-content, ms-chat-turn, .qwen-chat-message-assistant, #response-content-container, .segment-assistant').forEach(el => {
      scanText(getCleanText(el), el);
    });
  });
}

function injectInitButton() {
  const btn = document.createElement('button');
  btn.textContent = '🔗 初始化';
  btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:99999;padding:8px 14px;background:#1677ff;color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  btn.onclick = sendInitPrompt;
  document.body.appendChild(btn);
}

async function bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }> {
  if (!checkContext()) return { ok: false, status: 0, body: 'Extension context invalidated, please refresh the page' };
  return chrome.runtime.sendMessage({ type: 'FETCH', url, options });
}

async function sendInitPrompt() {
  if (!checkContext()) return;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) { alert('请先在插件中配置 API 地址'); return; }
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await bgFetch(`${apiUrl}/prompt`, { headers });
  if (!resp.ok) { alert('获取初始化提示词失败'); return; }

  if (location.hostname.includes('aistudio.google.com')) {
    await fillAiStudioSystemInstructions(resp.body);
    return;
  }

  fillAndSend(resp.body, true);
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
    const nativeInputValueSetter = getNativeSetter();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    if (nativeInputValueSetter) nativeInputValueSetter.call(ta, next);
    else ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (fillMethod === 'prosemirror') {
    const current = editor.innerText.trim();
    editor.textContent = current ? current + '\n' + result : result;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (autoSend) {
    if (!checkContext()) return;
    const cfg = await chrome.storage.local.get(['autoSend', 'delayMin', 'delayMax']);
    if (cfg.autoSend === false) return;

    const min = (cfg.delayMin ?? 1) * 1000;
    const max = (cfg.delayMax ?? 4) * 1000;
    const delay = Math.random() * (max - min) + min;

    showCountdownToast(delay, () => {
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) {
          const ed = querySelectorFirst(editorSel);
          if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return;
        }
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

// ── 斜杠命令 / @ 文件补全 ──────────────────────────────────────────────────────

let skillsCache: Array<{ name: string; description: string }> | null = null;
let skillsCacheTime = 0;
const filesCache = new Map<string, { ts: number; files: string[] }>();
const FILES_TTL = 5000;

async function fetchSkills(): Promise<Array<{ name: string; description: string }>> {
  if (!checkContext()) return [];
  if (skillsCache && Date.now() - skillsCacheTime < 30000) return skillsCache;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await bgFetch(`${apiUrl}/skills`, { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    skillsCache = data.skills || [];
    skillsCacheTime = Date.now();
    return skillsCache!;
  } catch { return []; }
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
  popup.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:4px;min-width:240px;max-width:400px;max-height:240px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.5)';

  let activeIdx = 0;
  const rows: HTMLElement[] = [];

  function render() {
    popup.innerHTML = '';
    rows.length = 0;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 12px;color:#6c7086;font-size:12px';
      empty.textContent = '无匹配项';
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = `padding:6px 12px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:2px;background:${i === activeIdx ? '#313244' : 'transparent'}`;
      const label = document.createElement('span');
      label.style.cssText = 'color:#cdd6f4;font-size:13px';
      label.textContent = item.label;
      row.appendChild(label);
      if (item.sub) {
        const sub = document.createElement('span');
        sub.style.cssText = 'color:#6c7086;font-size:11px';
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
      rows[activeIdx].style.background = '#313244';
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

function replaceTokenInEditor(el: HTMLElement, token: string, replacement: string, fillMethod: string) {
  if (fillMethod === 'value') {
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
  } else if (fillMethod === 'execCommand' || fillMethod === 'prosemirror') {
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

function attachInputListener(editorEl: HTMLElement) {
  const { fillMethod } = getSiteConfig();
  let destroyPicker: (() => void) | null = null;
  let inputVersion = 0;

  function dismiss() {
    if (destroyPicker) { destroyPicker(); destroyPicker = null; }
  }

  editorEl.addEventListener('input', async () => {
    const currentVersion = ++inputVersion;
    const text = getEditorText(editorEl);
    const pos = getCaretPosition(editorEl);
    const before = text.slice(0, pos);

    const slashMatch = before.match(/(?:^|[\s\n\u00a0])(\/([\w-]*))$/);
    if (slashMatch) {
      const token = slashMatch[1];
      const query = slashMatch[2].toLowerCase();
      const skills = await fetchSkills();
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
          value: `\`\`\`openlink-tool\n{"name":"skill","call_id":"${Math.random().toString(36).slice(2,8)}","args":{"skill":"${s.name}"}}\n\`\`\``,
        })),
        (xml) => { replaceTokenInEditor(editorEl, token, xml, fillMethod); dismiss(); },
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
  });
}
