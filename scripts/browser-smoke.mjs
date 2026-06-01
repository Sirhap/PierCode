import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = join(repoRoot, '.piercode', 'smoke');
const extensionDir = join(repoRoot, 'extension', 'dist');
const serverExe = join(smokeDir, process.platform === 'win32' ? 'piercode-smoke-server.exe' : 'piercode-smoke-server');
const uploadFixture = join(smokeDir, 'upload-fixture.txt');
const pdfOutput = join(smokeDir, 'browser-smoke.pdf');
const profileDir = join(smokeDir, 'chrome-profile');

const chromeCandidates = process.platform === 'win32'
  ? [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean)
  : [
      process.env.CHROME_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].filter(Boolean);

const chromePath = chromeCandidates.find(path => path && existsSync(path));
if (!chromePath) {
  throw new Error('Chrome executable not found. Set CHROME_PATH to run the browser smoke test.');
}
if (!existsSync(join(extensionDir, 'background.js')) && !existsSync(join(extensionDir, 'service_worker.js'))) {
  throw new Error('extension/dist is missing. Run `cd extension && npm run build` first.');
}

mkdirSync(smokeDir, { recursive: true });
rmSync(profileDir, { recursive: true, force: true });
writeFileSync(uploadFixture, 'PierCode upload smoke fixture\n', 'utf8');

const serverPort = await freePort();
const debugPort = await freePort();
const pagePort = await freePort();

const pageServer = createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="piercode-smoke-report.txt"',
    });
    res.end('PierCode browser smoke download\n');
    return;
  }
  if (req.url !== '/') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<meta charset="utf-8">
<title>PierCode browser smoke</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; }
  main { max-width: 760px; }
  #dragSource, #dropTarget {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 160px;
    height: 80px;
    margin: 12px 20px 12px 0;
    border: 2px solid #334155;
    user-select: none;
  }
  #dragSource { background: #dbeafe; cursor: grab; }
  #dropTarget { background: #dcfce7; }
</style>
<main>
  <h1>PierCode browser smoke report</h1>
  <label>Upload receipt <input id="file" type="file"></label>
  <button id="alertButton" onclick="alert('piercode smoke alert')">Show alert</button>
  <a id="downloadLink" href="/download" download>Download report</a>
  <div id="dragSource">Drag invoice</div>
  <div id="dropTarget">Drop approved</div>
  <p id="fileStatus">empty</p>
  <p id="dragStatus">not dropped</p>
  <p id="viewportStatus">viewport unknown</p>
</main>
<script>
  document.getElementById('file').addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    document.getElementById('fileStatus').textContent = files.map(file => file.name + ':' + file.size).join(',');
  });
  const source = document.getElementById('dragSource');
  const target = document.getElementById('dropTarget');
  let dragging = false;
  source.addEventListener('mousedown', () => { dragging = true; });
  window.addEventListener('mouseup', event => {
    if (!dragging) return;
    dragging = false;
    const rect = target.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    document.getElementById('dragStatus').textContent = inside ? 'invoice dropped' : 'missed drop';
  });
  window.addEventListener('resize', () => {
    document.getElementById('viewportStatus').textContent = window.innerWidth + 'x' + window.innerHeight;
  });
  document.getElementById('viewportStatus').textContent = window.innerWidth + 'x' + window.innerHeight;
</script>`);
});
await listen(pageServer, pagePort);

runChecked('go', ['build', '-o', serverExe, './cmd/server'], repoRoot);

const piercode = spawn(serverExe, ['-port', String(serverPort), '-dir', repoRoot], {
  cwd: repoRoot,
  windowsHide: true,
});
const token = await waitForToken(piercode);
await waitForStats(serverPort, token, stats => stats && typeof stats.browser_clients === 'number');

const approvalSocket = await openApprovalSocket(serverPort, token);
const chrome = spawn(chromePath, [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${debugPort}`,
  '--remote-allow-origins=*',
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--window-size=1200,900',
  'about:blank',
], {
  stdio: 'ignore',
  windowsHide: true,
});

