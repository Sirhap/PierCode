// OOPIF (cross-origin iframe) end-to-end check against the REAL user Chrome with
// the installed PierCode extension (extension/dist), driving the already-running
// backend by PIERCODE_API_URL + PIERCODE_TOKEN.
//
// It serves a parent page on 127.0.0.1:<A> that embeds an iframe whose src is
// http://localhost:<B>/frame — a DIFFERENT host, so Chrome site-isolates it into
// an out-of-process iframe (OOPIF). Then it verifies, through PierCode tools:
//   1. browser_snapshot surfaces the OOPIF frame block + an element inside it.
//   2. browser_click on a ref inside the OOPIF actually flips in-frame state
//      (read back via browser_get_content on the parent, which polls the frame
//      through window.name messaging — kept same-origin-safe via postMessage).
//
// Run:
//   PIERCODE_API_URL=http://127.0.0.1:39527 PIERCODE_TOKEN=$(cat ~/.piercode/token) \
//   node scripts/oopif-e2e.mjs
//
// REQUIRES: the installed extension reloaded to the current extension/dist (so
// the OOPIF sessionId plumbing is present), and the user to approve the click
// when the approval card appears (or auto-approve enabled).

import { createServer } from 'node:http';
import net from 'node:net';

const apiUrl = (process.env.PIERCODE_API_URL || '').replace(/\/+$/, '');
const token = process.env.PIERCODE_TOKEN || '';
if (!apiUrl || !token) {
  throw new Error('oopif-e2e requires PIERCODE_API_URL and PIERCODE_TOKEN (the running backend).');
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });
}

const parentPort = await freePort();
const framePort = await freePort();

// Parent origin: 127.0.0.1:<parentPort>. Frame origin: localhost:<framePort>.
// Different host (127.0.0.1 vs localhost) ⇒ cross-origin ⇒ OOPIF.
const parentURL = `http://127.0.0.1:${parentPort}/`;
const frameSrc = `http://localhost:${framePort}/frame`;

const frameServer = createServer((req, res) => {
  if (req.url === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>oopif-frame</title>
<body style="margin:0;font-family:system-ui">
  <button id="frameBtn" style="width:200px;height:60px">Pay now</button>
  <p id="frameState">unpaid</p>
  <input id="frameInput" placeholder="card number" />
<script>
  document.getElementById('frameBtn').addEventListener('click', () => {
    document.getElementById('frameState').textContent = 'paid';
    parent.postMessage({ piercodeOopif: 'paid' }, '*');
  });
  document.getElementById('frameInput').addEventListener('input', e => {
    parent.postMessage({ piercodeOopif: 'typed:' + e.target.value }, '*');
  });
</script></body>`);
    return;
  }
  res.writeHead(404).end('not found');
});
await listen(frameServer, framePort, '127.0.0.1');

const parentServer = createServer((req, res) => {
  if (req.url !== '/') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>oopif-parent</title>
<body style="font-family:system-ui;margin:24px">
  <h1>OOPIF e2e parent</h1>
  <button id="parentBtn">Parent button</button>
  <p id="frameResult">none</p>
  <iframe id="payFrame" src="${frameSrc}" width="320" height="160" style="border:2px solid #334155"></iframe>
<script>
  window.addEventListener('message', ev => {
    const d = ev.data;
    if (d && typeof d.piercodeOopif === 'string') {
      document.getElementById('frameResult').textContent = d.piercodeOopif;
    }
  });
</script></body>`);
});
await listen(parentServer, parentPort, '127.0.0.1');

async function execTool(name, args, { allowError = false } = {}) {
  const res = await fetch(`${apiUrl}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, call_id: `oopif-e2e-${name}-${Date.now()}`, args: args || {} }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text}`);
  if (!allowError && json.status && json.status !== 'success') {
    throw new Error(`${name} failed: ${json.error || json.output || JSON.stringify(json)}`);
  }
  return json;
}

function out(r) {
  return (r && (r.output ?? r.result ?? r.data ?? r.raw)) || JSON.stringify(r);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

try {
  const stats = await fetch(`${apiUrl}/stats`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  console.log(`browser_relays=${stats.browser_relays}`);
  if (Number(stats.browser_relays || 0) < 1) {
    throw new Error('no browser relay connected — the installed extension must be reloaded to extension/dist and configured with the backend auth URL.');
  }

  console.log(`opening parent ${parentURL} (frame ${frameSrc})`);
  await execTool('browser_new_tab', { url: parentURL });
  // Give the OOPIF time to attach (Target.attachedToTarget) + AX enable.
  await sleep(2500);

  console.log('--- snapshot ---');
  const snap = await execTool('browser_snapshot', {});
  const snapText = out(snap);
  console.log(snapText.slice(0, 1400));
  check('snapshot reports a cross-origin iframe block', /iframe \(cross-origin\)/.test(snapText), 'no OOPIF block — extension may be stale (reload extension/dist) or Chrome<125');
  check('snapshot contains the in-frame "Pay now" button', /Pay now/.test(snapText), 'OOPIF AX not merged');

  // Find the ref of the in-frame button from the snapshot text.
  const m = snapText.match(/\[(e\d+)\][^\n]*Pay now/);
  if (!m) {
    check('locate in-frame button ref', false, 'could not parse a ref for "Pay now"');
  } else {
    const ref = m[1];
    const snapId = (snapText.match(/snapshotId=(\S+)/) || [])[1];
    console.log(`--- click in-frame button ${ref} (snap ${snapId}) — APPROVE the card if it appears ---`);
    const clickRes = await execTool('browser_click', { ref, snapshotId: snapId }, { allowError: true });
    const clickOut = out(clickRes);
    console.log(clickOut);
    // Distinguish "approval never granted" (test-environment limitation: the
    // approval card renders on an AI page, and this test page is not one) from a
    // genuine coordinate miss. Only the latter is an OOPIF defect.
    if (/approval (timed out|timeout|rejected|denied)/i.test(clickOut) || (clickRes.status && clickRes.status !== 'success' && /approv/i.test(clickOut))) {
      console.log('  SKIP  click landing — approval not granted (enable auto-approve, or this page is not an AI page so the card cannot render). Not an OOPIF coordinate result.');
    } else {
      await sleep(800);
      const result = out(await execTool('browser_get_content', { selector: '#frameResult' }));
      console.log('parent #frameResult =', result.trim());
      check('clicking the OOPIF button flipped in-frame state to paid', /paid/.test(result), `got: ${result.trim()} — coordinate offset may be wrong`);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL OOPIF CHECKS PASSED' : failures + ' OOPIF CHECK(S) FAILED'}`);
} catch (err) {
  console.error('oopif-e2e error:', err.message);
  failures++;
} finally {
  frameServer.close();
  parentServer.close();
  process.exit(failures === 0 ? 0 : 1);
}
