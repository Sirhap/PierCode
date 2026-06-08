// ==UserScript==
// @name         PierCode API Sniffer + Tools Injection Test
// @namespace    piercode
// @version      4.0
// @description  抓取 AI 平台 API 请求 + 测试注入 tools 参数 + 完整 SSE 流实时解析
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

  // ══════════════════════════════════════════════════════════
  // ── 配置 ──
  // ══════════════════════════════════════════════════════════
  const MAX_BODY = 8000;
  const MAX_LOGS = 500;
  const EXCLUDE_RE = /\.(css|js|png|jpe?g|svg|gif|woff2?|ttf|ico|map|webp|mp4|webm)(\?|$)/i;
  const EXCLUDE_HOSTS = /google-analytics|googletagmanager|sentry|datadog|analytics|doubleclick|facebook|hotjar|segment|amplitude|mixpanel|intercom|crisp|drift/i;

  // ── Tools 注入测试配置 ──
  let toolsInjectionEnabled = false;  // 默认关闭，手动开启

  // 要注入的 PierCode 工具定义（OpenAI function calling 格式）
  const PIERCODE_TOOLS = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the local filesystem. Returns file content with line numbers.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative file path" },
            offset: { type: "number", description: "Start line number (0-based)" },
            limit: { type: "number", description: "Max lines to read" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List directory contents. Returns files and subdirectories.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "exec_cmd",
        description: "Execute a shell command and return stdout/stderr.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" }
          },
          required: ["command"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file, creating or overwriting it.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents with a regular expression.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern" },
            path: { type: "string", description: "Directory or file to search" }
          },
          required: ["pattern"]
        }
      }
    }
  ];

  // ══════════════════════════════════════════════════════════
  // ── 工具函数 ──
  // ══════════════════════════════════════════════════════════
  const logs = [];
  let seqId = 0;
  function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0'); }
  function uid() { return ++seqId; }
  function trunc(s, max) { if (s == null) return ''; s = String(s); return s.length > max ? s.slice(0, max) + `…[${s.length} chars]` : s; }
  function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }
  function shouldCapture(url) {
    if (!url) return false;
    if (EXCLUDE_RE.test(url)) return false;
    try { if (EXCLUDE_HOSTS.test(new URL(url).hostname)) return false; } catch {}
    return true;
  }
  // 读完整个 SSE 流，实时解析每个 data: 行
  async function readSSEStream(stream, onEvent) {
    if (!stream) return { raw: '', events: [] };
    try {
      const reader = stream.getReader();
      const events = [];
      let raw = '';
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = typeof value === 'string' ? value : new TextDecoder().decode(value);
        raw += chunk;
        buffer += chunk;
        // 按行解析 SSE
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 最后一行可能不完整，留到下次
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const json = safeJSON(trimmed.slice(6));
            if (json) {
              events.push(json);
              if (onEvent) onEvent(json);
            }
          }
        }
      }
      return { raw: trunc(raw, MAX_BODY), events };
    } catch { return { raw: '[stream error]', events: [] }; }
  }
  async function extractBody(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;
    if (body instanceof Blob) { try { return await body.text(); } catch { return '[blob err]'; } }
    if (body instanceof ReadableStream) { const r = await readSSEStream(body); return r.raw; }
    try { return String(body); } catch { return ''; }
  }

  // ══════════════════════════════════════════════════════════
  // ── 分析函数 ──
  // ══════════════════════════════════════════════════════════
  function analyzeReq(url, method, bodyStr) {
    const info = { url, method, bodyRaw: bodyStr, model: null, tools: null, msgCount: 0, msgRoles: [] };
    const p = safeJSON(bodyStr);
    if (p) {
      info.model = p.model;
      info.tools = p.tools || p.functions || null;
      if (p.messages) { info.msgCount = p.messages.length; info.msgRoles = p.messages.map(m => m.role); }
    }
    return info;
  }

  function analyzeRes(bodyStr) {
    const info = { bodyRaw: bodyStr, toolCalls: null, finishReason: null, phases: [] };
    // 解析 SSE 流
    const lines = bodyStr.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = safeJSON(line.slice(6));
      if (!json?.choices) continue;
      for (const c of json.choices) {
        if (c.delta?.phase) info.phases.push(c.delta.phase);
        if (c.delta?.function_call) {
          if (!info.toolCalls) info.toolCalls = [];
          info.toolCalls.push(c.delta.function_call);
        }
        if (c.delta?.tool_calls) {
          if (!info.toolCalls) info.toolCalls = [];
          info.toolCalls.push(...c.delta.tool_calls);
        }
        if (c.finish_reason) info.finishReason = c.finish_reason;
        // Anthropic 格式
        if (c.delta?.content && Array.isArray(c.delta.content)) {
          for (const block of c.delta.content) {
            if (block.type === 'tool_use') {
              if (!info.toolCalls) info.toolCalls = [];
              info.toolCalls.push(block);
            }
          }
        }
      }
    }
    // 也检查非 SSE 格式
    const p = safeJSON(bodyStr);
    if (p?.choices) {
      for (const c of p.choices) {
        if (c.message?.tool_calls) { if (!info.toolCalls) info.toolCalls = []; info.toolCalls.push(...c.message.tool_calls); }
        if (c.message?.function_call) { if (!info.toolCalls) info.toolCalls = []; info.toolCalls.push(c.message.function_call); }
      }
    }
    return info;
  }

  // ══════════════════════════════════════════════════════════
  // ── 面板 ──
  let panel = null, logContainer = null, statsEl = null, injectBtn = null;

  function createPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'pc-sniffer';
    panel.style.cssText = `position:fixed;bottom:8px;right:8px;width:580px;height:480px;background:#0d1117;color:#c9d1d9;font:12px/1.4 'SF Mono',Monaco,Consolas,monospace;z-index:2147483647;display:flex;flex-direction:column;border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);`;
    panel.innerHTML = `
      <div id="pc-hdr" style="padding:6px 10px;background:#161b22;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;cursor:move;user-select:none">
        <span style="color:#58a6ff;font-weight:bold;font-size:12px">🔍 PierCode API Sniffer v3</span>
        <div style="display:flex;gap:4px">
          <button data-act="inject" style="all:unset;background:#1a1a2e;color:#888;padding:2px 8px;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:10px">🔧 Tools注入: OFF</button>
          <button data-act="copy" style="all:unset;background:#21262d;color:#58a6ff;padding:2px 8px;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-size:10px">复制</button>
          <button data-act="clear" style="all:unset;background:#21262d;color:#f85149;padding:2px 8px;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-size:10px">清空</button>
          <button data-act="close" style="all:unset;background:#21262d;color:#f85149;padding:2px 8px;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-size:10px">×</button>
        </div>
      </div>
      <div style="padding:4px 10px;background:#161b22;border-bottom:1px solid #30363d;display:flex;gap:6px;align-items:center">
        <input id="pc-search" type="text" placeholder="搜索..." style="all:unset;flex:1;background:#0d1117;color:#c9d1d9;padding:3px 6px;border:1px solid #30363d;border-radius:4px;font-size:11px">
        <label style="font-size:10px;color:#8b949e;display:flex;align-items:center;gap:3px"><input type="checkbox" id="pc-onlypost" checked style="accent-color:#58a6ff"> 仅POST</label>
      </div>
      <div id="pc-body" style="flex:1;overflow-y:auto;padding:4px 10px"></div>
      <div style="padding:4px 10px;background:#161b22;border-top:1px solid #30363d;font-size:10px;color:#8b949e;display:flex;justify-content:space-between">
        <span id="pc-stats">0 requests</span>
        <span id="pc-platform">detecting...</span>
      </div>
    `;
    document.body.appendChild(panel);
    logContainer = document.getElementById('pc-body');
    statsEl = document.getElementById('pc-stats');
    injectBtn = panel.querySelector('[data-act="inject"]');

    // 事件
    const hdr = document.getElementById('pc-hdr');
    hdr.querySelector('[data-act="close"]').onclick = () => panel.style.display = 'none';
    hdr.querySelector('[data-act="clear"]').onclick = () => { logs.length = 0; logContainer.innerHTML = ''; updateStats(); };
    hdr.querySelector('[data-act="copy"]').onclick = () => {
      const text = logs.map(e => { let out = `[${e.ts}] ${e.method} ${e.url}\n`; if (e.req?.bodyRaw) out += `REQ: ${e.req.bodyRaw}\n`; if (e.res?.bodyRaw) out += `RES: ${trunc(e.res.bodyRaw, 3000)}\n`; if (e.injected) out += `⚠️ TOOLS INJECTED\n`; return out; }).join('\n' + '─'.repeat(80) + '\n');
      navigator.clipboard.writeText(text).then(() => { hdr.querySelector('[data-act="copy"]').textContent = '✓'; setTimeout(() => hdr.querySelector('[data-act="copy"]').textContent = '复制', 1000); });
    };

    // Tools 注入开关
    injectBtn.onclick = () => {
      toolsInjectionEnabled = !toolsInjectionEnabled;
      injectBtn.textContent = `🔧 Tools注入: ${toolsInjectionEnabled ? 'ON' : 'OFF'}`;
      injectBtn.style.color = toolsInjectionEnabled ? '#0f0' : '#888';
      injectBtn.style.borderColor = toolsInjectionEnabled ? '#0f0' : '#555';
      injectBtn.style.background = toolsInjectionEnabled ? '#0a1a0a' : '#1a1a2e';
    };

    // 拖拽
    let dragging = false, dx, dy;
    hdr.onmousedown = (e) => { if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return; dragging = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; };
    document.addEventListener('mousemove', (e) => { if (!dragging) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    document.addEventListener('mouseup', () => dragging = false);

    document.getElementById('pc-search').oninput = renderFiltered;
    document.getElementById('pc-onlypost').onchange = renderFiltered;

    const h = location.hostname;
    const plat = document.getElementById('pc-platform');
    if (h.includes('qwen')) plat.textContent = '🟢 Qwen';
    else if (h.includes('chatgpt') || h.includes('openai')) plat.textContent = '🟢 ChatGPT';
    else if (h.includes('claude')) plat.textContent = '🟢 Claude';
    else if (h.includes('gemini')) plat.textContent = '🟢 Gemini';
    else if (h.includes('kimi')) plat.textContent = '🟢 Kimi';
    else if (h.includes('z.ai')) plat.textContent = '🟢 ChatZ';
    else if (h.includes('xiaomimimo')) plat.textContent = '🟢 MiMo';
    else plat.textContent = '🌐 ' + h;
  }

  function updateStats() { if (statsEl) statsEl.textContent = `${logs.length} requests${toolsInjectionEnabled ? ' · 🔧 tools注入ON' : ''}`; }

  function renderFiltered() {
    if (!logContainer) return;
    const q = (document.getElementById('pc-search')?.value || '').toLowerCase();
    const onlyPost = document.getElementById('pc-onlypost')?.checked;
    logContainer.innerHTML = '';
    for (const entry of logs) {
      if (onlyPost && entry.method !== 'POST') continue;
      if (q && !JSON.stringify(entry).toLowerCase().includes(q)) continue;
      logContainer.appendChild(renderLog(entry));
    }
    logContainer.scrollTop = logContainer.scrollHeight;
    updateStats();
  }

  function renderLog(entry) {
    const hasReqTools = entry.req?.tools?.length > 0;
    const hasResTools = entry.res?.toolCalls?.length > 0;
    const injected = entry.injected;

    let badges = '';
    if (injected) badges += ` <span style="background:#f80;color:#000;padding:0 3px;border-radius:2px;font-size:10px">INJECTED</span>`;
    if (hasReqTools) badges += ` <span style="background:#0f0;color:#000;padding:0 3px;border-radius:2px;font-size:10px">TOOLS(${entry.req.tools.length})</span>`;
    if (hasResTools) badges += ` <span style="background:#ff0;color:#000;padding:0 3px;border-radius:2px;font-size:10px">TOOL_CALL(${entry.res.toolCalls.length})</span>`;

    const phases = entry.res?.phases || [];
    if (phases.includes('code_interpreter')) badges += ` <span style="background:#a0f;color:#fff;padding:0 3px;border-radius:2px;font-size:10px">CODE_INTERP</span>`;
    if (phases.includes('thinking_summary')) badges += ` <span style="background:#555;color:#fff;padding:0 3px;border-radius:2px;font-size:10px">THINKING</span>`;

    let urlDisplay = '';
    try { urlDisplay = new URL(entry.url).pathname + (new URL(entry.url).search || ''); } catch { urlDisplay = trunc(entry.url, 60); }

    const div = document.createElement('div');
    div.style.cssText = 'border-bottom:1px solid #222;padding:5px 0;cursor:pointer';
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span style="color:#555;min-width:80px">${entry.ts}</span>
        <span style="color:#0f0;min-width:36px;font-weight:bold">${entry.method}</span>
        <span style="color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${urlDisplay}</span>
        ${badges}
      </div>
      <div class="detail" style="display:none;margin-top:6px;padding:6px;background:#0a0a14;border-radius:4px;font-size:10px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto"></div>
    `;
    div.onclick = () => {
      const detail = div.querySelector('.detail');
      if (detail.style.display === 'none') { detail.style.display = ''; if (!detail._loaded) { detail._loaded = true; detail.innerHTML = formatDetail(entry); } }
      else detail.style.display = 'none';
    };
    return div;
  }

  function formatDetail(e) {
    let out = `<span style="color:#0ff">${e.method}</span> <span style="color:#aaa">${e.url}</span>\n`;
    if (e.injected) out += `<span style="color:#f80;font-weight:bold">⚠️ TOOLS 参数已注入</span>\n`;
    if (e.req) {
      out += `\n<span style="color:#0ff">📤 Request:</span>\n`;
      if (e.req.model) out += `  📌 model: ${e.req.model}\n`;
      if (e.req.tools) out += `  🔧 tools (${e.req.tools.length}): ${e.req.tools.map(t => t.function?.name || t.name).join(', ')}\n`;
      if (e.req.msgCount) out += `  💬 messages: ${e.req.msgCount} (${e.req.msgRoles.join(', ')})\n`;
      const bodyPretty = safeJSON(e.req.bodyRaw) ? JSON.stringify(safeJSON(e.req.bodyRaw), null, 2) : e.req.bodyRaw;
      out += `<details><summary style="color:#555;cursor:pointer">📄 Full request body</summary><pre style="color:#666;max-height:200px;overflow-y:auto">${trunc(bodyPretty, 4000)}</pre></details>\n`;
    }
    if (e.res) {
      out += `\n<span style="color:#0ff">📥 Response:</span>\n`;
      if (e.res.finishReason) out += `  finish_reason: ${e.res.finishReason}\n`;
      if (e.res.phases?.length) out += `  phases: ${[...new Set(e.res.phases)].join(' → ')}\n`;
      if (e.res.toolCalls?.length) {
        out += `  <span style="color:#ff0;font-weight:bold">🔔 TOOL CALLS (${e.res.toolCalls.length}):</span>\n`;
        for (const tc of e.res.toolCalls) {
          const name = tc.function?.name || tc.name || '?';
          const args = tc.function?.arguments || tc.input || tc.arguments || '';
          out += `    → <span style="color:#ff0">${name}</span>(${trunc(typeof args === 'string' ? args : JSON.stringify(args), 300)})\n`;
        }
      }
      out += `<details><summary style="color:#555;cursor:pointer">📄 Response (truncated)</summary><pre style="color:#666;max-height:200px;overflow-y:auto">${trunc(e.res.bodyRaw, 4000)}</pre></details>\n`;
    }
    return out;
  }

  function addEntry(entry) {
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    if (!panel) createPanel();
    if (!logContainer) return;
    const onlyPost = document.getElementById('pc-onlypost')?.checked;
    if (onlyPost && entry.method !== 'POST') { updateStats(); return; }
    logContainer.appendChild(renderLog(entry));
    logContainer.scrollTop = logContainer.scrollHeight;
    updateStats();
  }

  // ══════════════════════════════════════════════════════════
  // ── Fetch 拦截 + Tools 注入 ──
  // ══════════════════════════════════════════════════════════
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();

    if (!shouldCapture(url)) return _fetch.apply(this, args);

    let bodyStr = init?.body ? await extractBody(init.body) : '';
    const reqInfo = analyzeReq(url, method, bodyStr);
    const entry = { id: uid(), ts: ts(), method, url, req: reqInfo, res: null, injected: false, error: null };

    // ── Tools 注入逻辑 ──
    if (toolsInjectionEnabled && method === 'POST' && bodyStr) {
      const parsed = safeJSON(bodyStr);
      if (parsed && parsed.messages && !parsed.tools) {
        // 这是一个聊天请求且没有 tools 参数 → 注入！
        parsed.tools = PIERCODE_TOOLS;
        // 可选：加 tool_choice 强制使用
        // parsed.tool_choice = { type: "function", function: { name: "list_dir" } };

        bodyStr = JSON.stringify(parsed);
        entry.injected = true;
        entry.req = analyzeReq(url, method, bodyStr);  // 重新分析

        // 重建请求
        const newInit = { ...init, body: bodyStr };
        // 更新 Content-Length
        if (newInit.headers) {
          if (newInit.headers instanceof Headers) {
            newInit.headers.set('content-length', String(new Blob([bodyStr]).size));
          } else if (typeof newInit.headers === 'object') {
            newInit.headers['content-length'] = String(new Blob([bodyStr]).size);
          }
        }

        console.log(`%c[PierCode Sniffer] 🔧 TOOLS INJECTED into ${url}`, 'color:#f80;font-weight:bold');
        console.log('  tools:', PIERCODE_TOOLS.map(t => t.function.name));

        try {
          const resp = await _fetch.call(this, input, newInit);
          const clone = resp.clone();
          const ct = resp.headers.get('content-type') || '';

          try {
            if (ct.includes('event-stream') || ct.includes('stream')) {
              // SSE：实时逐行解析，读完整个流
              const toolCallNames = [];
              const phaseLog = [];
              const sseResult = await readSSEStream(clone.body, (json) => {
                if (!json.choices) return;
                for (const c of json.choices) {
                  if (c.delta?.phase) phaseLog.push(c.delta.phase);
                  if (c.delta?.function_call?.name) toolCallNames.push(c.delta.function_call.name);
                  if (c.delta?.tool_calls) { for (const tc of c.delta.tool_calls) { if (tc.function?.name) toolCallNames.push(tc.function.name); } }
                }
              });
              entry.res = { bodyRaw: sseResult.raw, toolCalls: null, finishReason: null, phases: [...new Set(phaseLog)] };
              // 从 SSE 事件中提取 tool calls
              const allToolCalls = [];
              for (const ev of sseResult.events) {
                if (!ev.choices) continue;
                for (const c of ev.choices) {
                  if (c.delta?.function_call?.name) allToolCalls.push(c.delta.function_call);
                  if (c.delta?.tool_calls) { for (const tc of c.delta.tool_calls) { if (tc.function?.name) allToolCalls.push(tc.function); } }
                  if (c.finish_reason) entry.res.finishReason = c.finish_reason;
                }
              }
              if (allToolCalls.length) entry.res.toolCalls = allToolCalls;
              // 检测是否用了注入的工具
              const injectedToolNames = PIERCODE_TOOLS.map(t => t.function.name);
              const usedInjected = toolCallNames.filter(n => injectedToolNames.includes(n));
              const usedNative = toolCallNames.filter(n => !injectedToolNames.includes(n));
              entry.res._toolCallSummary = { total: toolCallNames.length, injected: usedInjected, native: usedNative, all: toolCallNames };
              console.log(`%c[PierCode Sniffer] SSE 完整读取: ${sseResult.events.length} events, toolCalls: ${JSON.stringify(toolCallNames)}`, 'color:#0ff');
              if (usedInjected.length) console.log(`%c[PierCode Sniffer] ✅ 使用了注入工具: ${usedInjected.join(', ')}`, 'color:#0f0;font-weight:bold');
            } else {
              const text = await clone.text();
              entry.res = analyzeRes(text);
              entry.res.bodyRaw = trunc(text, MAX_BODY);
            }
          } catch (e) { entry.res = { bodyRaw: '[read error: ' + e.message + ']' }; }

          addEntry(entry);
          return resp;
        } catch (err) {
          entry.error = err.message;
          addEntry(entry);
          throw err;
        }
      }
    }

    // ── 正常抓包（不注入）──
    try {
      const resp = await _fetch.apply(this, args);
      const clone = resp.clone();
      try {
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('event-stream') || ct.includes('stream')) {
          const phaseLog = [];
          const sseResult = await readSSEStream(clone.body, (json) => {
            if (!json.choices) return;
            for (const c of json.choices) { if (c.delta?.phase) phaseLog.push(c.delta.phase); }
          });
          entry.res = { bodyRaw: sseResult.raw, toolCalls: null, finishReason: null, phases: [...new Set(phaseLog)] };
          const allToolCalls = [];
          for (const ev of sseResult.events) {
            if (!ev.choices) continue;
            for (const c of ev.choices) {
              if (c.delta?.function_call?.name) allToolCalls.push(c.delta.function_call);
              if (c.delta?.tool_calls) { for (const tc of c.delta.tool_calls) { if (tc.function?.name) allToolCalls.push(tc.function); } }
              if (c.finish_reason) entry.res.finishReason = c.finish_reason;
            }
          }
          if (allToolCalls.length) entry.res.toolCalls = allToolCalls;
        } else {
          const text = await clone.text();
          entry.res = analyzeRes(text);
          entry.res.bodyRaw = trunc(text, MAX_BODY);
        }
      } catch {}
      addEntry(entry);
      return resp;
    } catch (err) {
      entry.error = err.message;
      addEntry(entry);
      throw err;
    }
  };

  // ── 启动 ──
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createPanel);
  else createPanel();
  console.log('%c[PierCode API Sniffer v3] 🟢 Active', 'color:#58a6ff;font-weight:bold;font-size:14px', location.hostname);
})();