try {
  const worker = await waitForExtensionWorker(debugPort);
  const extensionId = String(worker.url || '').match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  if (!extensionId) throw new Error(`could not determine extension id from ${worker.url}`);
  await configureExtensionWorker(worker.webSocketDebuggerUrl, `http://127.0.0.1:${serverPort}`, token);
  await waitForStats(serverPort, token, stats => Number(stats.browser_relays || 0) > 0);

  const pageURL = `http://127.0.0.1:${pagePort}/`;
  await execTool(serverPort, token, 'browser_new_tab', { url: pageURL });
  await execTool(serverPort, token, 'browser_wait', { selector: '#file', state: 'attached', timeout: 10 });

  await execTool(serverPort, token, 'browser_viewport', { width: 390, height: 844 });
  const viewport = await execTool(serverPort, token, 'browser_get_content', { selector: '#viewportStatus' });
  if (!String(viewport.output || '').includes('390')) {
    throw new Error(`viewport status did not reflect mobile width: ${JSON.stringify(viewport)}`);
  }
  await execTool(serverPort, token, 'browser_viewport', { reset: true });

  const upload = await execTool(serverPort, token, 'browser_upload', { selector: '#file', paths: [uploadFixture] });
  const content = await execTool(serverPort, token, 'browser_get_content', { selector: '#fileStatus' });
  if (!String(content.output || '').includes('upload-fixture.txt')) {
    throw new Error(`upload status did not include fixture name: ${JSON.stringify(content)}`);
  }

  const drag = await execTool(serverPort, token, 'browser_drag', { fromSelector: '#dragSource', toSelector: '#dropTarget' });
  const dragStatus = await execTool(serverPort, token, 'browser_get_content', { selector: '#dragStatus' });
  if (!String(dragStatus.output || '').includes('invoice dropped')) {
    throw new Error(`drag status did not show successful drop: ${JSON.stringify(dragStatus)}`);
  }

  const pdf = await execTool(serverPort, token, 'browser_pdf', { outputPath: pdfOutput, format: 'A4' });
  if (!existsSync(pdfOutput) || statSync(pdfOutput).size < 1000) {
    throw new Error(`PDF was not written or is too small: ${pdfOutput}`);
  }

  await execTool(serverPort, token, 'browser_click', { selector: '#downloadLink' });
  const downloads = await execTool(serverPort, token, 'browser_downloads', { state: 'complete', limit: 10 });
  if (!String(downloads.output || '').includes('piercode-smoke-report.txt')) {
    throw new Error(`download history did not include smoke report: ${JSON.stringify(downloads)}`);
  }

  await execTool(serverPort, token, 'browser_evaluate', {
    expression: "(() => { setTimeout(() => alert('piercode smoke alert'), 1500); return 'scheduled'; })()",
  });
  const dialog = await execTool(serverPort, token, 'browser_handle_dialog', { action: 'accept', timeout: 10 });

  console.log(JSON.stringify({
    ok: true,
    serverPort,
    debugPort,
    pageURL,
    upload: upload.output,
    fileStatus: content.output,
    viewport: viewport.output,
    drag: drag.output,
    dragStatus: dragStatus.output,
    pdf: pdf.output,
    downloads: downloads.output,
    dialog: dialog.output,
  }, null, 2));
} finally {
  approvalSocket.close();
  await terminateProcess(chrome);
  await terminateProcess(piercode);
  await closeServer(pageServer);
  await rmRetry(profileDir);
  await rmRetry(serverExe);
  await rmRetry(uploadFixture);
  await rmRetry(pdfOutput);
}

function runChecked(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function waitForToken(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for PierCode token')), 30000);
    const onData = chunk => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      const match = text.match(/token=([a-f0-9]{64})/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', data => process.stderr.write(data));
    proc.on('exit', code => reject(new Error(`PierCode server exited before token was printed: ${code}`)));
  });
}

