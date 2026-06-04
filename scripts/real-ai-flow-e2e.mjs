import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runDir = join(repoRoot, '.piercode', 'real-ai-flow');
const serverExe = join(runDir, process.platform === 'win32' ? 'piercode-real-server.exe' : 'piercode-real-server');
const mcpExe = join(runDir, process.platform === 'win32' ? 'piercode-real-mcp.exe' : 'piercode-real-mcp');
const mcpConfigPath = join(runDir, 'mcp-config.json');
const reportPath = join(repoRoot, 'docs', 'test-runs', `${dateStamp()}-real-ai-flow.md`);
const claudeSettingsPath = process.env.PIERCODE_CLAUDE_SETTINGS_PATH || join(homedir(), '.claude', 'settings.json');

const fixedToken = process.env.PIERCODE_REAL_AI_TOKEN || 'piercode-e2e-2026-fixed-token-abcdef1234567890';
const extensionId = process.env.PIERCODE_EXTENSION_ID || process.env.PIERCODE_INSTALLED_EXTENSION_ID || 'lolcioebooncpbcgfdkcpolcihcdhcfl';
const qwenUrl = process.env.PIERCODE_QWEN_URL || 'https://chat.qwen.ai/';
const chatgptUrl = process.env.PIERCODE_CHATGPT_URL || 'https://chatgpt.com/';
const toolTimeoutMs = Number(process.env.PIERCODE_REAL_AI_TOOL_TIMEOUT_MS || '360000');
const claudeTimeoutMs = Number(process.env.PIERCODE_REAL_AI_CLAUDE_TIMEOUT_MS || '480000');
const webAITurnTimeoutSec = Number(process.env.PIERCODE_REAL_AI_WEB_TIMEOUT_SEC || '300');
const qwenTurnTimeoutSec = Number(process.env.PIERCODE_REAL_AI_QWEN_TIMEOUT_SEC || '90');

let piercode = null;
let apiUrl = '';
let port = 0;
let approvalSocket = null;
const report = [];
const issues = [];
const optimizations = [];
const implementationFixes = [
  'Restored Claude settings env after CLI reported `Not logged in` with first-party auth.',
  'Changed marker verification from newest-tab assumption to scanning all provider tabs.',
  'Changed Claude MCP wiring to temporary `--mcp-config --strict-mcp-config` so local MCP settings are not polluted by transient ports.',
  'Strengthened Claude CLI prompt so the MCP tool argument must preserve the trace marker exactly.',
  'Shortened trace markers after Claude occasionally miscopied long timestamp markers in tool arguments.',
  'Added fixed-port Claude settings wiring with timestamped backup before real E2E execution.',
  'Expanded real-user scenarios with three consecutive multi-turn web AI calls.',
  'Made marker verification retry provider tab content after ChatGPT refresh/re-render instead of failing on one transient browser timeout.',
  'Bound each Claude MCP ask_web_ai call to the selected AI page client_id to avoid multi-tab ChatGPT drift.',
  'Allowed multiple fresh ChatGPT retries when the real page creates an empty assistant turn but never emits text.',
];

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    const message = error?.stack || error?.message || String(error);
    console.error(redactSensitive(message));
    if (report.length > 0 || issues.length > 0) {
      issues.push(`fatal: ${message.split('\n')[0]}`);
      writeReport('failed').catch(() => {}).finally(() => cleanup().catch(() => {}));
    } else {
      cleanup().catch(() => {});
    }
    process.exitCode = 1;
  });
}

export function parseTabs(output) {
  const tabs = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/\btabId=(\d+)\s+title="([^"]*)"\s+url="([^"]*)"/);
    if (!match) continue;
    const [, rawTabId, title, url] = match;
    tabs.push({
      tabId: Number(rawTabId),
      title,
      url,
      provider: providerFromUrl(url),
      controlled: /\bcontrolled=true\b/.test(line),
    });
  }
  return tabs;
}

