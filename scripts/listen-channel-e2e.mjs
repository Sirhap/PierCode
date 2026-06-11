// Listen-channel browser E2E. Validates the browser-only, unit-untestable piece:
// page-bridge's window.fetch patch + Response.tee() + relay-frame emission, in a
// REAL Chrome on a REAL chat.qwen.ai page (real fetch, real baxia-patched fetch
// underneath, real streaming Response).
//
// We inject the BUILT page-bridge.js into the qwen page's MAIN world ourselves
// (location is chat.qwen.ai → platformForHost()='qwen' → installApiListen patches
// fetch), capture the PIERCODE_API_LISTEN_* window messages it posts, decode the
// relayed bytes, and assert they reconstruct the SSE content + the tool fence.
// The /api/v2/chat/completions request is fulfilled with fake SSE via CDP Fetch
// (no login needed). The content→SW→sidebar leg is covered by unit tests
// (api-listen.test.ts consumeListenStream); this proves the page-world half.
//
// No Go backend needed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(repoRoot, 'extension', 'dist');
const smokeDir = join(repoRoot, '.piercode', 'listen-e2e');
const profileDir = join(smokeDir, 'chrome-profile');

if (!existsSync(join(extensionDir, 'background.js'))) {
  throw new Error('extension/dist/background.js missing — run `npm run build` in extension/ first');
}

const chromePath = (process.platform === 'win32'
  ? [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  : [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
).filter(Boolean).find(p => existsSync(p));
if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');

mkdirSync(smokeDir, { recursive: true });
await rmRetry(profileDir);

// ── Fake qwen page + SSE endpoint ────────────────────────────────────────────
const FENCE = '```piercode-tool\n{"name":"read_file","call_id":"e1","args":{"path":"E2E.md"}}\n```';
const SSE_LINES = [
  { 'response.created': { response_id: 'r0', response_index: '0' } },
  { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'Hello ' } }] },
  { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'world\n' } }] },
  { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: FENCE } }] },
];