async function waitForStats(port, token, predicate) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        last = await response.json();
        if (predicate(last)) return last;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for stats; last=${JSON.stringify(last)}`);
}

async function waitForExtensionWorker(debugPort) {
  const deadline = Date.now() + 30000;
  let last = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      last = await response.json();
      const worker = last.find(target =>
        target.type === 'service_worker' &&
        /^chrome-extension:\/\/[^/]+\/(?:background|service_worker)\.js$/.test(String(target.url || ''))
      );
      if (worker && worker.webSocketDebuggerUrl) return worker;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for extension service worker; targets=${JSON.stringify(last)}`);
}

async function openExtensionPage(debugPort, url) {
  let created = null;
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    created = await response.json().catch(() => null);
  } catch {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`).catch(() => null);
    created = response ? await response.json().catch(() => null) : null;
  }
  if (created?.webSocketDebuggerUrl) {
    const ws = new WebSocket(created.webSocketDebuggerUrl);
    await waitForOpen(ws);
    try {
      await cdpSend(ws, 'Page.enable');
      await cdpSend(ws, 'Page.navigate', { url });
    } finally {
      ws.close();
    }
  }
  const deadline = Date.now() + 10000;
  let last = [];
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    last = await response.json();
    const target = last.find(item => item.type === 'page' && sameURLIgnoringEncoding(item.url, url));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(250);
  }
  throw new Error(`timed out waiting for extension page; targets=${JSON.stringify(last)}`);
}

async function configureExtensionWorker(wsURL, apiUrl, token) {
  const ws = new WebSocket(wsURL);
  await waitForOpen(ws);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `new Promise(resolve => chrome.storage.local.set({ apiUrl: ${JSON.stringify(apiUrl)}, authToken: ${JSON.stringify(token)} }, () => resolve(JSON.stringify({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' }))))`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`extension storage configuration exception: ${JSON.stringify(result.exceptionDetails)}`);
    }
    const value = JSON.parse(result.result?.value || '{}');
    if (!value?.ok) {
      throw new Error(`extension storage configuration failed: ${value?.error || 'unknown error'}`);
    }
  } finally {
    ws.close();
  }
}

function sameURLIgnoringEncoding(actual, expected) {
  try {
    const actualURL = new URL(String(actual || ''));
    const expectedURL = new URL(String(expected || ''));
    if (actualURL.origin !== expectedURL.origin || actualURL.pathname !== expectedURL.pathname) {
      return false;
    }
    for (const [key, value] of expectedURL.searchParams.entries()) {
      if (actualURL.searchParams.get(key) !== value) return false;
    }
    return true;
  } catch {
    return String(actual || '').startsWith(String(expected || ''));
  }
}

async function waitForExtensionConfigured(wsURL) {
  const deadline = Date.now() + 10000;
  let last;
  while (Date.now() < deadline) {
    last = await cdpEvaluate(wsURL, `({
      href: location.href,
      readyState: document.readyState,
      done: window.__PIERCODE_CONFIG_DONE__ ?? null,
      status: document.getElementById("status")?.textContent ?? null
    })`);
    if (last?.done === true || String(last?.status || '').startsWith('Configured:')) return;
    if (last?.done === 'error' || String(last?.status || '').includes('Missing params')) {
      throw new Error(`extension configure page failed: ${last}`);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for extension configuration; last=${JSON.stringify(last)}`);
}

async function cdpEvaluate(wsURL, expression) {
  const ws = new WebSocket(wsURL);
  await waitForOpen(ws);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  } finally {
    ws.close();
  }
}

function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function openApprovalSocket(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}&client=smoke-approval&provider=Smoke`);
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'browser_approval_ask' && msg.approval_id) {
      ws.send(JSON.stringify({
        type: 'browser_approval_answer',
        approval_id: msg.approval_id,
        approved: true,
        reason: 'smoke test auto approval',
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

async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function rmRetry(path) {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === 19) throw error;
      await sleep(250);
    }
  }
}

async function execTool(port, token, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/exec`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, call_id: `smoke-${name}-${Date.now()}`, args }),
  });
  if (!response.ok) {
    throw new Error(`${name} HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    throw new Error(`${name} failed: ${body.error || body.output || JSON.stringify(body)}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