export function newestTabsFirst(tabs) {
  return [...tabs].sort((a, b) => Number(b.tabId || 0) - Number(a.tabId || 0));
}

export function providerContentSelectors(provider) {
  return normalizeProvider(provider) === 'ChatGPT'
    ? ['main', '[data-testid^="conversation-turn"]', 'body']
    : ['main', '[class*="conversation"]', 'body'];
}

export function parseBrowserEvaluateValue(output) {
  const match = String(output || '').match(/\bvalue=([\s\S]*)$/);
  return match ? match[1].trim() : '';
}

export function chooseProviderOrder(preferred = 'Qwen') {
  const normalized = normalizeProvider(preferred);
  if (normalized === 'ChatGPT') return ['ChatGPT'];
  if (normalized === 'Qwen') return ['Qwen', 'ChatGPT'];
  return ['Qwen', 'ChatGPT'];
}

export function defaultRealAIPort() {
  return 39527;
}

export function e2eScenarioNames() {
  return [
    'risk-analysis',
    'code-review',
    'long-markdown-fidelity',
    'multi-turn-1',
    'multi-turn-2',
    'multi-turn-3',
    'after-tab-refresh',
    'after-backend-restart',
  ];
}

export function shouldRecordFallbackAttempt(failedProvider, attemptedProvider) {
  return normalizeProvider(failedProvider) === 'Qwen' && normalizeProvider(attemptedProvider) === 'ChatGPT';
}

export function buildClaudeSettings(existing, { command, apiUrl, token }) {
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    mcpServers: {
      ...((existing && typeof existing.mcpServers === 'object' && existing.mcpServers) ? existing.mcpServers : {}),
      'piercode-web-ai': {
        command,
        args: [],
        env: {
          PIERCODE_API_URL: apiUrl,
          PIERCODE_TOKEN: token,
        },
      },
    },
  };
}

export function isUsefulAIAnswer(text) {
  const clean = String(text || '').trim();
  if (clean.length < 40) return false;
  const noise = [
    '当前内容为空，请重新生成',
    'web AI returned an empty response',
    'failed to send prompt',
    'another web AI query is already running',
    'no connected browser AI page',
    'no web AI response',
    'MCP 工具调用',
    'tool call failed',
    'tool failed',
    'WEB_AI_TOOL_ERROR',
    '无法获得',
    '未能获得',
    '调用失败',
    'Not logged in',
    'Allocated quota exceeded',
    'quota exceeded',
    '连接到 Qwen',
    '出现问题',
    '糟糕',
  ];
  return !noise.some(part => clean.includes(part));
}

