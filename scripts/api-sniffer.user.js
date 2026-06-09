// ==UserScript==
// @name         PierCode API Sniffer - Full Chain Fixed
// @namespace    piercode
// @version      5.2.0
// @description  抓取 AI 平台接口调用全链路：fetch/XHR/WebSocket/sendBeacon、入参、请求头、响应头、状态码、耗时、SSE/tool_calls、调用栈，并支持 PierCode tools 注入测试
// @match        https://chat.qwen.ai/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://www.kimi.com/*
// @match        https://kimi.com/*
// @match        https://chat.z.ai/*
// @match        https://aistudio.xiaomimimo.com/*
// @match        https://aistudio.google.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    MAX_BODY: 20000,
    MAX_STREAM_BODY: 50000,
    MAX_LOGS: 1000,
    MAX_STACK: 3500,
    MAX_WS_MESSAGES: 80,
    CAPTURE_FETCH: true,
    CAPTURE_XHR: true,
    CAPTURE_WEBSOCKET: true,
    CAPTURE_BEACON: true,
    CAPTURE_STATIC: false,
    ONLY_AI_HOSTS: false,
    REDACT_SENSITIVE: true,
    SHOW_PANEL_ON_START: true,
    TOOLS_INJECTION_DEFAULT: false,
    REALTIME_RENDER_INTERVAL: 250
  };

  const EXCLUDE_RE = /\.(css|js|png|jpe?g|svg|gif|woff2?|ttf|ico|map|webp|avif|mp4|webm|mp3|wav|pdf)(\?|$)/i;
  const EXCLUDE_HOSTS = /google-analytics|googletagmanager|sentry|datadog|analytics|doubleclick|facebook|hotjar|segment|amplitude|mixpanel|intercom|crisp|drift|clarity|fullstory/i;
  const AI_HOSTS = /chat\.qwen\.ai|chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|kimi\.com|chat\.z\.ai|aistudio\.xiaomimimo\.com|aistudio\.google\.com/i;
  const SENSITIVE_KEY_RE = /authorization|cookie|set-cookie|x-api-key|api-key|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|session|csrf|xsrf|cf_clearance|bearer|jwt|id_token/i;

  const PIERCODE_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the local filesystem. Returns file content with line numbers.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or relative file path' },
            offset: { type: 'number', description: 'Start line number, 0-based' },
            limit: { type: 'number', description: 'Max lines to read' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List directory contents. Returns files and subdirectories.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exec_cmd',
        description: 'Execute a shell command and return stdout/stderr.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file, creating or overwriting it.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents with a regular expression.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern' },
            path: { type: 'string', description: 'Directory or file to search' }
          },
          required: ['pattern']
        }
      }
    }
  ];

  let toolsInjectionEnabled = CONFIG.TOOLS_INJECTION_DEFAULT;
  let captureEnabled = true;
  let seqId = 0;
  let panel = null;
  let logContainer = null;
  let statsEl = null;
  let injectBtn = null;
  let pauseBtn = null;
  let renderTimer = null;

  const logs = [];

  function nowText() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
  }

  function uid() {
    seqId += 1;
    return seqId;
  }

  function trunc(value, max) {
    if (value == null) return '';
    const text = typeof value === 'string' ? value : String(value);
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n…[truncated: ${text.length} chars]`;
  }

  function safeJSON(text) {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  // ---- Encoding helpers (avoid mojibake from binary/protobuf/non-utf8 bodies) ----

  const TEXT_CT_RE = /text\/|json|javascript|ecmascript|xml|html|x-www-form-urlencoded|event-stream|graphql|csv|\+json|\+xml/i;
  const BINARY_CT_RE = /protobuf|octet-stream|grpc|msgpack|cbor|x-protobuf|image\/|audio\/|video\/|font\/|application\/zip|application\/gzip|application\/wasm|application\/pdf/i;

  // Pull charset out of a content-type header; default utf-8.
  function charsetFromContentType(ct) {
    const m = /charset=["']?([\w-]+)/i.exec(String(ct || ''));
    return m ? m[1].toLowerCase() : 'utf-8';
  }

  function isTextContentType(ct) {
    const s = String(ct || '');
    if (BINARY_CT_RE.test(s)) return false;
    if (TEXT_CT_RE.test(s)) return true;
    return false; // unknown → treat as binary, decide by sniffing bytes
  }

  // Heuristic: does a decoded string look like garbage (lots of replacement chars / control bytes)?
  function looksLikeMojibake(text) {
    if (!text) return false;
    const sample = text.length > 2000 ? text.slice(0, 2000) : text;
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      // U+FFFD replacement char, or C0 control chars except \t \n \r
      if (code === 0xfffd || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) bad++;
    }
    return bad / sample.length > 0.05;
  }

  // Decode an ArrayBuffer/typed-array with the right charset; fall back to hex preview if binary.
  function decodeBuffer(buffer, contentType) {
    try {
      const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
        : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : null;
      if (!bytes) return String(buffer);
      const ct = String(contentType || '');
      if (BINARY_CT_RE.test(ct)) return hexPreview(bytes, ct);

      const charset = charsetFromContentType(ct);
      let text;
      try {
        text = new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch (_) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
      // If unknown CT and the decode looks like garbage, show hex instead.
      if (!isTextContentType(ct) && looksLikeMojibake(text)) return hexPreview(bytes, ct);
      return text;
    } catch (err) {
      return `[decode failed: ${err.message}]`;
    }
  }

  function hexPreview(bytes, contentType) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const n = Math.min(view.length, 64);
    let hex = '';
    for (let i = 0; i < n; i++) hex += view[i].toString(16).padStart(2, '0') + (i % 2 ? ' ' : '');
    return `[binary ${contentType || 'data'}: ${view.length} bytes]\n${hex.trim()}${view.length > n ? ' …' : ''}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseURL(url) {
    try {
      return new URL(url, location.href);
    } catch (_) {
      return null;
    }
  }

  function shouldCapture(url) {
    if (!captureEnabled || !url) return false;
    const parsed = parseURL(url);
    const urlText = parsed ? parsed.href : String(url);
    const host = parsed ? parsed.hostname : '';

    if (!CONFIG.CAPTURE_STATIC && EXCLUDE_RE.test(urlText)) return false;
    if (EXCLUDE_HOSTS.test(host)) return false;
    if (CONFIG.ONLY_AI_HOSTS && !AI_HOSTS.test(host)) return false;
    return true;
  }

  function getStack() {
    const stack = new Error().stack || '';
    return trunc(
      stack
        .split('\n')
        .slice(2)
        .filter(line => !line.includes('PierCode API Sniffer'))
        .join('\n'),
      CONFIG.MAX_STACK
    );
  }

  function normalizeHeaders(headers) {
    const out = {};
    if (!headers) return out;

    try {
      if (headers instanceof Headers) {
        headers.forEach((value, key) => {
          out[key] = value;
        });
        return redactHeaders(out);
      }
    } catch (_) {}

    if (Array.isArray(headers)) {
      for (const item of headers) {
        if (Array.isArray(item) && item.length >= 2) out[String(item[0]).toLowerCase()] = String(item[1]);
      }
      return redactHeaders(out);
    }

    if (typeof headers === 'object') {
      for (const key of Object.keys(headers)) out[key.toLowerCase()] = String(headers[key]);
      return redactHeaders(out);
    }

    return out;
  }

  function parseRawHeaders(raw) {
    const out = {};
    if (!raw) return out;
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return redactHeaders(out);
  }

  function redactHeaders(headers) {
    if (!CONFIG.REDACT_SENSITIVE) return headers || {};
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : value;
    }
    return out;
  }

  function redactJSON(value, keyHint) {
    if (!CONFIG.REDACT_SENSITIVE) return value;
    if (keyHint && SENSITIVE_KEY_RE.test(String(keyHint))) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(item => redactJSON(item));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) out[key] = redactJSON(val, key);
      return out;
    }
    return value;
  }

  function redactBodyText(text) {
    if (!CONFIG.REDACT_SENSITIVE || typeof text !== 'string') return text;
    const parsed = safeJSON(text);
    if (parsed) return JSON.stringify(redactJSON(parsed), null, 2);
    return text
      .replace(/(authorization|cookie|x-api-key|api-key|token|access_token|refresh_token|secret|password|csrf|xsrf)(["'\s:=]+)([^&\s,"'}]+)/gi, '$1$2[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, '$1[REDACTED]');
  }

  function bodyToPreview(body, contentType) {
    if (body == null) return Promise.resolve('');
    if (typeof body === 'string') return Promise.resolve(body);
    if (body instanceof URLSearchParams) return Promise.resolve(body.toString());
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const rows = [];
      for (const [key, value] of body.entries()) {
        rows.push(`${key}=${value instanceof File ? `[File ${value.name}, ${value.size} bytes]` : String(value)}`);
      }
      return Promise.resolve(rows.join('&'));
    }
    // Blob: decode via the right charset; binary blobs show hex, not mojibake.
    if (body instanceof Blob) {
      const ct = contentType || body.type || '';
      if (BINARY_CT_RE.test(ct)) {
        return body.arrayBuffer().then(buf => decodeBuffer(buf, ct)).catch(() => `[Blob ${body.size} bytes]`);
      }
      return body.arrayBuffer().then(buf => decodeBuffer(buf, ct)).catch(() => '[Blob read failed]');
    }
    if (body instanceof ArrayBuffer) return Promise.resolve(decodeBuffer(body, contentType));
    if (ArrayBuffer.isView(body)) return Promise.resolve(decodeBuffer(body, contentType));
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return Promise.resolve('[ReadableStream body: not consumed]');
    return Promise.resolve(String(body));
  }

  async function readFetchRequestBody(input, init) {
    const reqCT = getFetchHeaders(input, init)['content-type'] || '';
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return bodyToPreview(init.body, reqCT);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      try {
        // Decode raw bytes with the declared charset; binary CT → hex preview.
        const buffer = await input.clone().arrayBuffer();
        return decodeBuffer(buffer, reqCT);
      } catch (err) {
        return `[Request body read failed: ${err.message}]`;
      }
    }
    return '';
  }

  function getFetchURL(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  }

  function getFetchMethod(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function getFetchHeaders(input, init) {
    const headers = {};
    if (typeof Request !== 'undefined' && input instanceof Request) Object.assign(headers, normalizeHeaders(input.headers));
    if (init && init.headers) Object.assign(headers, normalizeHeaders(init.headers));
    return redactHeaders(headers);
  }

  function analyzeRequestBody(bodyText) {
    const raw = trunc(redactBodyText(bodyText || ''), CONFIG.MAX_BODY);
    const parsed = safeJSON(bodyText || '');
    const info = {
      bodyRaw: raw,
      model: null,
      msgCount: 0,
      msgRoles: [],
      tools: [],
      toolChoice: null
    };

    if (!parsed || typeof parsed !== 'object') return info;

    info.model = parsed.model || parsed.model_name || parsed.modelName || null;
    if (Array.isArray(parsed.messages)) {
      info.msgCount = parsed.messages.length;
      info.msgRoles = parsed.messages.map(msg => msg && msg.role).filter(Boolean);
    }

    const toolList = parsed.tools || parsed.functions || parsed.available_tools || [];
    if (Array.isArray(toolList)) {
      info.tools = toolList.map(tool => tool?.function?.name || tool?.name || tool?.id || tool?.type).filter(Boolean);
    }
    info.toolChoice = parsed.tool_choice || parsed.function_call || null;
    return info;
  }

  function createBaseEntry(kind, method, url, req) {
    return {
      id: uid(),
      kind,
      ts: nowText(),
      startedAt: performance.now(),
      durationMs: null,
      method,
      url,
      req: req || {},
      res: null,
      status: null,
      ok: null,
      injected: false,
      error: null,
      stack: getStack(),
      wsMessages: []
    };
  }

  function parseSSE(text) {
    const events = [];
    let eventName = '';
    let dataLines = [];

    function flush() {
      if (!dataLines.length) {
        eventName = '';
        return;
      }
      const data = dataLines.join('\n');
      events.push({ event: eventName || 'message', data });
      eventName = '';
      dataLines = [];
    }

    for (const line of String(text || '').split(/\r?\n/)) {
      if (line === '') {
        flush();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    flush();
    return events;
  }

  function collectToolCalls(value, result, seen) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (value.function_call) result.push(value.function_call);
    if (Array.isArray(value.tool_calls)) result.push(...value.tool_calls);

    if (value.type === 'tool_use') result.push(value);
    if (value.type === 'function_call') result.push(value);
    if (value.name && (value.arguments || value.input) && !Array.isArray(value)) {
      if (value.type === 'tool_use' || value.type === 'function' || value.call_id || value.id) result.push(value);
    }
    if (value.functionCall) result.push(value.functionCall);
    if (value.function_call_response) result.push(value.function_call_response);

    for (const child of Object.values(value)) collectToolCalls(child, result, seen);
  }

  function normalizeToolCallName(toolCall) {
    return toolCall?.function?.name || toolCall?.name || toolCall?.functionCall?.name || toolCall?.tool_name || toolCall?.id || '?';
  }

  function normalizeToolCallArgs(toolCall) {
    const args = toolCall?.function?.arguments ?? toolCall?.arguments ?? toolCall?.input ?? toolCall?.args ?? toolCall?.functionCall?.args ?? '';
    return typeof args === 'string' ? args : JSON.stringify(args);
  }

  function analyzeResponseBody(bodyText, contentType) {
    const rawText = String(bodyText || '');
    const bodyRaw = trunc(redactBodyText(rawText), contentType && /event-stream|stream/i.test(contentType) ? CONFIG.MAX_STREAM_BODY : CONFIG.MAX_BODY);
    const info = {
      bodyRaw,
      contentType: contentType || '',
      toolCalls: [],
      finishReason: null,
      phases: [],
      sseEvents: 0
    };

    const parsed = safeJSON(rawText);
    if (parsed) {
      collectToolCalls(parsed, info.toolCalls, new WeakSet());
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        if (choice.finish_reason) info.finishReason = choice.finish_reason;
        if (choice.delta?.phase) info.phases.push(choice.delta.phase);
      }
      return compactResponseInfo(info);
    }

    const events = parseSSE(rawText);
    info.sseEvents = events.length;
    for (const ev of events) {
      if (!ev.data || ev.data === '[DONE]') continue;
      const json = safeJSON(ev.data);
      if (!json) continue;
      collectToolCalls(json, info.toolCalls, new WeakSet());

      if (json.phase) info.phases.push(json.phase);
      if (json.type) info.phases.push(json.type);
      if (Array.isArray(json.choices)) {
        for (const choice of json.choices) {
          if (choice.finish_reason) info.finishReason = choice.finish_reason;
          if (choice.delta?.phase) info.phases.push(choice.delta.phase);
        }
      }
      if (json.delta?.phase) info.phases.push(json.delta.phase);
    }
    return compactResponseInfo(info);
  }

  function compactResponseInfo(info) {
    const seen = new Set();
    info.toolCalls = info.toolCalls.filter(call => {
      const key = JSON.stringify([normalizeToolCallName(call), normalizeToolCallArgs(call)]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    info.phases = [...new Set(info.phases.filter(Boolean))];
    return info;
  }

  function maybeInjectTools(input, init, bodyText, entry) {
    if (!toolsInjectionEnabled || entry.method !== 'POST' || !bodyText) return null;

    const parsed = safeJSON(bodyText);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.messages)) return null;
    if (parsed.tools || parsed.functions) return null;

    parsed.tools = PIERCODE_TOOLS;
    const newBody = JSON.stringify(parsed);
    entry.injected = true;
    entry.req.analysis = analyzeRequestBody(newBody);

    if (typeof Request !== 'undefined' && input instanceof Request) {
      const request = new Request(input, { body: newBody });
      return [request, init || {}];
    }
    return [input, Object.assign({}, init || {}, { body: newBody })];
  }

  function scheduleRender() {
    if (!panel || !logContainer) return;
    if (renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      renderFiltered();
    }, CONFIG.REALTIME_RENDER_INTERVAL);
  }

  function addEntry(entry) {
    logs.push(entry);
    while (logs.length > CONFIG.MAX_LOGS) logs.shift();
    ensurePanel();
    scheduleRender();
  }

  function updateEntry(entry, patch) {
    Object.assign(entry, patch || {});
    scheduleRender();
  }

  function buildExportText() {
    return logs.map(entry => JSON.stringify(redactJSON(entry), null, 2)).join('\n' + '─'.repeat(100) + '\n');
  }

  function ensurePanel() {
    if (panel || !CONFIG.SHOW_PANEL_ON_START) return;
    if (!document.body) {
      window.setTimeout(ensurePanel, 50);
      return;
    }
    createPanel();
  }

  function createPanel() {
    if (panel || !document.body) return;

    const style = document.createElement('style');
    style.textContent = `
      #pc-sniffer, #pc-sniffer * { box-sizing: border-box; }
      #pc-sniffer { position: fixed; right: 8px; bottom: 8px; width: 680px; height: 560px; background: #0d1117; color: #c9d1d9; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; z-index: 2147483647; display: flex; flex-direction: column; border: 1px solid #30363d; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.6); }
      #pc-sniffer button { all: unset; background: #21262d; color: #58a6ff; padding: 3px 8px; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; font-size: 11px; }
      #pc-sniffer button:hover { filter: brightness(1.2); }
      #pc-sniffer input[type="text"] { all: unset; flex: 1; background: #0d1117; color: #c9d1d9; padding: 4px 6px; border: 1px solid #30363d; border-radius: 4px; font-size: 11px; }
      #pc-sniffer .pc-log { border-bottom: 1px solid #222; padding: 6px 0; cursor: pointer; }
      #pc-sniffer .pc-log:hover { background: rgba(255,255,255,.03); }
      #pc-sniffer .pc-badge { display: inline-block; padding: 0 4px; border-radius: 2px; font-size: 10px; color: #000; margin-left: 3px; }
      #pc-sniffer details { margin-top: 4px; }
      #pc-sniffer summary { cursor: pointer; color: #8b949e; }
      #pc-sniffer pre { white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow-y: auto; color: #8b949e; background: #05070b; padding: 6px; border-radius: 4px; }
    `;
    document.documentElement.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'pc-sniffer';
    panel.innerHTML = `
      <div id="pc-hdr" style="padding:7px 10px;background:#161b22;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;cursor:move;user-select:none">
        <span style="color:#58a6ff;font-weight:bold">🔍 PierCode API Sniffer v5.2</span>
        <div style="display:flex;gap:5px;align-items:center">
          <button data-act="pause">⏸ 暂停</button>
          <button data-act="inject">🔧 Tools注入: OFF</button>
          <button data-act="copy">复制</button>
          <button data-act="clear" style="color:#f85149">清空</button>
          <button data-act="close" style="color:#f85149">×</button>
        </div>
      </div>
      <div style="padding:6px 10px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:8px;align-items:center">
        <input id="pc-search" type="text" placeholder="搜索 url/body/header/tool/status...">
        <label style="font-size:11px;color:#8b949e;display:flex;align-items:center;gap:4px"><input type="checkbox" id="pc-onlypost" checked> 仅POST/WS/Beacon</label>
      </div>
      <div id="pc-body" style="flex:1;overflow-y:auto;padding:4px 10px"></div>
      <div style="padding:5px 10px;background:#161b22;border-top:1px solid #30363d;font-size:11px;color:#8b949e;display:flex;justify-content:space-between">
        <span id="pc-stats">0 requests</span>
        <span id="pc-platform">detecting...</span>
      </div>
    `;
    document.body.appendChild(panel);

    logContainer = panel.querySelector('#pc-body');
    statsEl = panel.querySelector('#pc-stats');
    injectBtn = panel.querySelector('[data-act="inject"]');
    pauseBtn = panel.querySelector('[data-act="pause"]');

    bindPanelEvents();
    updatePlatformLabel();
    updateButtons();
    renderFiltered();
  }

  function bindPanelEvents() {
    const hdr = panel.querySelector('#pc-hdr');
    const copyBtn = panel.querySelector('[data-act="copy"]');

    panel.querySelector('[data-act="close"]').onclick = () => {
      panel.style.display = 'none';
    };
    panel.querySelector('[data-act="clear"]').onclick = () => {
      logs.length = 0;
      renderFiltered();
    };
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(buildExportText());
        copyBtn.textContent = '✓ 已复制';
        window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1000);
      } catch (err) {
        copyBtn.textContent = '复制失败';
        console.warn('[PierCode Sniffer] clipboard failed:', err);
      }
    };
    injectBtn.onclick = () => {
      toolsInjectionEnabled = !toolsInjectionEnabled;
      updateButtons();
    };
    pauseBtn.onclick = () => {
      captureEnabled = !captureEnabled;
      updateButtons();
    };

    panel.querySelector('#pc-search').oninput = renderFiltered;
    panel.querySelector('#pc-onlypost').onchange = renderFiltered;

    let dragging = false;
    let dx = 0;
    let dy = 0;
    hdr.addEventListener('mousedown', event => {
      if (event.target.closest('button,input,label')) return;
      dragging = true;
      dx = event.clientX - panel.offsetLeft;
      dy = event.clientY - panel.offsetTop;
      event.preventDefault();
    });
    document.addEventListener('mousemove', event => {
      if (!dragging) return;
      panel.style.left = `${event.clientX - dx}px`;
      panel.style.top = `${event.clientY - dy}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function updateButtons() {
    if (injectBtn) {
      injectBtn.textContent = `🔧 Tools注入: ${toolsInjectionEnabled ? 'ON' : 'OFF'}`;
      injectBtn.style.color = toolsInjectionEnabled ? '#3fb950' : '#8b949e';
      injectBtn.style.borderColor = toolsInjectionEnabled ? '#3fb950' : '#30363d';
      injectBtn.style.background = toolsInjectionEnabled ? '#0a1a0a' : '#21262d';
    }
    if (pauseBtn) {
      pauseBtn.textContent = captureEnabled ? '⏸ 暂停' : '▶ 继续';
      pauseBtn.style.color = captureEnabled ? '#58a6ff' : '#f85149';
    }
    updateStats();
  }

  function updatePlatformLabel() {
    const h = location.hostname;
    const el = panel.querySelector('#pc-platform');
    if (!el) return;
    if (h.includes('qwen')) el.textContent = '🟢 Qwen';
    else if (h.includes('chatgpt') || h.includes('openai')) el.textContent = '🟢 ChatGPT';
    else if (h.includes('claude')) el.textContent = '🟢 Claude';
    else if (h.includes('gemini')) el.textContent = '🟢 Gemini';
    else if (h.includes('kimi')) el.textContent = '🟢 Kimi';
    else if (h.includes('z.ai')) el.textContent = '🟢 ChatZ';
    else if (h.includes('xiaomimimo')) el.textContent = '🟢 MiMo';
    else el.textContent = `🌐 ${h}`;
  }

  function updateStats() {
    if (!statsEl) return;
    const total = logs.length;
    const pending = logs.filter(item => !item.res && !item.error && item.kind !== 'websocket').length;
    statsEl.textContent = `${total} logs${pending ? ` · ${pending} pending` : ''}${toolsInjectionEnabled ? ' · 🔧 tools注入ON' : ''}${captureEnabled ? '' : ' · 已暂停'}`;
  }

  function shouldRenderEntry(entry, query, onlyPost) {
    if (onlyPost && !['POST', 'WEBSOCKET', 'BEACON'].includes(entry.method)) return false;
    if (!query) return true;
    return JSON.stringify(entry).toLowerCase().includes(query);
  }

  function renderFiltered() {
    if (!logContainer) return;
    const query = (panel.querySelector('#pc-search')?.value || '').toLowerCase();
    const onlyPost = !!panel.querySelector('#pc-onlypost')?.checked;
    logContainer.textContent = '';

    for (const entry of logs) {
      if (!shouldRenderEntry(entry, query, onlyPost)) continue;
      logContainer.appendChild(renderLog(entry));
    }
    logContainer.scrollTop = logContainer.scrollHeight;
    updateStats();
  }

  function renderBadge(text, bg, color) {
    return `<span class="pc-badge" style="background:${bg};color:${color || '#000'}">${escapeHtml(text)}</span>`;
  }

  function shortURL(url) {
    const parsed = parseURL(url);
    if (!parsed) return trunc(url, 90);
    return parsed.pathname + parsed.search;
  }

  function renderLog(entry) {
    const hasReqTools = entry.req?.analysis?.tools?.length > 0;
    const hasResTools = entry.res?.toolCalls?.length > 0;
    const statusColor = entry.error ? '#f85149' : (entry.status >= 400 ? '#f85149' : '#3fb950');

    let badges = '';
    badges += renderBadge(entry.kind, '#30363d', '#c9d1d9');
    if (entry.status != null) badges += renderBadge(String(entry.status), statusColor, '#000');
    if (entry.injected) badges += renderBadge('INJECTED', '#f0883e');
    if (hasReqTools) badges += renderBadge(`REQ_TOOLS(${entry.req.analysis.tools.length})`, '#3fb950');
    if (hasResTools) badges += renderBadge(`TOOL_CALL(${entry.res.toolCalls.length})`, '#d29922');
    if (entry.error) badges += renderBadge('ERROR', '#f85149');

    const div = document.createElement('div');
    div.className = 'pc-log';
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span style="color:#8b949e;min-width:84px">${escapeHtml(entry.ts)}</span>
        <span style="color:#7ee787;min-width:74px;font-weight:bold">${escapeHtml(entry.method)}</span>
        <span title="${escapeHtml(entry.url)}" style="color:#c9d1d9;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(shortURL(entry.url))}</span>
        <span style="white-space:nowrap">${badges}</span>
      </div>
      <div style="display:flex;gap:8px;color:#8b949e;font-size:10px;margin-top:2px">
        <span>${entry.durationMs == null ? 'pending' : `${Math.round(entry.durationMs)} ms`}</span>
        ${entry.req?.analysis?.model ? `<span>model: ${escapeHtml(entry.req.analysis.model)}</span>` : ''}
        ${entry.res?.sseEvents ? `<span>SSE: ${entry.res.sseEvents}</span>` : ''}
      </div>
      <div class="pc-detail" style="display:none;margin-top:6px;padding:6px;background:#0a0d14;border-radius:4px;font-size:10px;word-break:break-word"></div>
    `;
    div.addEventListener('click', () => {
      const detail = div.querySelector('.pc-detail');
      if (detail.style.display === 'none') {
        detail.style.display = '';
        detail.innerHTML = formatDetail(entry);
      } else {
        detail.style.display = 'none';
      }
    });
    return div;
  }

  function formatObjectBlock(title, obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj || {}, null, 2);
    return `<details open><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(text)}</pre></details>`;
  }

  function formatDetail(entry) {
    let out = '';
    out += `<div><span style="color:#79c0ff">${escapeHtml(entry.method)}</span> <span style="color:#c9d1d9">${escapeHtml(entry.url)}</span></div>`;
    if (entry.status != null) out += `<div>status: <b>${escapeHtml(entry.status)}</b> · ok: ${escapeHtml(entry.ok)} · duration: ${escapeHtml(Math.round(entry.durationMs || 0))} ms</div>`;
    if (entry.injected) out += '<div style="color:#f0883e;font-weight:bold">⚠️ Tools 参数已注入到请求体</div>';
    if (entry.error) out += `<div style="color:#f85149">ERROR: ${escapeHtml(entry.error)}</div>`;

    out += '<div style="height:6px"></div><div style="color:#79c0ff">📤 Request</div>';
    if (entry.req?.analysis) {
      const a = entry.req.analysis;
      if (a.model) out += `<div>model: ${escapeHtml(a.model)}</div>`;
      if (a.msgCount) out += `<div>messages: ${escapeHtml(a.msgCount)} (${escapeHtml(a.msgRoles.join(', '))})</div>`;
      if (a.tools?.length) out += `<div>tools: ${escapeHtml(a.tools.join(', '))}</div>`;
      if (a.toolChoice) out += `<div>tool_choice: ${escapeHtml(JSON.stringify(a.toolChoice))}</div>`;
    }
    out += formatObjectBlock('Request headers', entry.req?.headers || {});
    if (entry.req?.analysis?.bodyRaw) out += formatObjectBlock('Request body', entry.req.analysis.bodyRaw);

    if (entry.res) {
      out += '<div style="height:6px"></div><div style="color:#79c0ff">📥 Response</div>';
      out += formatObjectBlock('Response headers', entry.res.headers || {});
      if (entry.res.finishReason) out += `<div>finish_reason: ${escapeHtml(entry.res.finishReason)}</div>`;
      if (entry.res.phases?.length) out += `<div>phases: ${escapeHtml(entry.res.phases.join(' → '))}</div>`;
      if (entry.res.toolCalls?.length) {
        out += `<div style="color:#d29922;font-weight:bold">🔔 TOOL CALLS (${entry.res.toolCalls.length})</div>`;
        for (const call of entry.res.toolCalls) {
          out += `<div>→ <span style="color:#d29922">${escapeHtml(normalizeToolCallName(call))}</span>(${escapeHtml(trunc(normalizeToolCallArgs(call), 600))})</div>`;
        }
      }
      if (entry.res.bodyRaw) out += formatObjectBlock('Response body', entry.res.bodyRaw);
    }

    if (entry.wsMessages?.length) out += formatObjectBlock('WebSocket messages', entry.wsMessages);
    if (entry.stack) out += formatObjectBlock('Call stack', entry.stack);
    return out;
  }

  function installFetchHook() {
    if (!CONFIG.CAPTURE_FETCH || typeof window.fetch !== 'function' || window.fetch.__pcSnifferPatched) return;

    const nativeFetch = window.fetch;

    async function pcFetch(input, init) {
      const url = getFetchURL(input);
      const method = getFetchMethod(input, init);
      if (!shouldCapture(url)) return nativeFetch.apply(this, arguments);

      const bodyText = await readFetchRequestBody(input, init);
      const entry = createBaseEntry('fetch', method, url, {
        headers: getFetchHeaders(input, init),
        analysis: analyzeRequestBody(bodyText)
      });

      let finalArgs = [input, init];
      const injectedArgs = maybeInjectTools(input, init, bodyText, entry);
      if (injectedArgs) finalArgs = injectedArgs;

      addEntry(entry);

      try {
        const response = await nativeFetch.apply(this, finalArgs);
        entry.status = response.status;
        entry.ok = response.ok;
        entry.durationMs = performance.now() - entry.startedAt;
        entry.res = {
          headers: normalizeHeaders(response.headers),
          bodyRaw: '[response body pending]',
          contentType: response.headers.get('content-type') || '',
          toolCalls: [],
          finishReason: null,
          phases: [],
          sseEvents: 0
        };
        scheduleRender();

        captureFetchResponseBody(response.clone(), entry);
        return response;
      } catch (err) {
        updateEntry(entry, {
          durationMs: performance.now() - entry.startedAt,
          error: err && err.message ? err.message : String(err)
        });
        throw err;
      }
    }

    pcFetch.__pcSnifferPatched = true;
    pcFetch.__nativeFetch = nativeFetch;
    window.fetch = pcFetch;
  }

  async function captureFetchResponseBody(clone, entry) {
    try {
      const contentType = clone.headers.get('content-type') || '';
      let text = '';
      // Read raw bytes and decode with the declared charset; binary CT → hex preview.
      // Avoids mojibake from non-utf8 text and from protobuf/octet-stream bodies.
      const buffer = await clone.arrayBuffer();
      text = decodeBuffer(buffer, contentType);
      const analysis = analyzeResponseBody(text, contentType);
      analysis.headers = normalizeHeaders(clone.headers);
      updateEntry(entry, { res: analysis, durationMs: performance.now() - entry.startedAt });
    } catch (err) {
      if (!entry.res) entry.res = {};
      entry.res.bodyRaw = `[response read failed: ${err.message}]`;
      updateEntry(entry, { durationMs: performance.now() - entry.startedAt });
    }
  }

  function installXHRHook() {
    if (!CONFIG.CAPTURE_XHR || typeof XMLHttpRequest === 'undefined' || XMLHttpRequest.prototype.open.__pcSnifferPatched) return;

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__pcSniffer = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        headers: {}
      };
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__pcSnifferPatched = true;

    XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
      if (this.__pcSniffer) this.__pcSniffer.headers[String(key).toLowerCase()] = String(value);
      return nativeSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const meta = this.__pcSniffer || { method: 'GET', url: '' };
      if (!shouldCapture(meta.url)) return nativeSend.apply(this, arguments);

      const entry = createBaseEntry('xhr', meta.method, meta.url, {
        headers: redactHeaders(meta.headers || {}),
        analysis: { bodyRaw: '[pending]' }
      });
      addEntry(entry);

      bodyToPreview(body, (meta.headers && meta.headers['content-type']) || '').then(text => {
        entry.req.analysis = analyzeRequestBody(text);
        scheduleRender();
      });

      this.addEventListener('loadend', () => {
        const contentType = this.getResponseHeader('content-type') || '';
        let responseText = '';
        try {
          const rt = this.responseType;
          if (rt === 'arraybuffer' && this.response) {
            // Decode bytes with the right charset; binary CT → hex preview.
            responseText = decodeBuffer(this.response, contentType);
          } else if (rt === 'json') {
            responseText = JSON.stringify(this.response);
          } else if (rt === 'blob' && this.response) {
            responseText = `[Blob ${this.response.type || contentType || 'unknown'}, ${this.response.size} bytes]`;
          } else if (rt === '' || rt === 'text') {
            // responseText is already a decoded JS string; if the server sent a
            // non-utf8 charset the browser handled it. Guard against mojibake.
            responseText = this.responseText || '';
            if (!isTextContentType(contentType) && looksLikeMojibake(responseText)) {
              responseText = `[binary XHR response: ${contentType || 'unknown'}, ${responseText.length} chars]`;
            }
          } else {
            responseText = `[XHR responseType=${rt}]`;
          }
        } catch (err) {
          responseText = `[XHR response read failed: ${err.message}]`;
        }
        const res = analyzeResponseBody(responseText, contentType);
        res.headers = parseRawHeaders(this.getAllResponseHeaders());
        updateEntry(entry, {
          status: this.status,
          ok: this.status >= 200 && this.status < 300,
          durationMs: performance.now() - entry.startedAt,
          res
        });
      });

      return nativeSend.apply(this, arguments);
    };
  }

  function installBeaconHook() {
    if (!CONFIG.CAPTURE_BEACON || !navigator.sendBeacon || navigator.sendBeacon.__pcSnifferPatched) return;

    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    function pcBeacon(url, data) {
      if (!shouldCapture(url)) return nativeBeacon(url, data);

      const entry = createBaseEntry('beacon', 'BEACON', String(url), {
        headers: {},
        analysis: { bodyRaw: '[pending]' }
      });
      addEntry(entry);

      bodyToPreview(data).then(text => {
        entry.req.analysis = analyzeRequestBody(text);
        scheduleRender();
      });

      const ok = nativeBeacon(url, data);
      updateEntry(entry, {
        status: ok ? 'queued' : 'failed',
        ok,
        durationMs: performance.now() - entry.startedAt,
        res: { bodyRaw: `[sendBeacon ${ok ? 'queued' : 'failed'}]`, headers: {}, toolCalls: [], phases: [] }
      });
      return ok;
    }
    pcBeacon.__pcSnifferPatched = true;
    navigator.sendBeacon = pcBeacon;
  }

  function installWebSocketHook() {
    if (!CONFIG.CAPTURE_WEBSOCKET || typeof WebSocket === 'undefined' || WebSocket.__pcSnifferPatched) return;

    const NativeWebSocket = WebSocket;

    function PatchedWebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      if (!shouldCapture(url)) return ws;

      const entry = createBaseEntry('websocket', 'WEBSOCKET', String(url), {
        headers: {},
        analysis: { bodyRaw: protocols ? `protocols=${JSON.stringify(protocols)}` : '' }
      });
      addEntry(entry);

      const nativeSend = ws.send;
      ws.send = function (data) {
        pushWSMessage(entry, 'send', data);
        return nativeSend.apply(ws, arguments);
      };

      ws.addEventListener('open', () => {
        updateEntry(entry, { status: 'open', ok: true, durationMs: performance.now() - entry.startedAt });
      });
      ws.addEventListener('message', event => {
        pushWSMessage(entry, 'recv', event.data);
      });
      ws.addEventListener('error', () => {
        updateEntry(entry, { status: 'error', ok: false, durationMs: performance.now() - entry.startedAt, error: 'WebSocket error' });
      });
      ws.addEventListener('close', event => {
        updateEntry(entry, {
          status: `closed ${event.code}`,
          ok: event.wasClean,
          durationMs: performance.now() - entry.startedAt,
          res: { bodyRaw: `closed: code=${event.code}, reason=${event.reason || ''}`, headers: {}, toolCalls: [], phases: [] }
        });
      });

      return ws;
    }

    PatchedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, NativeWebSocket);
    PatchedWebSocket.__pcSnifferPatched = true;
    window.WebSocket = PatchedWebSocket;
  }

  function pushWSMessage(entry, direction, data) {
    // WS frames carry no content-type. Binary frames (Blob/ArrayBuffer) are
    // typically protobuf/msgpack (Gemini, Kimi); bodyToPreview/decodeBuffer
    // sniff them and emit a hex preview instead of mojibake.
    // Empty CT → decodeBuffer sniffs the bytes: real text decodes, true binary
    // (protobuf/msgpack) falls back to hex. So binary frames that are actually
    // JSON-over-arraybuffer still parse, and protobuf frames don't mojibake.
    bodyToPreview(data, '').then(text => {
      const isBinaryPreview = /^\[binary /.test(text);
      const analysis = isBinaryPreview ? { toolCalls: [], phases: [] } : analyzeResponseBody(text, '');
      entry.wsMessages.push({
        ts: nowText(),
        direction,
        body: trunc(redactBodyText(text), CONFIG.MAX_BODY),
        toolCalls: analysis.toolCalls,
        phases: analysis.phases
      });
      while (entry.wsMessages.length > CONFIG.MAX_WS_MESSAGES) entry.wsMessages.shift();
      if (!entry.res) entry.res = { bodyRaw: '[WebSocket active]', headers: {}, toolCalls: [], phases: [] };
      entry.res.toolCalls = entry.wsMessages.flatMap(msg => msg.toolCalls || []);
      entry.res.phases = [...new Set(entry.wsMessages.flatMap(msg => msg.phases || []))];
      scheduleRender();
    });
  }

  function boot() {
    installFetchHook();
    installXHRHook();
    installBeaconHook();
    installWebSocketHook();
    ensurePanel();

    window.__PierCodeSniffer = {
      logs,
      config: CONFIG,
      tools: PIERCODE_TOOLS,
      clear() {
        logs.length = 0;
        renderFiltered();
      },
      setInjection(enabled) {
        toolsInjectionEnabled = !!enabled;
        updateButtons();
      },
      setCapture(enabled) {
        captureEnabled = !!enabled;
        updateButtons();
      },
      exportText: buildExportText
    };

    console.log('%c[PierCode API Sniffer v5.2] Active', 'color:#58a6ff;font-weight:bold;font-size:14px', location.hostname);
  }

  boot();
})();