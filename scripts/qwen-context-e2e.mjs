import { spawn } from 'node:child_process';

const apiUrl = (process.env.PIERCODE_API_URL || '').replace(/\/+$/, '');
const token = process.env.PIERCODE_TOKEN || '';
const extensionId = process.env.PIERCODE_EXTENSION_ID || process.env.PIERCODE_INSTALLED_EXTENSION_ID || 'lolcioebooncpbcgfdkcpolcihcdhcfl';
const qwenUrl = process.env.PIERCODE_QWEN_URL || 'https://chat.qwen.ai/';
const editorSelector = process.env.PIERCODE_QWEN_EDITOR_SELECTOR || 'textarea.message-input-textarea';
const lowThreshold = Number(process.env.PIERCODE_QWEN_E2E_THRESHOLD || '1');
const restoreThreshold = Number(process.env.PIERCODE_QWEN_RESTORE_THRESHOLD || '1000000');
const summaryTokens = Number(process.env.PIERCODE_QWEN_E2E_SUMMARY_TOKENS || '65536');
const toolTimeoutMs = Number(process.env.PIERCODE_QWEN_E2E_TOOL_TIMEOUT_MS || '150000');
const fillAndSendTimeoutMs = Number(process.env.PIERCODE_QWEN_E2E_FILL_TIMEOUT_MS || '120000');
const callId = `post_compress_list_dir_${Date.now()}`;

if (!apiUrl || !token) {
  throw new Error('qwen-context-e2e requires PIERCODE_API_URL and PIERCODE_TOKEN for an already-running PierCode backend.');
}
if (!Number.isFinite(lowThreshold) || lowThreshold <= 0) {
  throw new Error('PIERCODE_QWEN_E2E_THRESHOLD must be a positive number.');
}
if (!Number.isFinite(restoreThreshold) || restoreThreshold <= 0) {
  throw new Error('PIERCODE_QWEN_RESTORE_THRESHOLD must be a positive number.');
}

let controlledTabId = 0;
let approvalSocket = null;

try {
  if (extensionId) {
    await step('configure low Qwen compression threshold', () => configureExtension(lowThreshold, { reloadExtension: true }));
  } else {
    console.warn('qwen-context-e2e: PIERCODE_EXTENSION_ID not set; assuming extension is already configured with low threshold.');
  }

  await step('wait for real Chrome relay', async () => {
    const stats = await waitForStats(stats => Number(stats.browser_relays || 0) > 0);
    if (!stats.browser_providers?.Extension) throw new Error(`Extension provider missing: ${JSON.stringify(stats)}`);
    return stats;
  });
  approvalSocket = await step('open browser approval socket', () => openApprovalSocket());

  const openTab = await step('open Qwen conversation', () => execTool('browser_new_tab', { url: qwenUrl }));
  controlledTabId = parseTabId(openTab.output);
  if (controlledTabId) {
    await step('claim Qwen AI tab for explicit E2E control', () => execTool('browser_use_tab', {
      tabId: controlledTabId,
      reason: 'run Qwen context compression end-to-end test on this AI conversation',
    }));
  }
  await step('wait for Qwen editor', () => execTool('browser_wait', { selector: editorSelector, state: 'attached', timeout: 30 }));
  await step('wait for Qwen provider', () => waitForStats(stats => Number(stats.browser_providers?.Qwen || 0) > 0));

  const qwenTabsBeforeCompression = await listQwenTabIds(controlledTabId);
  const triggerPrompt = `E2E 压缩上下文测试。请回复：context-e2e-start-${Date.now()}。`;
  await step('send compression trigger prompt', () => sendQwenPrompt(triggerPrompt));

  const oldConversation = await step('wait for local compression handoff', async () => {
    const text = await waitForBodyText(text =>
      text.includes('上下文已本地压缩，并已发送到新的 Qwen 会话') ||
      text.includes('上下文已压缩，并已发送到新的 Qwen 会话'),
      110000
    );
    return { output: text.slice(-1000) };
  });

  const handoffTabId = await step('select newest Qwen handoff tab', async () => {
    const tabs = await execTool('browser_tabs', { includeAiPages: true });
    const found = await findHandoffQwenTab(tabs.output, controlledTabId, qwenTabsBeforeCompression);
    if (!found) throw new Error(`could not find new Qwen tab: ${tabs.output}`);
    await execTool('browser_use_tab', { tabId: found, reason: 'continue Qwen context compression E2E in handoff session' });
    controlledTabId = found;
    return { output: `tabId=${found}` };
  });
  await step('wait for handoff Qwen editor', () => execTool('browser_wait', { selector: editorSelector, state: 'attached', tabId: controlledTabId, timeout: 30 }));

  await step('verify compressed context was actually injected into handoff tab', async () => {
    const result = await inspectQwenBody(controlledTabId);
    const text = String(result.tail || '');
    if (result.hasLegacyCompressedContext) {
      throw new Error('new session body contains legacy <compressed_context> wrapper');
    }
    if (result.hasLegacyPierCodePacket) {
      throw new Error('new session body contains legacy <piercode_context_packet> wrapper');
    }
    // 关键断言：handoff 内容必须真的落进新会话，否则注入静默失败也算"成功"。
    // 两条路径（模型 packet / 本地摘要）都会注入这句接续指令 + piercode-context 围栏。
    if (!result.hasContinuationInstruction || !result.hasPierCodeContext) {
      throw new Error(`handoff tab missing injected compressed context: ${text}`);
    }
    return { output: text };
  });

  await step('raise Qwen compression threshold before post-compression tool call', () =>
    configureExtension(restoreThreshold, { reloadExtension: false, e2eBridgeEnabled: true })
  );

  const postCompressPrompt = `E2E post-compress tool test. 请只输出这个可见 PierCode 工具调用：\n\n\`\`\`piercode-tool\n{"call_id":${JSON.stringify(callId)},"name":"list_dir","args":{"path":"."}}\n\`\`\``;
  await step('execute post-compression tool call', () => sendQwenPrompt(postCompressPrompt, callId));

  await step('verify post-compression tool result', async () => {
    const text = await waitForBodyText(text =>
      text.includes(callId) &&
      text.includes('README.md') &&
      text.includes('extension/') &&
      text.includes('internal/'),
      90000
    );
    return { output: text.slice(-1500) };
  });

  console.log(JSON.stringify({
    ok: true,
    lowThreshold,
    restoreThreshold,
    callId,
    oldConversation: String(oldConversation.output || '').slice(0, 120),
    handoffTab: String(handoffTabId.output || ''),
  }, null, 2));
} finally {
  if (extensionId) {
    await configureExtension(restoreThreshold, { reloadExtension: false, e2eBridgeEnabled: false }).catch(error => {
      console.warn(`qwen-context-e2e: failed to restore Qwen threshold: ${error.message || error}`);
    });
  }
  if (controlledTabId) {
    await execTool('browser_finalize_tabs', { closeTabIds: [controlledTabId], closeClaimedTabs: true }).catch(error => {
      console.warn(`qwen-context-e2e: tab cleanup failed: ${error.message || error}`);
    });
  }
  if (approvalSocket) {
    approvalSocket.close();
  }
}