const SSE_BODY = SSE_LINES.map(l => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n';

// The page sends its OWN request (exactly like the real qwen web client),
// injected via CDP into the page's main world. The request to
// /api/v2/chat/completions is fulfilled by CDP Fetch (below), not the network.
const TRIGGER_EXPR = `(async () => {
  const res = await fetch('/api/v2/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const reader = res.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  return 'page-drained';
})()`;

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// ── Launch Chrome ────────────────────────────────────────────────────────────
// No local server / host-resolver / TLS. We fulfill chat.qwen.ai requests via
// the CDP Fetch domain — bypasses DNS, HSTS, and TLS entirely, while the content
// script + page-bridge still inject because the URL host matches the manifest.
const debugPort = await freePort();
const chrome = spawn(chromePath, [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${debugPort}`,
  '--remote-allow-origins=*',
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--window-size=1100,800',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let failed = null;
try {
  const worker = await waitForExtensionWorker(debugPort);
  const extId = String(worker.url || '').match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  if (!extId) throw new Error(`no extension id from ${worker.url}`);
  const swWs = new WebSocket(worker.webSocketDebuggerUrl);
  await waitForOpen(swWs);
  await cdpSend(swWs, 'Runtime.enable');

  // 1) Create the qwen tab via the SW's OWN chrome.tabs.create (first-class tab).
  const before = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const beforeIds = new Set(before.filter(t => t.type === 'page').map(t => t.id));
  const created = await cdpSend(swWs, 'Runtime.evaluate', {
    expression: `new Promise(r => chrome.tabs.create({ url: 'about:blank', active: false }, t => r(t.id)))`,
    awaitPromise: true, returnByValue: true,
  });
  const qwenTabId = created.result?.value;
  if (typeof qwenTabId !== 'number') throw new Error(`SW tabs.create returned ${JSON.stringify(created.result)}`);

  let pageTarget = null;
  for (let i = 0; i < 40 && !pageTarget; i++) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    pageTarget = list.find(t => t.type === 'page' && !beforeIds.has(t.id) && /about:blank|chrome:\/\/newtab/.test(String(t.url || '')));
    if (!pageTarget) await sleep(150);
  }
  if (!pageTarget) throw new Error('could not find the SW-created tab target');

  const pgWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await waitForOpen(pgWs);
  await cdpSend(pgWs, 'Runtime.enable');
  await cdpSend(pgWs, 'Page.enable');

  // 2) Fulfill the completions XHR with fake qwen SSE (no login). Let the real
  //    chat.qwen.ai document load so location/origin is genuinely qwen.
  await cdpSend(pgWs, 'Fetch.enable', {
    patterns: [{ urlPattern: '*://chat.qwen.ai/api/v2/chat/completions', requestStage: 'Request' }],
  });
  pgWs.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.method !== 'Fetch.requestPaused') return;
    cdpSend(pgWs, 'Fetch.fulfillRequest', {
      requestId: msg.params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'text/event-stream; charset=utf-8' },
        { name: 'cache-control', value: 'no-cache' },
      ],
      body: b64(SSE_BODY),
    }).catch(() => {});
  });
  await cdpSend(swWs, 'Runtime.evaluate', {
    expression: `new Promise(r => chrome.tabs.update(${qwenTabId}, { url: 'https://chat.qwen.ai/' }, () => r('nav')))`,
    awaitPromise: true, returnByValue: true,
  });
  await sleep(4500); // real qwen doc load

  // 3) Inject the BUILT page-bridge.js into the page MAIN world. location is
  //    chat.qwen.ai → installApiListen() patches window.fetch. Then add a
  //    capture hook for the PIERCODE_API_LISTEN_* frames it posts, and flip the
  //    relay flag (in production: content's setApiListen posts AL_SET).
  const pageBridgeSrc = readFileSync(join(extensionDir, 'page-bridge.js'), 'utf8');
  await cdpSend(pgWs, 'Runtime.evaluate', { expression: pageBridgeSrc, returnByValue: false });
  await cdpSend(pgWs, 'Runtime.evaluate', {
    expression: `(() => {
      window.__AL = { head: null, chunks: [], done: false, error: null };
      window.addEventListener('message', e => {
        if (e.source !== window) return; const d = e.data; if (!d || typeof d.type !== 'string') return;
        if (d.type === 'PIERCODE_API_LISTEN_HEAD') window.__AL.head = { platform: d.platform, ok: d.ok, status: d.status };
        else if (d.type === 'PIERCODE_API_LISTEN_CHUNK') window.__AL.chunks.push(d.b64);
        else if (d.type === 'PIERCODE_API_LISTEN_DONE') window.__AL.done = true;
        else if (d.type === 'PIERCODE_API_LISTEN_ERROR') window.__AL.error = d.error;
      });
      window.__PIERCODE_API_LISTEN_ON__ = true;
      return JSON.stringify({ listenGuard: window.__PIERCODE_API_LISTEN__ === true, host: location.hostname });
    })()`,
    returnByValue: true,
  }).then(r => console.log('page-bridge ready:', r.result?.value));

  // 4) Trigger the page's OWN fetch to the completions URL (fulfilled fake SSE).
  const trig = await cdpSend(pgWs, 'Runtime.evaluate', { expression: TRIGGER_EXPR, awaitPromise: true, returnByValue: true });
  if (trig.exceptionDetails) throw new Error(`page fetch threw: ${JSON.stringify(trig.exceptionDetails)}`);

  // 5) Wait for the relay frames, then decode + reconstruct the SSE.
  const deadline = Date.now() + 8000;
  let al = null;
  while (Date.now() < deadline) {
    const r = await cdpSend(pgWs, 'Runtime.evaluate', { expression: 'JSON.stringify(window.__AL)', returnByValue: true });
    al = JSON.parse(r.result?.value || '{}');
    if (al.done || al.error) break;
    await sleep(150);
  }

  const decoded = (al.chunks || []).map(b => Buffer.from(b, 'base64').toString('utf8')).join('');
  // Reconstruct the assistant content exactly as the SW pipeline would (qwen
  // answer-phase deltas), to prove the relayed bytes carry the real stream.
  const content = decoded.split('\n').filter(l => l.startsWith('data: ') && l.slice(6).trim() !== '[DONE]')
    .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta; } catch { return null; } })
    .filter(d => d && d.phase === 'answer' && typeof d.content === 'string').map(d => d.content).join('');

  const okHead = al.head && al.head.platform === 'qwen' && al.head.ok === true;
  const okBytes = decoded.includes('Hello ') && decoded.includes('world');
  const okContent = content.includes('Hello world');
  const okTool = content.includes('read_file') && content.includes('E2E.md');

  console.log('--- listen-channel-e2e (page-world half) ---');
  console.log('page trigger     :', trig.result?.value);
  console.log('AL head          :', JSON.stringify(al.head), 'done=' + al.done, 'err=' + (al.error || 'none'));
  console.log('relayed bytes len:', decoded.length);
  console.log('reconstructed    :', JSON.stringify(content));
  console.log('head assert      :', okHead ? 'PASS' : 'FAIL');
  console.log('relay bytes      :', okBytes ? 'PASS' : 'FAIL');
  console.log('content recon    :', okContent ? 'PASS' : 'FAIL');
  console.log('tool fence       :', okTool ? 'PASS' : 'FAIL');

  if (!okHead || !okBytes || !okContent || !okTool) {
    failed = `assertions failed (head=${okHead}, bytes=${okBytes}, content=${okContent}, tool=${okTool})`;
  }
  pgWs.close();
  swWs.close();
} catch (e) {
  failed = e?.message || String(e);
} finally {
  await terminateProcess(chrome);
}

if (failed) {
  console.error('LISTEN E2E FAILED:', failed);
  process.exit(1);
}
console.log('LISTEN E2E PASSED');

// ── helpers (cloned from browser-smoke.mjs) ──────────────────────────────────
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitForExtensionWorker(debugPort) {
  const deadline = Date.now() + 30000;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const w = last.find(t => t.type === 'service_worker' && /^chrome-extension:\/\/[^/]+\/(background|service_worker)\.js$/.test(String(t.url || '')));
      if (w?.webSocketDebuggerUrl) return w;
    } catch {}
    await sleep(250);
  }
  throw new Error(`no extension service worker; targets=${JSON.stringify(last)}`);
}
function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((res, rej) => {
    const onMsg = e => { const m = JSON.parse(e.data); if (m.id !== id) return; ws.removeEventListener('message', onMsg); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result || {}); };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitForOpen(ws) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener('error', e => { clearTimeout(t); rej(new Error(`ws error: ${e.message || 'unknown'}`)); }, { once: true });
  });
}
async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGTERM');
  await new Promise(res => { const t = setTimeout(res, 5000); proc.once('exit', () => { clearTimeout(t); res(); }); });
}
async function rmRetry(path) {
  for (let i = 0; i < 20; i++) { try { rmSync(path, { recursive: true, force: true }); return; } catch (e) { if (i === 19) throw e; await sleep(200); } }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