export function redactSensitive(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
    .replace(/\btoken=([^&\s"'`]+)/gi, 'token=<redacted>')
    .replace(/\b(PIERCODE_TOKEN|ANTHROPIC_API_KEY)=([^\s"'`]+)/g, '$1=<redacted>')
    .replace(/\bsk-[A-Za-z0-9._-]+/g, 'sk-<redacted>')
    .replace(/\btp-[A-Za-z0-9._-]+/g, 'tp-<redacted>');
}

async function main() {
  try {
    mkdirSync(runDir, { recursive: true });
    stepLog('build Go server binary', () => runChecked('go', ['build', '-o', serverExe, './cmd/server']));
    stepLog('build Go MCP binary', () => runChecked('go', ['build', '-o', mcpExe, './cmd/mcp']));
    stepLog('build Chrome extension', () => runChecked('npm', ['run', 'build'], join(repoRoot, 'extension')));

    port = Number(process.env.PIERCODE_REAL_AI_PORT || String(defaultRealAIPort()));
    apiUrl = `http://127.0.0.1:${port}`;
    stepLog('update Claude settings MCP server', () => configureClaudeSettings());
    await startBackend();
    writeTempMCPConfig();
    await configureExtension({ reloadExtension: true });
    approvalSocket = await openApprovalSocket();
    await waitForStats(stats => Number(stats.browser_relays || 0) > 0, 60000, 'Chrome extension relay');

    let provider = await ensureProviderReady(chooseProviderOrder(process.env.PIERCODE_REAL_AI_PROVIDER || 'Qwen'));
    provider = await runNaturalScenario(provider, 'risk-analysis', [
      '我们在做 PierCode 真实端到端测试。',
      '请从真实用户角度分析 Claude Code CLI 调用网页 AI 时，最容易失败的三个地方。',
      '请自然回答，不需要 JSON，也不要输出工具调用。',
    ].join('\n'));
    provider = await runNaturalScenario(provider, 'code-review', [
      '请像真实代码审查一样看下面 Go 片段，指出可能的测试盲点：',
      '',
      '```go',
      'func pickProvider(preferred string) []string {',
      '    if preferred == "ChatGPT" { return []string{"ChatGPT"} }',
      '    return []string{"Qwen", "ChatGPT"}',
      '}',
      '```',
    ].join('\n'));
    provider = await runNaturalScenario(provider, 'long-markdown-fidelity', [
      '请确认你能看到这段带 Markdown、代码、中文标点和特殊字符的输入，并说明从用户体验看哪里最容易丢格式。',
      '',
      '标题：PierCode 长文本保真测试',
      '',
      '```ts',
      'const sample = ["换行", "``` fenced code", "emoji-free", "中文；逗号，句号。"];',
      'console.log(sample.join("\\n"));',
      '```',
      '',
      '- A: CLI stdin',
      '- B: MCP stdio',
      '- C: Chrome extension',
      '- D: Web AI textarea/contenteditable',
    ].join('\n'));

    const multiTurnQuestions = [
      '这是连续多轮真实链路测试第 1 轮。请自然说明你收到的问题主题，并指出一个可能的链路风险。',
      '这是连续多轮真实链路测试第 2 轮。请延续刚才语境，说明为什么不能把旧回答误判为新回答。',
      '这是连续多轮真实链路测试第 3 轮。请自然总结连续调用时最应该观察的两个现象。',
    ];
    for (let i = 0; i < multiTurnQuestions.length; i++) {
      provider = await runNaturalScenario(provider, `multi-turn-${i + 1}`, multiTurnQuestions[i]);
    }

    await step('refresh AI tab and re-run short natural query', async () => {
      const tab = await selectLatestProviderTab(provider);
      await execTool('browser_reload', { tabId: tab.tabId });
      await waitForStats(stats => Number(stats.browser_providers?.[provider] || 0) > 0, 60000, `${provider} reconnect after reload`);
      provider = await runNaturalScenario(provider, 'after-tab-refresh', '刷新页面后，请自然回复你仍能收到 PierCode 通过 Claude CLI 发来的消息，并说明当前链路包含哪些组件。');
    });

    await step('restart backend and re-run short natural query', async () => {
      await restartBackend();
      writeTempMCPConfig();
      await waitForStats(stats => Number(stats.browser_relays || 0) > 0, 90000, 'extension relay after backend restart');
      await waitForStats(stats => Number(stats.browser_providers?.[provider] || 0) > 0, 90000, `${provider} after backend restart`);
      provider = await runNaturalScenario(provider, 'after-backend-restart', '后端重启后，请自然回复你仍能收到消息，并指出这说明重连链路里哪个环节有效。');
    });

    await writeReport('passed');
    console.log(redactSensitive(JSON.stringify({ ok: true, provider, apiUrl, reportPath }, null, 2)));
  } finally {
    await cleanup();
  }
}

async function runNaturalScenario(provider, name, naturalQuestion) {
  try {
    await attemptNaturalScenario(provider, name, naturalQuestion);
    return provider;
  } catch (error) {
    issues.push(`${name}: ${provider} scenario failed: ${error.message || error}`);
    if (normalizeProvider(provider) !== 'Qwen') {
      throw error;
    }
    const fallbackProvider = 'ChatGPT';
    report.push({ type: 'fallback', from: provider, to: fallbackProvider, status: 'attempted', scenario: name });
    optimizations.push(`${name}: Qwen was unusable; ChatGPT fallback attempted.`);
    await ensureProviderReady([fallbackProvider]);
    await attemptNaturalScenario(fallbackProvider, name, naturalQuestion);
    return fallbackProvider;
  }
}

async function attemptNaturalScenario(provider, name, naturalQuestion) {
  const marker = `pc-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`;
  const webQuestion = `${naturalQuestion}\n\n追踪标记：${marker}`;

  const maxAttempts = normalizeProvider(provider) === 'ChatGPT' ? 4 : 2;
  let final = null;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    if (attempts > 1) {
      await openProviderTab(provider);
    }
    const current = await runBoundClaudeScenario(provider, name, marker, webQuestion);
    if (isUsefulAIAnswer(current.result.result)) {
      final = current;
      break;
    }
    issues.push(`${name}: attempt ${attempts}/${maxAttempts} was not useful; retrying in fresh ${provider} conversation: ${current.result.result}`);
  }
  if (!final) {
    throw new Error(`${name}: useful web AI answer was not observed after ${maxAttempts} attempts`);
  }

  report.push({
    type: 'scenario',
    name,
    provider,
    marker,
    result: final.result.result,
    retry: attempts > 1,
    attempts,
    targetTabId: final.target.tab.tabId,
    targetClientId: final.target.clientID,
  });

  await verifyPromptLanded(provider, marker, final.target.tab.tabId);
}

async function runBoundClaudeScenario(provider, name, marker, webQuestion) {
  const target = await resolveProviderTarget(provider);
  const claudePrompt = [
    'Call the MCP tool `ask_web_ai` exactly once.',
    `Tool arguments must be: provider=${provider}, client_id=${target.clientID}, timeout_sec=${webAITimeoutForProvider(provider)}.`,
    'The tool argument `prompt` must equal the text inside <web_ai_prompt> exactly, including the trace marker line.',
    'Do not shorten, translate, rewrite, or omit any part of that tool prompt.',
    '',
    '<web_ai_prompt>',
    webQuestion,
    '</web_ai_prompt>',
    '',
    'Do not answer from your own knowledge before using the tool.',
    'If the tool result is an error or says no web AI response was received, output WEB_AI_TOOL_ERROR and the error; do not summarize it as a successful answer.',
    'After the tool result, summarize the web AI answer in Chinese in two short paragraphs.',
    `Mention this trace marker once: ${marker}`,
    'Do not edit files.',
  ].join('\n');
  const result = await step(`Claude CLI -> MCP -> ${provider}: ${name}`, async () => runClaudePrint(claudePrompt));
  return { result, target };
}

function webAITimeoutForProvider(provider) {
  return normalizeProvider(provider) === 'Qwen' ? qwenTurnTimeoutSec : webAITurnTimeoutSec;
}

async function runClaudePrint(prompt) {
  const child = spawn('claude', [
    '-p',
    '--output-format', 'json',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__piercode-web-ai__ask_web_ai',
  ], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end(prompt);
  const output = await collectProcess(child, claudeTimeoutMs);
  if (output.code !== 0) {
    throw new Error(`claude exited ${output.code}: ${output.stderr || output.stdout}`);
  }
  const line = output.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`claude output was not JSON: ${line}`);
  }
  if (parsed.is_error) {
    throw new Error(`claude reported error: ${parsed.result || JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function verifyPromptLanded(provider, marker, preferredTabId = 0) {
  const tabsResp = await execTool('browser_tabs', { includeAiPages: true });
  const tabs = newestTabsFirst(parseTabs(tabsResp.output).filter(tab => tab.provider === provider))
    .sort((a, b) => Number(b.tabId === preferredTabId) - Number(a.tabId === preferredTabId));
  const inspected = [];
  for (const tab of tabs) {
    try {
      await execTool('browser_use_tab', { tabId: tab.tabId, reason: `verify real AI prompt marker in ${provider} conversation tab` });
      const text = await getProviderTabTextWithRetry(provider, tab.tabId, marker);
      inspected.push(`${tab.tabId}:${text.slice(0, 80).replace(/\s+/g, ' ')}`);
      if (text.includes(marker)) {
        report.push({ type: 'prompt-landed', provider, marker, tabId: tab.tabId, url: tab.url });
        return;
      }
    } catch (error) {
      inspected.push(`${tab.tabId}:inspection failed: ${error.message || error}`);
      issues.push(`marker verification skipped ${provider} tab ${tab.tabId}: ${error.message || error}`);
    }
  }
  throw new Error(`prompt marker did not land in any ${provider} page body: ${marker}; inspected=${inspected.join(' | ')}`);
}

async function getProviderTabTextWithRetry(provider, tabId, marker) {
  const deadline = Date.now() + 60000;
  const selectors = providerContentSelectors(provider);
  let bestText = '';
  let lastError = null;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const body = await execTool('browser_get_content', { tabId, selector });
        const text = String(body.output || '');
        if (text.length > bestText.length) bestText = text;
        if (text.includes(marker)) return text;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(1500);
  }

  if (bestText) return bestText;
  throw new Error(lastError?.message || lastError || 'provider tab content unavailable');
}

async function ensureProviderReady(order) {
  let lastFailedProvider = '';
  for (const provider of order) {
    try {
      if (shouldRecordFallbackAttempt(lastFailedProvider, provider)) {
        report.push({ type: 'fallback', from: lastFailedProvider, to: provider, status: 'attempted' });
        optimizations.push('Qwen unavailable path exercised; ChatGPT fallback was attempted.');
      }
      await openProviderTab(provider);
      await waitForStats(stats => Number(stats.browser_providers?.[provider] || 0) > 0, 60000, `${provider} provider`);
      await selectLatestProviderTab(provider);
      report.push({ type: 'provider', provider, status: 'ready' });
      return provider;
    } catch (error) {
      issues.push(`${provider} unavailable: ${error.message || error}`);
      lastFailedProvider = provider;
    }
  }
  throw new Error(`no web AI provider became ready: ${order.join(', ')}`);
}

async function openProviderTab(provider) {
  const url = provider === 'ChatGPT' ? chatgptUrl : qwenUrl;
  await execTool('browser_new_tab', { url });
  await execTool('browser_wait', { selector: providerEditorSelector(provider), state: 'attached', timeout: 45 });
}

function providerEditorSelector(provider) {
  return provider === 'ChatGPT'
    ? 'div#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"]'
    : 'textarea.message-input-textarea, textarea[class*="MessageInput__TextArea"], [role="textbox"], [contenteditable="true"]';
}

async function selectLatestProviderTab(provider) {
  const tabsResp = await execTool('browser_tabs', { includeAiPages: true });
  const tabs = newestTabsFirst(parseTabs(tabsResp.output).filter(tab => tab.provider === provider));
  if (!tabs.length) throw new Error(`no ${provider} tab found`);
  const tab = tabs[0];
  await execTool('browser_use_tab', { tabId: tab.tabId, reason: `real AI flow e2e controls ${provider} conversation tab` });
  return tab;
}

async function resolveProviderTarget(provider) {
  const tab = await selectLatestProviderTab(provider);
  const evaluated = await execTool('browser_evaluate', {
    tabId: tab.tabId,
    expression: 'window.sessionStorage.getItem("__PIERCODE_CLIENT_ID__") || ""',
    awaitPromise: false,
  });
  const clientID = parseBrowserEvaluateValue(evaluated.output);
  if (!clientID) {
    throw new Error(`could not resolve PierCode client_id for ${provider} tab ${tab.tabId}: ${evaluated.output}`);
  }
  return { tab, clientID };
}

function writeTempMCPConfig() {
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      'piercode-web-ai': {
        command: mcpExe,
        args: [],
        env: {
          PIERCODE_API_URL: apiUrl,
          PIERCODE_TOKEN: fixedToken,
        },
      },
    },
  }, null, 2) + '\n', 'utf8');
}

function configureClaudeSettings() {
  const existing = readJSONFile(claudeSettingsPath);
  const backupPath = `${claudeSettingsPath}.bak-${timestampStamp()}-piercode-real-ai-flow`;
  if (existsSync(claudeSettingsPath)) {
    copyFileSync(claudeSettingsPath, backupPath);
  }
  const next = buildClaudeSettings(existing, {
    command: mcpExe,
    apiUrl,
    token: fixedToken,
  });
  writeFileSync(claudeSettingsPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  report.push({ type: 'claude-settings', path: claudeSettingsPath, backupPath, command: mcpExe, apiUrl });
}

function readJSONFile(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function configureExtension({ reloadExtension }) {
  const url = `chrome-extension://${extensionId}/configure.html?apiUrl=${encodeURIComponent(apiUrl)}&token=${encodeURIComponent(fixedToken)}&qwenCompressionEnabled=true&autoApproveBrowserActions=true&reloadExtension=${reloadExtension ? 'true' : 'false'}`;
  await openChromeUrl(url);
  await sleep(reloadExtension ? 5000 : 2500);
}

async function startBackend() {
  piercode = spawn(serverExe, ['-port', String(port), '-dir', repoRoot, '-token', fixedToken], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  piercode.stdout.on('data', chunk => process.stdout.write(redactSensitive(String(chunk))));
  piercode.stderr.on('data', chunk => process.stderr.write(redactSensitive(String(chunk))));
  await waitForHTTP(`${apiUrl}/health`, {}, body => body.status === 'ok', 60000);
  await waitForStats(stats => typeof stats.browser_clients === 'number', 60000, 'initial backend stats');
}

async function restartBackend() {
  await terminateProcess(piercode);
  piercode = null;
  await startBackend();
}

function openApprovalSocket() {
  const wsUrl = apiUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') +
    `/ws?token=${encodeURIComponent(fixedToken)}&client=real-ai-flow-approval&provider=RealAIFlow`;
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'browser_approval_ask' && msg.approval_id) {
      ws.send(JSON.stringify({
        type: 'browser_approval_answer',
        approval_id: msg.approval_id,
        approved: true,
        reason: 'real AI flow e2e approval',
      }));
    }
  });
  return waitForOpen(ws).then(() => ws);
}

async function execTool(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), toolTimeoutMs);
  let response;
  try {
    response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixedToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, call_id: `real-ai-${name}-${Date.now()}`, args }),
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

async function waitForStats(predicate, timeoutMs, label) {
  let last = null;
  await waitUntil(async () => {
    last = await getStats();
    return predicate(last) ? last : null;
  }, `timed out waiting for ${label}; last=${JSON.stringify(last)}`, timeoutMs);
  return last;
}

async function getStats() {
  const response = await fetch(`${apiUrl}/stats`, {
    headers: { authorization: `Bearer ${fixedToken}` },
  });
  if (!response.ok) throw new Error(`/stats HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForHTTP(url, options, predicate, timeoutMs) {
  await waitUntil(async () => {
    const response = await fetch(url, options);
    if (!response.ok) return null;
    const body = await response.json();
    return predicate(body) ? body : null;
  }, `timed out waiting for ${url}`, timeoutMs);
}

async function waitUntil(fn, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(lastError ? `${message}; lastError=${lastError.message || lastError}` : message);
}

async function step(label, fn) {
  process.stdout.write(`real-ai-flow: ${label}... `);
  try {
    const result = await fn();
    process.stdout.write('ok\n');
    return result;
  } catch (error) {
    process.stdout.write('failed\n');
    issues.push(`${label}: ${error.message || error}`);
    throw error;
  }
}

function stepLog(label, fn) {
  process.stdout.write(`real-ai-flow: ${label}... `);
  fn();
  process.stdout.write('ok\n');
}

function runChecked(cmd, args, cwd = repoRoot) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
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

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', event => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${event.message || 'unknown'}`));
    }, { once: true });
  });
}