function openApprovalSocket() {
  const wsUrl = apiUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') +
    `/ws?token=${encodeURIComponent(token)}&client=qwen-context-e2e-approval&provider=QwenContextE2E`;
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'browser_approval_ask' && msg.approval_id) {
      ws.send(JSON.stringify({
        type: 'browser_approval_answer',
        approval_id: msg.approval_id,
        approved: true,
        reason: 'qwen context e2e auto approval',
      }));
    }
  });
  return waitForOpen(ws).then(() => ws);
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', event => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${event.message || 'unknown'}`));
    }, { once: true });
  });
}

async function configureExtension(maxContextTokens, options = {}) {
  const e2eBridgeEnabled = typeof options.e2eBridgeEnabled === 'boolean'
    ? String(options.e2eBridgeEnabled)
    : maxContextTokens === lowThreshold ? 'true' : 'false';
  const reloadExtension = options.reloadExtension === true ? 'true' : 'false';
  const url = `chrome-extension://${extensionId}/configure.html?apiUrl=${encodeURIComponent(apiUrl)}&token=${encodeURIComponent(token)}&qwenMaxContextTokens=${encodeURIComponent(String(maxContextTokens))}&qwenMaxSummaryTokens=${encodeURIComponent(String(summaryTokens))}&qwenCompressionEnabled=true&qwenE2EBridgeEnabled=${e2eBridgeEnabled}&reloadExtension=${reloadExtension}`;
  await openChromeUrl(url);
  await sleep(options.reloadExtension === true ? 5000 : 2500);
  await waitForStats(stats => Number(stats.browser_relays || 0) > 0, 45000);
}

