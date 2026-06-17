// trace-browser-agent.mjs — attach to the debug Chrome (port 9222) on the user's
// profile copy, open the PierCode sidebar full-page tab, capture console from the
// SW + the chatgpt AI iframe, drive a task, and report where the loop breaks.
//
// Run: node scripts/trace-browser-agent.mjs "<task text>"

const DBG = 9222
const EXT_ID = 'lolcioebooncpbcgfdkcpolcihcdhcfl'
const TASK = process.argv[2] || '看看当前页面有什么，给我截个图'

function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const t = setTimeout(() => rej(new Error('ws open timeout')), 10000)
    ws.addEventListener('open', () => { clearTimeout(t); res(ws) }, { once: true })
    ws.addEventListener('error', e => { clearTimeout(t); rej(new Error('ws err ' + (e.message || ''))) }, { once: true })
  })
}
let _id = 1
function send(ws, method, params = {}, sessionId) {
  const id = _id++
  return new Promise((res, rej) => {
    const onMsg = e => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result || {})
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
  })
}
async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${DBG}/json/list`)
  return r.json()
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const logs = []
function logLine(src, text) {
  const line = `[${src}] ${text}`
  logs.push(line)
  console.log(line)
}

// Attach to browser-level WS to use Target domain (flat session mode) so we can
// hear console from SW + all frames including cross-origin iframes.
const ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()
const browserWs = await wsConnect(ver.webSocketDebuggerUrl)
await send(browserWs, 'Target.setDiscoverTargets', { discover: true })

// Collect sessions for SW + pages/iframes; pipe their console + exceptions.
const sessions = new Map() // sessionId -> {targetId, url}
browserWs.addEventListener('message', async e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.sessionId) {
    const s = sessions.get(m.sessionId)
    const args = (m.params.args || []).map(a => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ')
    const u = s ? s.url.slice(0, 40) : '?'
    // SW (background.js) logs unfiltered; pages filtered to relevant noise.
    const isSW = s && s.url.includes('background.js')
    if (isSW || /piercode|BROWSER_AGENT|bridge|inject|tool|browser_|agent|错误|失败|超时/i.test(args)) {
      logLine('console:' + (isSW ? 'SW' : u), `${m.params.type}: ${args}`.slice(0, 320))
    }
  } else if (m.method === 'Runtime.exceptionThrown' && m.sessionId) {
    const s = sessions.get(m.sessionId)
    const ex = m.params.exceptionDetails
    const txt = ex.exception?.description || ex.text || ''
    logLine('EXC:' + (s ? s.url.slice(0, 30) : '?'), txt.slice(0, 200))
  }
})

async function attach(targetId, url) {
  const { sessionId } = await send(browserWs, 'Target.attachToTarget', { targetId, flatten: true })
  sessions.set(sessionId, { targetId, url })
  try { await send(browserWs, 'Runtime.enable', {}, sessionId) } catch {}
  return sessionId
}

// 1) attach to PierCode SW
let targets = await listTargets()
const sw = targets.find(t => t.type === 'service_worker' && t.url.includes(EXT_ID))
if (!sw) { console.log('PierCode SW not found'); process.exit(1) }
const swSession = await attach(sw.id, sw.url)
logLine('trace', 'attached PierCode SW')

// 2) open the sidebar full-page tab (mounts BrowserAgentApp + AI iframes)
const newTabUrl = `chrome-extension://${EXT_ID}/sidebar.html?fullpage=1`
await send(browserWs, 'Target.createTarget', { url: newTabUrl })
logLine('trace', 'opened sidebar fullpage tab; waiting for iframes…')
await sleep(8000)

// 3) attach to the sidebar page + the chatgpt iframe
targets = await listTargets()
for (const t of targets) {
  if (t.type === 'page' && t.url.includes('sidebar.html')) await attach(t.id, t.url)
  if ((t.type === 'page' || t.type === 'iframe') && /chatgpt\.com|chat\.qwen\.ai/.test(t.url)) await attach(t.id, t.url)
}
// also discover OOPIF iframes via Target on the sidebar
logLine('trace', `attached sessions: ${[...sessions.values()].map(s => s.url.slice(0, 36)).join(' | ')}`)

// 4) drive a task: find the sidebar page session, type into TaskInput + click run.
const sidebar = [...sessions.entries()].find(([, s]) => s.url.includes('sidebar.html'))
if (!sidebar) { logLine('trace', 'sidebar page session missing — cannot drive task'); }
else {
  const [sid] = sidebar
  // hook chrome.runtime.onMessage in the sidebar page to log every BROWSER_AGENT_* it receives.
  const hook = `(() => {
    if (window.__piercodeTraceHook) return 'already';
    window.__piercodeTraceHook = true;
    window.__pcTrace = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && typeof msg.type === 'string' && msg.type.startsWith('BROWSER_AGENT_')) {
        window.__pcTrace.push(msg.type + (msg.error ? (' err=' + msg.error) : '') + (msg.name ? (' ' + msg.name) : '') + (msg.reason ? (' reason=' + msg.reason) : ''));
        console.log('SIDEBAR_RECV', msg.type, msg.error || msg.name || msg.reason || '');
      }
    });
    return 'hooked';
  })()`
  const rh = await send(browserWs, 'Runtime.evaluate', { expression: hook, returnByValue: true }, sid)
  logLine('trace', 'sidebar msg hook → ' + JSON.stringify(rh.result?.value))
  // set the textarea value + dispatch input, then click the run button.
  const drive = `(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(TASK)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`
  const r1 = await send(browserWs, 'Runtime.evaluate', { expression: drive, returnByValue: true }, sid)
  logLine('trace', 'type task → ' + JSON.stringify(r1.result?.value))
  await sleep(500)
  // click the run button (▶) — find by title or the send button.
  const clickRun = `(() => {
    const btns = [...document.querySelectorAll('button')];
    const run = btns.find(b => /跑|发送|运行|▶|⏎/.test(b.title + b.textContent));
    if (!run) return 'no-run-btn:' + btns.map(b=>b.title||b.textContent).slice(0,8).join(',');
    run.click();
    return 'clicked:' + (run.title || run.textContent);
  })()`
  const r2 = await send(browserWs, 'Runtime.evaluate', { expression: clickRun, returnByValue: true }, sid)
  logLine('trace', 'click run → ' + JSON.stringify(r2.result?.value))
}

// 5) watch console for ~40s while the loop (should) runs.
logLine('trace', 'watching console 40s…')
await sleep(40000)

// 6) dump backend stats + the sidebar store state snapshot
try {
  const sidebar = [...sessions.entries()].find(([, s]) => s.url.includes('sidebar.html'))
  if (sidebar) {
    const snap = `(() => {
      const tl = document.body.innerText.match(/动作时间线[\\s\\S]{0,200}/);
      const running = /正在操作|运行中/.test(document.body.innerText);
      const err = (document.body.innerText.match(/⚠[^\\n]{0,80}/) || [])[0] || '';
      return JSON.stringify({ running, timelinePeek: tl ? tl[0].slice(0,120) : null, err });
    })()`
    const r = await send(browserWs, 'Runtime.evaluate', { expression: snap, returnByValue: true }, sidebar[0])
    logLine('trace', 'sidebar state → ' + (r.result?.value || ''))
  }
} catch (e) { logLine('trace', 'snap err ' + e.message) }

console.log('\n===== TRACE SUMMARY =====')
console.log(logs.join('\n'))
browserWs.close()
process.exit(0)