function collectProcess(child, timeoutMs) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(selected));
    });
    server.on('error', reject);
  });
}

async function terminateProcess(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function cleanup() {
  try { approvalSocket?.close(); } catch {}
  approvalSocket = null;
  await terminateProcess(piercode);
  piercode = null;
}

async function writeReport(status) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const stats = await getStats().catch(() => null);
  const lines = [
    `# Real AI Flow E2E - ${dateStamp()}`,
    '',
    `Status: ${status}`,
    `API: ${apiUrl}`,
    `Claude MCP: temporary --mcp-config -> ${mcpExe}`,
    `Claude settings: ${redactSensitive(claudeSettingsPath)}`,
    `Extension ID: ${extensionId}`,
    '',
    '## Commands',
    '',
    '- `go build -o .piercode/real-ai-flow/piercode-real-server ./cmd/server`',
    '- `go build -o .piercode/real-ai-flow/piercode-real-mcp ./cmd/mcp`',
    '- `cd extension && npm run build`',
    '- `update ~/.claude/settings.json mcpServers.piercode-web-ai after timestamped backup`',
    '- `claude -p --mcp-config .piercode/real-ai-flow/mcp-config.json --strict-mcp-config --output-format json --allowedTools mcp__piercode-web-ai__ask_web_ai`',
    '',
    '## Settings',
    '',
    ...report.filter(item => item.type === 'claude-settings').map(item => `- Claude settings backup: ${redactSensitive(item.backupPath)}; MCP command: ${redactSensitive(item.command)}; API: ${item.apiUrl}`),
    '',
    '## Provider Fallback',
    '',
    ...(report.filter(item => item.type === 'fallback').length
      ? report.filter(item => item.type === 'fallback').map(item => `- ${item.from} unavailable; attempted ${item.to}`)
      : ['- fallback not needed during final run']),
    '',
    '## Scenarios',
    '',
    ...report.filter(item => item.type === 'scenario').map(item => {
      const landed = report.find(entry => entry.type === 'prompt-landed' && entry.marker === item.marker);
      return [
      `### ${item.name}`,
      '',
      `Provider: ${item.provider}`,
      `AI URL: ${landed?.url || '(not captured)'}`,
      `Marker: ${item.marker}`,
      `Retried: ${item.retry ? 'yes' : 'no'}`,
      `Attempts: ${item.attempts || 1}`,
      '',
      '```text',
      redactSensitive(String(item.result || '')).slice(0, 2500),
      '```',
      '',
      ].join('\n');
    }),
    '## Issues And Fixes',
    '',
    ...implementationFixes.map(issue => `- fixed: ${issue}`),
    ...(issues.length ? issues.map(issue => `- observed: ${redactSensitive(issue)}`) : ['- observed: none during final run']),
    '',
    '## Optimization Points',
    '',
    ...(optimizations.length ? optimizations.map(item => `- ${item}`) : [
      '- Keep AI-tab control explicit with `browser_use_tab`; implicit current tab can point at `about:blank`.',
      '- Treat short status-only AI output as non-useful and retry in a fresh conversation.',
      '- Preserve Claude provider env when settings hooks/plugins are updated.',
    ]),
    '',
    '## Final Stats',
    '',
    '```json',
    redactSensitive(JSON.stringify(stats, null, 2)),
    '```',
    '',
  ];
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
}

function providerFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('qwen.ai') || host.includes('qwenlm.ai')) return 'Qwen';
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'ChatGPT';
  } catch {}
  return 'Other';
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'chatgpt' || value === 'chatgpt.com') return 'ChatGPT';
  if (value === 'qwen' || value === 'qwen.ai') return 'Qwen';
  return '';
}

function dateStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timestampStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('exit', () => {
  approvalSocket?.close();
  if (piercode && !piercode.killed) piercode.kill('SIGTERM');
});