function openChromeUrl(url) {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'darwin'
    ? ['-a', 'Google Chrome', url]
    : process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function waitForStats(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await getStats();
      if (predicate(last)) return last;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timed out waiting for stats; last=${JSON.stringify(last)}`);
}

async function getStats() {
  const response = await fetch(`${apiUrl}/stats`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`/stats HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForBodyText(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const body = await execTool('browser_get_content', {
      selector: 'body',
      tabId: controlledTabId || undefined,
    });
    last = String(body.output || '');
    if (predicate(last)) return last;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for Qwen body text; tail=${last.slice(-1500)}`);
}

async function sendQwenPrompt(text, visibleNeedle = text.slice(0, 24), attempt = 1) {
  const nonce = `qwen-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await execTool('browser_evaluate', {
    tabId: controlledTabId || undefined,
    timeoutMs: fillAndSendTimeoutMs,
    expression: `new Promise(resolve => {
      const nonce = ${JSON.stringify(nonce)};
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(JSON.stringify({ ok: false, error: 'E2E fillAndSend timeout' }));
      }, ${JSON.stringify(fillAndSendTimeoutMs)});
      function onMessage(event) {
        const msg = event.data || {};
        if (event.source !== window || msg.type !== 'PIERCODE_E2E_FILL_AND_SEND_RESULT' || msg.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(JSON.stringify({ ok: !!msg.ok, error: msg.error || '' }));
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'PIERCODE_E2E_FILL_AND_SEND', nonce, text: ${JSON.stringify(text)} }, '*');
    })`,
  });
  const output = String(result.output || '');
  if (attempt === 1 && output.includes('Extension context invalidated')) {
    await execTool('browser_reload', { tabId: controlledTabId || undefined });
    await execTool('browser_wait', { selector: editorSelector, state: 'attached', tabId: controlledTabId || undefined, timeout: 30 });
    await execTool('browser_use_tab', { tabId: controlledTabId, reason: 'retry Qwen E2E after extension context reload' });
    return sendQwenPrompt(text, visibleNeedle, attempt + 1);
  }
  if (!output.includes('"ok":true')) {
    const fallback = await sendQwenPromptViaPageUI(text);
    const fallbackOutput = String(fallback.output || '');
    if (fallbackOutput.includes('"ok":true')) return fallback;
    throw new Error(`Qwen E2E fillAndSend failed: ${result.output}; UI fallback failed: ${fallback.output}`);
  }
  return result;
}

async function sendQwenPromptViaPageUI(text) {
  return execTool('browser_evaluate', {
    tabId: controlledTabId || undefined,
    timeoutMs: fillAndSendTimeoutMs,
    expression: `JSON.stringify((() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      if (!editor) return { ok: false, error: 'editor not found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, ${JSON.stringify(text)});
      else editor.value = ${JSON.stringify(text)};
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.focus();
      const sendButton = document.querySelector('button.send-button:not([disabled]), button[aria-label*="发送"]:not([disabled]), button[aria-label*="Send"]:not([disabled])');
      if (!sendButton) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return { ok: true, method: 'enter' };
      }
      sendButton.click();
      return { ok: true, method: 'button' };
    })())`,
  });
}

async function execTool(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), toolTimeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, call_id: `qwen-e2e-${name}-${Date.now()}`, args }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`${name} failed: ${body.error || body.output || JSON.stringify(body)}`);
  return body;
}

async function step(label, fn) {
  process.stdout.write(`qwen-context-e2e: ${label}... `);
  try {
    const result = await fn();
    process.stdout.write('ok\n');
    return result;
  } catch (error) {
    process.stdout.write('failed\n');
    throw error;
  }
}

function parseTabId(output) {
  const match = String(output || '').match(/\btabId=(\d+)\b/);
  return match ? Number(match[1]) : 0;
}

function parseNewestQwenTab(output, excludeTabId) {
  const matches = String(output || '')
    .split(/\r?\n/)
    .filter(line => line.includes('https://chat.qwen.ai/'))
    .map(line => Number(line.match(/\btabId=(\d+)\b/)?.[1] || 0))
    .filter(id => id && id !== excludeTabId);
  return matches[matches.length - 1] || 0;
}

async function listQwenTabIds(excludeTabId = 0) {
  const tabs = await execTool('browser_tabs', { includeAiPages: true });
  return new Set(parseQwenTabIds(tabs.output, excludeTabId));
}

function parseQwenTabIds(output, excludeTabId = 0) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(line => line.includes('https://chat.qwen.ai/'))
    .map(line => Number(line.match(/\btabId=(\d+)\b/)?.[1] || 0))
    .filter(id => id && id !== excludeTabId);
}

async function findHandoffQwenTab(output, excludeTabId, existingTabIds) {
  const ids = String(output || '')
    .split(/\r?\n/)
    .filter(line => line.includes('https://chat.qwen.ai/'))
    .map(line => Number(line.match(/\btabId=(\d+)\b/)?.[1] || 0))
    .filter(id => id && id !== excludeTabId)
    .filter(id => !existingTabIds?.has?.(id))
    .sort((a, b) => b - a);
  for (const id of ids) {
    await execTool('browser_use_tab', { tabId: id, reason: 'inspect candidate Qwen handoff tab' });
    const result = await inspectQwenBody(id);
    if (!result.hasPierCodeContext || result.hasRestoreText || result.hasContinueText) {
      return id;
    }
  }
  return ids[0] || 0;
}

async function inspectQwenBody(tabId) {
  const inspected = await execTool('browser_evaluate', {
    tabId: tabId || undefined,
    timeoutMs: 30000,
    expression: `JSON.stringify((() => {
      const text = document.body?.innerText || '';
      return {
        hasLegacyCompressedContext: text.includes('<compressed_context>'),
        hasLegacyPierCodePacket: text.includes('<piercode_context_packet'),
        hasContinuationInstruction: text.includes('请从下面的 PierCode 压缩上下文继续当前会话'),
        hasPierCodeContext: text.includes('piercode-context'),
        hasRestoreText: text.includes('恢复上下文'),
        hasContinueText: text.includes('继续会话'),
        length: text.length,
        tail: text.slice(-1500),
      };
    })())`,
  });
  const output = String(inspected.output || '{}');
  const jsonText = output.match(/\bvalue=(\{[\s\S]*\})\s*$/)?.[1] || output;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`failed to parse Qwen body inspection: ${inspected.output}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
