// iframe-embed-smoke.mjs — verifies the browser-agent sidebar's HIGHEST-RISK piece:
// the DNR rules in dnr-offscreen.json actually strip X-Frame-Options / CSP
// frame-ancestors for chatgpt.com AND chat.qwen.ai, so those sites load inside
// an extension-origin <iframe> (the "挤在一块" AI panes).
//
// What it does:
//   1. loads extension/dist into a fresh isolated Chrome (like browser-smoke).
//   2. opens an extension-origin page (sidebar.html — same chrome-extension:// origin
//      the real AiFrame iframes live under) and injects two <iframe>s pointing at
//      https://chatgpt.com/ and https://chat.qwen.ai/.
//   3. waits for each frame to COMMIT a navigation to that host (Page.frameNavigated).
//      If X-Frame-Options/CSP were NOT stripped, Chrome blocks the load and no child
//      frame commits to the target origin — so a committed child frame == DNR worked.
//   4. asks declarativeNetRequest.getMatchedRules() whether our modifyHeaders rules
//      fired for sub_frame requests to those hosts (best-effort corroboration).
//
// Real network, NO login required: the chatgpt/qwen login/landing page itself sends
// X-Frame-Options, so a committed frame proves the strip. Set
// PIERCODE_ALLOW_ISOLATED_CHROME_SMOKE=1 to run (mirrors browser-smoke gating).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const allow = process.env.PIERCODE_ALLOW_ISOLATED_CHROME_SMOKE === '1' || process.env.CI === 'true';
if (!allow) {
  throw new Error('iframe-embed-smoke starts an isolated Chrome and loads extension/dist. Set PIERCODE_ALLOW_ISOLATED_CHROME_SMOKE=1 to run.');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = join(repoRoot, '.piercode', 'iframe-smoke');
const extensionDir = join(repoRoot, 'extension', 'dist');
const profileDir = join(smokeDir, 'chrome-profile');

const TARGETS = [
  { platform: 'chatgpt', host: 'chatgpt.com', url: 'https://chatgpt.com/?piercode_browser_agent=chatgpt' },
  { platform: 'qwen', host: 'chat.qwen.ai', url: 'https://chat.qwen.ai/?piercode_browser_agent=qwen' },
];

const chromeCandidates = process.platform === 'win32'
  ? [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)
  : [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chromePath = chromeCandidates.find(p => p && existsSync(p));
if (!chromePath) throw new Error('Chrome executable not found. Set CHROME_PATH.');
if (!existsSync(join(extensionDir, 'background.js'))) {
  throw new Error('extension/dist is missing. Run `cd extension && npm run build` first.');
}

mkdirSync(smokeDir, { recursive: true });
rmSync(profileDir, { recursive: true, force: true });

const debugPort = await freePort();
const chrome = spawn(chromePath, [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${debugPort}`,
  '--remote-allow-origins=*',
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--window-size=1200,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

let exitCode = 0;
try {
  const worker = await waitForExtensionWorker(debugPort);
  const extensionId = String(worker.url || '').match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  if (!extensionId) throw new Error(`could not determine extension id from ${worker.url}`);

  // Open an extension-origin page (sidebar.html exists in dist) so injected iframes
  // are same-origin-policy'd exactly like the real AiFrame panes.
  const pageURL = `chrome-extension://${extensionId}/sidebar.html`;
  const page = await openPage(debugPort, pageURL);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await waitForOpen(ws);

  const results = {};
  try {
    await cdpSend(ws, 'Page.enable');
    await cdpSend(ws, 'Runtime.enable');

    // Track child frames that COMMIT to each target host.
    const committed = new Set();
    ws.addEventListener('message', evt => {
      const msg = JSON.parse(evt.data);
      if (msg.method === 'Page.frameNavigated') {
        const frameURL = String(msg.params?.frame?.url || '');
        for (const t of TARGETS) {
          try {
            const u = new URL(frameURL);
            if (u.host === t.host) committed.add(t.platform);
          } catch {}
        }
      }
    });

    // Inject the two iframes into the extension page.
    await cdpSend(ws, 'Runtime.evaluate', {
      expression: `(() => {
        for (const t of ${JSON.stringify(TARGETS)}) {
          const f = document.createElement('iframe');
          f.id = 'smoke-' + t.platform;
          f.src = t.url;
          f.style.cssText = 'width:480px;height:640px;border:1px solid #333';
          document.body.appendChild(f);
        }
        return document.querySelectorAll('iframe').length;
      })()`,
      returnByValue: true,
    });

    // Wait until both frames commit to their host (== not blocked by XFO/CSP), or timeout.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && committed.size < TARGETS.length) {
      await sleep(300);
    }
    for (const t of TARGETS) results[t.platform] = { iframeCommitted: committed.has(t.platform) };

    // Corroborate via declarativeNetRequest.getMatchedRules() from the SW.
    const matched = await matchedRules(worker.webSocketDebuggerUrl);
    for (const t of TARGETS) {
      results[t.platform].dnrRuleMatched = matched.some(m =>
        String(m.request?.url || '').includes(t.host) && m.request?.type === 'sub_frame');
    }
  } finally {
    ws.close();
  }

  const allCommitted = TARGETS.every(t => results[t.platform].iframeCommitted);
  console.log(JSON.stringify({ ok: allCommitted, extensionId, results }, null, 2));
  if (!allCommitted) {
    console.error('FAIL: one or more AI iframes did NOT commit — DNR header-strip not working for that host.');
    exitCode = 1;
  } else {
    console.log('PASS: both chatgpt.com and chat.qwen.ai loaded inside an extension-origin iframe (XFO/CSP stripped).');
  }
} catch (err) {
  console.error('iframe-embed-smoke error:', err?.message || err);
  exitCode = 1;
} finally {
  await terminateProcess(chrome);
  await rmRetry(profileDir);
}
process.exit(exitCode);

// ── helpers (subset mirrored from browser-smoke.mjs) ──────────────────────────
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitForExtensionWorker(port) {
  const deadline = Date.now() + 30000;
  let last = [];
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      last = await r.json();
      const w = last.find(t => t.type === 'service_worker' && /^chrome-extension:\/\/[^/]+\/background\.js$/.test(String(t.url || '')));
      if (w?.webSocketDebuggerUrl) return w;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for extension service worker; targets=${JSON.stringify(last)}`);
}
async function openPage(debugPort, url) {
  let created = null;
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    created = await r.json().catch(() => null);
  } catch {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`).catch(() => null);
    created = r ? await r.json().catch(() => null) : null;
  }
  if (created?.webSocketDebuggerUrl && sameOriginPath(created.url, url)) return created;
  const deadline = Date.now() + 10000;
  let last = [];
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    last = await r.json();
    const target = last.find(i => i.type === 'page' && sameOriginPath(i.url, url));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(250);
  }
  throw new Error(`timed out waiting for extension page; targets=${JSON.stringify(last)}`);
}
function sameOriginPath(a, b) {
  try { const x = new URL(String(a)); const y = new URL(String(b)); return x.origin === y.origin && x.pathname === y.pathname; }
  catch { return String(a || '').startsWith(String(b || '')); }
}
async function matchedRules(wsURL) {
  const ws = new WebSocket(wsURL);
  await waitForOpen(ws);
  try {
    const res = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `new Promise(r => chrome.declarativeNetRequest.getMatchedRules({}, info => r(JSON.stringify(info?.rulesMatchedInfo || []))))`,
      awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) return [];
    try { return JSON.parse(res.result?.value || '[]'); } catch { return []; }
  } finally { ws.close(); }
}
function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((res, rej) => {
    const onMsg = e => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result || {});
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitForOpen(ws) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener('error', e => { clearTimeout(t); rej(new Error(`websocket error: ${e.message || 'unknown'}`)); }, { once: true });
  });
}
async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else proc.kill('SIGTERM');
  await new Promise(res => { const t = setTimeout(res, 5000); proc.once('exit', () => { clearTimeout(t); res(); }); });
}
async function rmRetry(path) {
  for (let i = 0; i < 20; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch (e) { if (i === 19) throw e; await sleep(250); }
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
