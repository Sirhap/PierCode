import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = join(repoRoot, '.piercode', 'live-smoke');
const uploadFixture = join(smokeDir, 'upload-fixture.txt');
const pdfOutput = join(smokeDir, 'browser-live-smoke.pdf');

const apiUrl = (process.env.PIERCODE_API_URL || '').replace(/\/+$/, '');
const token = process.env.PIERCODE_TOKEN || '';
const SW_DIRECT_DISABLED_RE = /SW_DIRECT_BROWSER=false|Go relay path is disabled|service worker now/i;
function swDirectRelayError(name, message) {
  return [
    `${name} failed: ${message}`,
    '',
    'scripts/browser-live-smoke.mjs exercises the deprecated Go→WS browser relay.',
    'The current extension executes browser_* tools in the service worker (SW-direct),',
    'so this script cannot validate the active browser path. Use an AI page/content-route',
    'smoke (for example Qwen emitting a browser_test piercode-tool block), or port this',
    'script to send EXEC_BROWSER_TOOL through the extension service worker.',
  ].join('\n');
}
if (!apiUrl || !token) {
  throw new Error([
    'browser-live-smoke requires the real user Chrome with the installed PierCode extension.',
    'Start the PierCode backend, configure that already-installed extension with the printed auth URL,',
    'then run with PIERCODE_API_URL and PIERCODE_TOKEN for the already-running backend.',
  ].join(' '));
}

mkdirSync(smokeDir, { recursive: true });
writeFileSync(uploadFixture, 'PierCode live upload fixture\n', 'utf8');

const pagePort = await freePort();
const controlledTabIds = [];
const approvalDecisions = [];
const approvalStats = {
  asked: 0,
  approved: 0,
  rejected: 0,
  done: 0,
  doneCallIds: new Set(),
  actions: [],
  mismatches: [],
  doneWaiters: new Map(),
};
const pageServer = createServer((req, res) => {
  if (req.url?.startsWith('/download')) {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="piercode-live-report-${pagePort}.txt"`,
    });
    res.end('PierCode live browser download\n');
    return;
  }
  if (req.url === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, source: 'live-smoke' }));
    return;
  }
  if (req.url === '/second') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<meta charset="utf-8">
<title>PierCode Live Browser Second Page</title>
<main>
  <h1>Second approval page</h1>
  <p id="secondStatus">ready for history checks</p>
</main>`);
    return;
  }
  if (req.url !== '/') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<meta charset="utf-8">
<title>PierCode Live Browser Test</title>
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
  #hoverTarget { margin-top: 8px; padding: 12px; background: #fef3c7; width: 180px; }
  #notes { border: 1px solid #94a3b8; min-height: 48px; padding: 8px; width: 320px; }
  #attributeTarget { color: rgb(37, 99, 235); margin-top: 12px; padding: 6px; }
  .spacer { height: 1100px; }
</style>
<main>
  <h1>PierCode live browser report</h1>
  <form id="approvalForm">
    <label>Requester name <input id="name" name="name" placeholder="Name"></label>
    <label>Approver email <input id="email" name="email" placeholder="approver@example.com"></label>
    <label>Priority
      <select id="priority" name="priority">
        <option value="">Choose priority</option>
        <option value="normal">Normal priority</option>
        <option value="high">High priority</option>
      </select>
    </label>
    <label>Department
      <select id="department" name="department">
        <option value="">Choose department</option>
        <option value="finance">Finance</option>
        <option value="legal">Legal</option>
        <option value="ops">Operations</option>
      </select>
    </label>
    <label><input name="category" value="travel" type="radio"> Travel</label>
    <label><input name="category" value="hardware" type="radio"> Hardware</label>
    <label><input id="agree" type="checkbox"> I reviewed the request</label>
    <button id="submitRequest" type="button">Submit request</button>
  </form>
  <div id="notes" contenteditable="true" role="textbox" aria-label="Approval notes"></div>
  <div id="hoverTarget">Hover for details</div>
  <p id="hoverStatus">not hovered</p>
  <button id="coordinateButton" type="button">Coordinate click target</button>
  <p id="coordinateStatus">coordinate not clicked</p>
  <button id="delayedToggle" type="button">Show delayed panel</button>
  <p id="delayedPanel" hidden>Delayed approval panel visible</p>
  <label>Upload receipt <input id="file" type="file"></label>
  <button id="alertButton" onclick="alert('piercode live alert')">Show alert</button>
  <button id="confirmButton" onclick="document.body.dataset.confirmResult = confirm('piercode live confirm') ? 'accepted' : 'dismissed'">Show confirm</button>
  <button id="promptButton" onclick="document.body.dataset.promptResult = prompt('piercode live prompt', '') || ''">Show prompt</button>
  <button id="downloadButton" type="button">Download report</button>
  <a id="downloadLink" href="/download" download>Download report link</a>
  <a id="secondLink" href="/second">Open second page</a>
  <div id="dragSource">Drag invoice</div>
  <div id="dropTarget">Drop approved</div>
  <p id="asyncStatus">waiting</p>
  <p id="submitStatus">not submitted</p>
  <p id="fileStatus">empty</p>
  <p id="dragStatus">not dropped</p>
  <p id="viewportStatus">viewport unknown</p>
  <p id="attributeTarget" data-state="ready" aria-label="Attribute probe">Attribute probe</p>
  <div class="spacer"></div>
  <p id="bottomMarker">Bottom of long approval report</p>
</main>
<script>
  document.cookie = 'piercode_live_cookie=ready; SameSite=Lax';
  console.log('piercode live console ready');
  window.runLiveNetworkPing = () => fetch('/api/ping')
    .then(response => response.json())
    .then(data => {
      console.log('piercode live network ' + data.source);
      return data.source;
    });
  setTimeout(() => {
    document.getElementById('asyncStatus').textContent = 'ready';
  }, 300);
  document.getElementById('hoverTarget').addEventListener('mouseenter', () => {
    document.getElementById('hoverStatus').textContent = 'details visible';
  });
  document.getElementById('coordinateButton').addEventListener('click', () => {
    document.getElementById('coordinateStatus').textContent = 'coordinate clicked';
  });
  document.getElementById('delayedToggle').addEventListener('click', () => {
    setTimeout(() => {
      document.getElementById('delayedPanel').hidden = false;
    }, 250);
  });
  document.getElementById('submitRequest').addEventListener('click', () => {
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const priority = document.getElementById('priority').value;
    const department = document.getElementById('department').value;
    const agreed = document.getElementById('agree').checked;
    const notes = document.getElementById('notes').textContent;
    const category = document.querySelector('input[name="category"]:checked')?.value || '';
    document.getElementById('submitStatus').textContent = [name, email, priority, department, category, agreed ? 'reviewed' : 'not-reviewed', notes].join('|');
  });
  document.getElementById('file').addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    document.getElementById('fileStatus').textContent = files.map(file => file.name + ':' + file.size).join(',');
  });
  document.getElementById('downloadButton').addEventListener('click', () => {
    window.location.href = '/download';
  });
  const source = document.getElementById('dragSource');
  const target = document.getElementById('dropTarget');
  let dragging = false;
  const markDropped = () => {
    document.getElementById('dragStatus').textContent = 'invoice dropped';
  };
  source.addEventListener('mousedown', () => { dragging = true; });
  source.addEventListener('pointerdown', () => { dragging = true; });
  target.addEventListener('mouseup', markDropped);
  target.addEventListener('pointerup', markDropped);
  target.addEventListener('dragover', event => event.preventDefault());
  target.addEventListener('drop', event => {
    event.preventDefault();
    markDropped();
  });
  window.addEventListener('mouseup', event => {
    if (!dragging) return;
    dragging = false;
    const rect = target.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    document.getElementById('dragStatus').textContent = inside ? 'invoice dropped' : 'missed drop';
  });
  function updateViewport() {
    document.getElementById('viewportStatus').textContent = window.innerWidth + 'x' + window.innerHeight;
  }
  window.addEventListener('resize', updateViewport);
  updateViewport();
</script>`);
});
await listen(pageServer, pagePort);
const approvalSocket = await openApprovalSocket();

try {
  const stats = await getStats();
  if (Number(stats.browser_relays || 0) < 1) {
    throw new Error([
      'real Chrome PierCode extension relay is not connected.',
      'Open the user Chrome profile that has PierCode installed, configure the extension with the backend auth URL,',
      `then rerun browser-live-smoke. stats=${JSON.stringify(stats)}`,
    ].join(' '));
  }

  const pageURL = `http://127.0.0.1:${pagePort}/`;
  const secondURL = `http://127.0.0.1:${pagePort}/second`;
  const newTab = await step('create controlled tab', () => execTool('browser_new_tab', { url: pageURL }));
  const tabId = parseTabId(newTab.output);
  if (tabId) controlledTabIds.push(tabId);
  await step('wait for test form', () => execTool('browser_wait', { selector: '#file', state: 'attached', timeout: 10 }));
  const tabs = await step('list available browser tabs', () => execTool('browser_tabs', {}));
  if (!String(tabs.output || '').includes('PierCode Live Browser Test')) {
    throw new Error(`browser_tabs did not include live test tab: ${JSON.stringify(tabs)}`);
  }
  if (tabId) await step('select live test tab from listed tabs', () => execTool('browser_use_tab', { tabId, reason: 'continue live smoke on the visible approval test page' }));

  const snapshot = await step('read accessibility snapshot', () => execTool('browser_snapshot', { maxNodes: 80 }));
  if (!String(snapshot.output || '').includes('PierCode live browser report')) {
    throw new Error(`snapshot did not include page heading: ${JSON.stringify(snapshot)}`);
  }
  const initialSnapshotID = parseSnapshotId(snapshot.output);
  const initialSubmitRef = parseRefForLabel(snapshot.output, 'Submit request');
  if (!initialSnapshotID || !initialSubmitRef) {
    throw new Error(`snapshot did not include reusable submit ref: ${JSON.stringify(snapshot)}`);
  }
  const findSubmit = await step('find submit request control by user-facing text', () => execTool('browser_find', { query: 'Submit request', maxResults: 5 }));
  if (!String(findSubmit.output || '').includes('Submit request')) {
    throw new Error(`browser_find did not find submit button: ${JSON.stringify(findSubmit)}`);
  }

  await step('resize browser window for desktop workflow', () => execTool('browser_resize', { width: 900, height: 700 }));

  await step('set mobile viewport', () => execTool('browser_viewport', { width: 390, height: 844 }));
  const viewport = await step('read actual viewport size', () => execTool('browser_evaluate', {
    expression: "window.innerWidth + 'x' + window.innerHeight",
  }));
  console.log(`live-smoke: viewport status output=${JSON.stringify(viewport.output)}`);
  if (!String(viewport.output || '').includes('390')) {
    throw new Error(`viewport status did not reflect mobile width: ${JSON.stringify(viewport)}`);
  }
  await step('reset viewport', () => execTool('browser_viewport', { reset: true }));
  await step('wait for async page state', () => execTool('browser_wait_for_function', {
    expression: "document.querySelector('#asyncStatus')?.textContent === 'ready'",
    timeout: 10,
  }));
  await step('wait for document load state', () => execTool('browser_wait', { loadState: 'load', timeout: 10 }));

  await step('focus requester name input', () => execTool('browser_focus', { selector: '#name' }));
  await step('type requester name', () => execTool('browser_type', { selector: '#name', text: 'Ada Lovelace', clear: true }));
  await step('type approver email and submit with Enter', () => execTool('browser_type', { selector: '#email', text: 'ops@example.test', clear: true, submit: true }));
  await step('press End in requester name input', () => execTool('browser_press_key', { key: 'End' }));
  await step('select high priority by visible label', () => execTool('browser_select', { selector: '#priority', value: 'High priority', by: 'label' }));
  await step('select normal priority by value', () => execTool('browser_select', { selector: '#priority', value: 'normal', by: 'value' }));
  await step('select high priority by index', () => execTool('browser_select', { selector: '#priority', value: '2', by: 'index' }));
  await step('select finance department by value', () => execTool('browser_select', { selector: '#department', value: 'finance', by: 'value' }));
  await step('check reviewed checkbox', () => execTool('browser_form_input', { selector: '#agree', value: true }));
  await step('choose travel category radio', () => execTool('browser_form_input', { selector: 'input[name="category"][value="travel"]', value: true }));
  await step('fill approval notes contenteditable', () => execTool('browser_form_input', { selector: '#notes', value: 'Receipt checked and ready.' }));
  await step('hover details panel', () => execTool('browser_hover', { selector: '#hoverTarget', waitAfterHover: 100 }));
  const hoverStatus = await step('read hover status', () => execTool('browser_get_content', { selector: '#hoverStatus' }));
  if (!String(hoverStatus.output || '').includes('details visible')) {
    throw new Error(`hover status did not update: ${JSON.stringify(hoverStatus)}`);
  }
  await step('click delayed panel toggle', () => execTool('browser_click', { selector: '#delayedToggle' }));
  await step('wait for delayed panel visible', () => execTool('browser_wait', { selector: '#delayedPanel', state: 'visible', timeout: 10 }));
  const coordinatePoint = await step('compute coordinate click point', () => execTool('browser_evaluate', {
    expression: "(() => { const r = document.querySelector('#coordinateButton').getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2); })()",
  }));
  const [clickX, clickY] = parseCoordinateValue(coordinatePoint.output);
  await step('click coordinate target by x/y', () => execTool('browser_click', { x: clickX, y: clickY }));
  const coordinateStatus = await step('read coordinate click status', () => execTool('browser_get_content', { selector: '#coordinateStatus' }));
  if (!String(coordinateStatus.output || '').includes('coordinate clicked')) {
    throw new Error(`coordinate click did not update status: ${JSON.stringify(coordinateStatus)}`);
  }
  const freshSnapshot = await step('refresh accessibility snapshot before ref click', () => execTool('browser_snapshot', { maxNodes: 120 }));
  const freshSnapshotID = parseSnapshotId(freshSnapshot.output);
  const freshSubmitRef = parseRefForLabel(freshSnapshot.output, 'Submit request');
  if (!freshSnapshotID || !freshSubmitRef) {
    throw new Error(`fresh snapshot did not include submit ref: ${JSON.stringify(freshSnapshot)}`);
  }
  await step('click submit request button by fresh snapshot ref', () => execTool('browser_click', { snapshotId: freshSnapshotID, ref: freshSubmitRef }));
  const submitStatus = await step('read submitted form status', () => execTool('browser_get_content', { selector: '#submitStatus' }));
  if (!String(submitStatus.output || '').includes('Ada Lovelace|ops@example.test|high|finance|travel|reviewed|Receipt checked')) {
    throw new Error(`submitted form status was wrong: ${JSON.stringify(submitStatus)}`);
  }
  await step('scroll to bottom marker', () => execTool('browser_scroll', { selector: '#bottomMarker' }));
  const bottom = await step('read bottom marker', () => execTool('browser_get_content', { selector: '#bottomMarker' }));
  if (!String(bottom.output || '').includes('Bottom of long approval report')) {
    throw new Error(`bottom marker was not readable after scroll: ${JSON.stringify(bottom)}`);
  }
  const structured = await step('read structured page content', () => execTool('browser_get_content', { format: 'structured', selector: 'main' }));
  if (!String(structured.output || '').includes('Submit request')) {
    throw new Error(`structured content missed form: ${JSON.stringify(structured)}`);
  }
  const htmlContent = await step('read form HTML content', () => execTool('browser_get_content', { format: 'html', selector: '#approvalForm' }));
  if (!String(htmlContent.output || '').includes('Requester name')) {
    throw new Error(`html content missed form: ${JSON.stringify(htmlContent)}`);
  }
  const fullText = await step('read full page text content', () => execTool('browser_get_content', { format: 'text' }));
  if (!String(fullText.output || '').includes('PierCode live browser report')) {
    throw new Error(`full text content missed heading: ${JSON.stringify(fullText)}`);
  }

  const upload = await step('upload fixture', () => execTool('browser_upload', { selector: '#file', paths: [uploadFixture] }));
  const fileStatus = await step('read upload status', () => execTool('browser_get_content', { selector: '#fileStatus' }));
  if (!String(fileStatus.output || '').includes('upload-fixture.txt')) {
    throw new Error(`upload status did not include fixture name: ${JSON.stringify(fileStatus)}`);
  }

  const drag = await step('drag invoice to approval target', () => execTool('browser_drag', { fromSelector: '#dragSource', toSelector: '#dropTarget' }));
  const dragStatus = await step('read drag status', () => execTool('browser_get_content', { selector: '#dragStatus' }));
  if (!String(dragStatus.output || '').includes('invoice dropped')) {
    throw new Error(`drag status did not show successful drop: ${JSON.stringify(dragStatus)}`);
  }

  const pdf = await step('export page to PDF', () => execTool('browser_pdf', { outputPath: pdfOutput, format: 'A4' }));
  if (!existsSync(pdfOutput) || statSync(pdfOutput).size < 1000) {
    throw new Error(`PDF was not written or is too small: ${pdfOutput}`);
  }
  const screenshot = await step('capture screenshot file', () => execTool('browser_screenshot', { format: 'png', fullPage: false, attach: false }));
  const screenshotPath = parseSavedPath(screenshot.output);
  if (!screenshotPath || !existsSync(screenshotPath) || statSync(screenshotPath).size < 1000) {
    throw new Error(`screenshot was not written or is too small: ${JSON.stringify(screenshot)}`);
  }
  const zoom = await step('capture zoomed form region', () => execTool('browser_zoom', { selector: '#approvalForm', width: 360, height: 180 }));
  const zoomPath = parseSavedPath(zoom.output);
  if (!zoomPath || !existsSync(zoomPath) || statSync(zoomPath).size < 1000) {
    throw new Error(`zoom screenshot was not written or is too small: ${JSON.stringify(zoom)}`);
  }

  const fullPageScreenshot = await step('capture full-page jpeg screenshot', () => execTool('browser_screenshot', { format: 'jpeg', quality: 65, fullPage: true, attach: false }));
  const fullPageScreenshotPath = parseSavedPath(fullPageScreenshot.output);
  if (!fullPageScreenshotPath || !existsSync(fullPageScreenshotPath) || statSync(fullPageScreenshotPath).size < 1000) {
    throw new Error(`full-page screenshot was not written or is too small: ${JSON.stringify(fullPageScreenshot)}`);
  }

  await step('trigger browser console error', () => execTool('browser_evaluate', {
    expression: "(() => { console.error('piercode live expected error'); return 'logged-error'; })()",
  }));
  const consoleLog = await step('read browser console log', () => execTool('browser_console', { pattern: 'piercode live', limit: 10 }));
  if (!String(consoleLog.output || '').includes('piercode live')) {
    throw new Error(`console log did not include live message: ${JSON.stringify(consoleLog)}`);
  }
  const consoleErrors = await step('read browser console onlyErrors and clear', () => execTool('browser_console', { onlyErrors: true, clear: true, limit: 10 }));
  if (!String(consoleErrors.output || '').includes('piercode live expected error')) {
    throw new Error(`console onlyErrors did not include expected error: ${JSON.stringify(consoleErrors)}`);
  }
  const consoleAfterClear = await step('verify browser console clear', () => execTool('browser_console', { pattern: 'piercode live expected error', limit: 10 }));
  if (!String(consoleAfterClear.output || '').includes('No console messages recorded')) {
    throw new Error(`console clear did not empty expected error: ${JSON.stringify(consoleAfterClear)}`);
  }
  await step('prime browser network listener', () => execTool('browser_network', { clear: true, limit: 1 }));
  await step('trigger network request after network listener is enabled', () => execTool('browser_evaluate', {
    expression: 'window.runLiveNetworkPing()',
  }));
  const network = await step('read browser network log', () => execTool('browser_network', { urlPattern: '/api/ping', limit: 10 }));
  if (!String(network.output || '').includes('/api/ping')) {
    throw new Error(`network log did not include api ping: ${JSON.stringify(network)}`);
  }
  const networkCleared = await step('clear browser network log for api ping', () => execTool('browser_network', { urlPattern: '/api/ping', clear: true, limit: 10 }));
  if (!String(networkCleared.output || '').includes('/api/ping')) {
    throw new Error(`network clear read did not include api ping before clearing: ${JSON.stringify(networkCleared)}`);
  }
  const networkAfterClear = await step('verify browser network clear', () => execTool('browser_network', { urlPattern: '/api/ping', limit: 10 }));
  if (!String(networkAfterClear.output || '').includes('No network requests recorded')) {
    throw new Error(`network clear did not empty expected request: ${JSON.stringify(networkAfterClear)}`);
  }
  const cookies = await step('read local test cookie names', () => execTool('browser_cookies', { url: pageURL, includeValue: false }));
  if (!String(cookies.output || '').includes('piercode_live_cookie')) {
    throw new Error(`cookies did not include live cookie: ${JSON.stringify(cookies)}`);
  }
  const cookiesWithValue = await step('read local test cookie value', () => execTool('browser_cookies', { url: pageURL, includeValue: true, limit: 10 }));
  if (!String(cookiesWithValue.output || '').includes('piercode_live_cookie=ready')) {
    throw new Error(`cookies with value did not include live cookie value: ${JSON.stringify(cookiesWithValue)}`);
  }

  const storageSet = await step('set localStorage value', () => execTool('browser_storage', {
    action: 'set',
    storage: 'local',
    key: 'piercode_live_storage',
    value: 'stored-value',
  }));
  const storageGet = await step('read localStorage value', () => execTool('browser_storage', {
    action: 'get',
    storage: 'local',
    key: 'piercode_live_storage',
  }));
  if (!String(storageGet.output || '').includes('stored-value')) {
    throw new Error(`localStorage get did not include stored value: ${JSON.stringify(storageGet)}`);
  }
  const storageKeys = await step('list localStorage keys', () => execTool('browser_storage', {
    action: 'keys',
    storage: 'local',
  }));
  if (!String(storageKeys.output || '').includes('piercode_live_storage')) {
    throw new Error(`localStorage keys did not include test key: ${JSON.stringify(storageKeys)}`);
  }
  const sessionSet = await step('set sessionStorage value', () => execTool('browser_storage', {
    action: 'set',
    storage: 'session',
    key: 'piercode_live_session',
    value: 'session-value',
  }));
  const sessionGet = await step('read sessionStorage value', () => execTool('browser_storage', {
    action: 'get',
    storage: 'session',
    key: 'piercode_live_session',
  }));
  if (!String(sessionGet.output || '').includes('session-value')) {
    throw new Error(`sessionStorage get did not include stored value: ${JSON.stringify(sessionGet)}`);
  }
  const storageRemove = await step('remove localStorage value', () => execTool('browser_storage', {
    action: 'remove',
    storage: 'local',
    key: 'piercode_live_storage',
  }));
  const storageRemoved = await step('verify localStorage value removed', () => execTool('browser_storage', {
    action: 'get',
    storage: 'local',
    key: 'piercode_live_storage',
  }));
  if (!String(storageRemoved.output || '').includes('(null)')) {
    throw new Error(`localStorage remove did not clear value: ${JSON.stringify(storageRemoved)}`);
  }
  const sessionClear = await step('clear sessionStorage values', () => execTool('browser_storage', {
    action: 'clear',
    storage: 'session',
  }));

  const setCookieCallId = 'live-smoke-set-cookie-approve';
  approvalDecisions.push({ approved: true, reason: 'live smoke approves local cookie write', callId: setCookieCallId });
  const setCookie = await step('set local test cookie through extension', () => execTool('browser_set_cookie', {
    action: 'set',
    url: pageURL,
    name: 'piercode_live_set_cookie',
    value: 'native-value',
    sameSite: 'lax',
    call_id: setCookieCallId,
  }));
  await step('wait for set-cookie approval completion notice', () => waitForApprovalDone(setCookieCallId));
  const setCookieRead = await step('read newly set cookie value', () => execTool('browser_cookies', { url: pageURL, includeValue: true, limit: 20 }));
  if (!String(setCookieRead.output || '').includes('piercode_live_set_cookie=native-value')) {
    throw new Error(`newly set cookie was not readable: ${JSON.stringify(setCookieRead)}`);
  }
  const deleteCookieCallId = 'live-smoke-delete-cookie-approve';
  approvalDecisions.push({ approved: true, reason: 'live smoke approves local cookie delete', callId: deleteCookieCallId });
  const deleteCookie = await step('delete local test cookie through extension', () => execTool('browser_set_cookie', {
    action: 'delete',
    url: pageURL,
    name: 'piercode_live_set_cookie',
    call_id: deleteCookieCallId,
  }));
  await step('wait for delete-cookie approval completion notice', () => waitForApprovalDone(deleteCookieCallId));
  const deletedCookieRead = await step('verify deleted cookie is absent', () => execTool('browser_cookies', { url: pageURL, includeValue: true, limit: 20 }));
  if (String(deletedCookieRead.output || '').includes('piercode_live_set_cookie=native-value')) {
    throw new Error(`deleted cookie was still readable: ${JSON.stringify(deletedCookieRead)}`);
  }

  const attributes = await step('read attributes and computed style', () => execTool('browser_get_attributes', {
    selector: '#attributeTarget',
    attributes: ['id', 'data-state', 'aria-label', 'missing-attribute'],
    styles: ['color', 'margin-top'],
  }));
  const attributesOutput = String(attributes.output || '');
  if (!attributesOutput.includes('"data-state":"ready"') ||
      !attributesOutput.includes('"missing-attribute":null') ||
      !attributesOutput.includes('"color":"rgb(37, 99, 235)"')) {
    throw new Error(`attributes output missed expected values: ${JSON.stringify(attributes)}`);
  }

  const emulate = await step('emulate UA, DPR, dark mode, and timezone', () => execTool('browser_emulate', {
    userAgent: 'PierCodeLiveSmoke/1.0',
    deviceScaleFactor: 2,
    mobile: true,
    colorScheme: 'dark',
    timezone: 'America/New_York',
  }));
  const emulatedState = await step('verify emulated browser state', () => execTool('browser_evaluate', {
    expression: "JSON.stringify({ ua: navigator.userAgent, dpr: window.devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })",
  }));
  const emulatedOutput = String(emulatedState.output || '');
  if (!emulatedOutput.includes('PierCodeLiveSmoke/1.0') ||
      !emulatedOutput.includes('"dpr":2') ||
      !emulatedOutput.includes('"dark":true') ||
      !emulatedOutput.includes('"timezone":"America/New_York"')) {
    throw new Error(`emulated state did not include expected overrides: ${JSON.stringify(emulatedState)}`);
  }
  const emulateReset = await step('reset emulation overrides', () => execTool('browser_emulate', { reset: true }));
  const resetState = await step('verify emulation reset cleared UA override', () => execTool('browser_evaluate', {
    expression: "navigator.userAgent",
  }));
  if (String(resetState.output || '').includes('PierCodeLiveSmoke/1.0')) {
    throw new Error(`emulation reset did not clear UA override: ${JSON.stringify(resetState)}`);
  }

  await step('trigger link navigation to second page', () => execTool('browser_click', { selector: '#secondLink' }));
  const navigationWait = await step('wait for second-page navigation', () => execTool('browser_wait_for_navigation', {
    urlPattern: '/second',
    waitUntil: 'load',
    timeout: 10,
  }));
  if (!String(navigationWait.output || '').includes('/second')) {
    throw new Error(`wait_for_navigation did not report second page URL: ${JSON.stringify(navigationWait)}`);
  }
  await step('return to report page after wait_for_navigation', () => execTool('browser_navigate', { url: pageURL }));
  await step('wait for report after wait_for_navigation test', () => execTool('browser_wait', { selector: '#downloadButton', state: 'visible', timeout: 10 }));

  await step('click report download button', () => execTool('browser_click', { selector: '#downloadButton' }));
  const downloads = await step('read browser download history', waitForLiveDownload);

  await step('navigate to second page', () => execTool('browser_navigate', { url: secondURL }));
  await step('wait for second page load', () => execTool('browser_wait', { selector: '#secondStatus', state: 'visible', timeout: 10 }));
  await step('go back to report page', () => execTool('browser_go_back', {}));
  await step('wait for report after back', () => execTool('browser_wait', { selector: '#submitRequest', state: 'visible', timeout: 10 }));
  await step('go forward to second page', () => execTool('browser_go_forward', {}));
  await step('wait for second page after forward', () => execTool('browser_wait', { selector: '#secondStatus', state: 'visible', timeout: 10 }));
  await step('reload second page', () => execTool('browser_reload', { ignoreCache: true }));
  await step('wait for second page after reload', () => execTool('browser_wait', { selector: '#secondStatus', state: 'visible', timeout: 10 }));
  await step('navigate back to report page for dialog test', () => execTool('browser_navigate', { url: pageURL }));
  await step('wait for report before dialog test', () => execTool('browser_wait', { selector: '#alertButton', state: 'visible', timeout: 10 }));

  const approvedApprovalCallId = 'live-smoke-explicit-approval-approve';
  approvalDecisions.push({ approved: true, reason: 'live smoke explicit approval check', callId: approvedApprovalCallId });
  const approvedClick = await step('approve a harmless browser click approval', () => execTool('browser_click', {
    selector: '#coordinateButton',
    call_id: approvedApprovalCallId,
  }));
  await step('wait for approved approval completion notice', () => waitForApprovalDone(approvedApprovalCallId));

  const rejectedApprovalCallId = 'live-smoke-explicit-approval-reject';
  approvalDecisions.push({ approved: false, reason: 'live smoke rejection check', callId: rejectedApprovalCallId });
  const rejectedClick = await step('reject a harmless browser click approval', () => execToolAllowError('browser_click', {
    selector: '#submitRequest',
    call_id: rejectedApprovalCallId,
  }));
  if (rejectedClick.status !== 'error' || !String(rejectedClick.error || '').includes('live smoke rejection check')) {
    throw new Error(`approval rejection did not stop the browser action: ${JSON.stringify(rejectedClick)}`);
  }
  await step('wait for rejected approval completion notice', () => waitForApprovalDone(rejectedApprovalCallId));
  if (approvalStats.mismatches.length > 0) {
    throw new Error(`approval call_id mismatch: ${approvalStats.mismatches.join('; ')}`);
  }
  if (approvalStats.approved < 1 || approvalStats.rejected < 1) {
    throw new Error(`approval flow did not cover approve and reject: ${JSON.stringify(summarizeApprovalStats())}`);
  }

  await step('schedule JavaScript alert', () => execTool('browser_evaluate', {
    expression: "(() => { setTimeout(() => alert('piercode live alert'), 1200); return 'scheduled'; })()",
  }));
  const dialog = await step('accept JavaScript alert', () => execTool('browser_handle_dialog', { action: 'accept', timeout: 10 }));
  await step('schedule JavaScript confirm', () => execTool('browser_evaluate', {
    expression: "(() => { setTimeout(() => document.querySelector('#confirmButton').click(), 500); return 'confirm-scheduled'; })()",
  }));
  const confirmDialog = await step('dismiss JavaScript confirm', () => execTool('browser_handle_dialog', { action: 'dismiss', timeout: 10 }));
  const confirmResult = await step('verify dismissed confirm result', () => execTool('browser_evaluate', {
    expression: "document.body.dataset.confirmResult",
  }));
  if (!String(confirmResult.output || '').includes('dismissed')) {
    throw new Error(`confirm dismiss did not set expected result: ${JSON.stringify(confirmResult)}`);
  }
  await step('schedule JavaScript prompt', () => execTool('browser_evaluate', {
    expression: "(() => { setTimeout(() => document.querySelector('#promptButton').click(), 500); return 'prompt-scheduled'; })()",
  }));
  const promptDialog = await step('accept JavaScript prompt with text', () => execTool('browser_handle_dialog', { action: 'accept', promptText: 'approved prompt text', timeout: 10 }));
  const promptResult = await step('verify prompt result text', () => execTool('browser_evaluate', {
    expression: "document.body.dataset.promptResult",
  }));
  if (!String(promptResult.output || '').includes('approved prompt text')) {
    throw new Error(`prompt accept did not set expected result: ${JSON.stringify(promptResult)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    pageURL,
    upload: upload.output,
    fileStatus: fileStatus.output,
    tabs: tabs.output,
    snapshot: snapshot.output.split('\n').slice(0, 6).join('\n'),
    findSubmit: findSubmit.output,
    hoverStatus: hoverStatus.output,
    submitStatus: submitStatus.output,
    coordinateStatus: coordinateStatus.output,
    htmlContent: htmlContent.output.slice(0, 300),
    fullText: fullText.output.slice(0, 300),
    screenshot: screenshot.output,
    fullPageScreenshot: fullPageScreenshot.output,
    zoom: zoom.output,
    console: consoleLog.output,
    consoleErrors: consoleErrors.output,
    consoleAfterClear: consoleAfterClear.output,
    network: network.output,
    networkAfterClear: networkAfterClear.output,
    cookies: cookies.output,
    cookiesWithValue: cookiesWithValue.output,
    storageSet: storageSet.output,
    storageGet: storageGet.output,
    storageKeys: storageKeys.output,
    sessionSet: sessionSet.output,
    sessionGet: sessionGet.output,
    storageRemove: storageRemove.output,
    storageRemoved: storageRemoved.output,
    sessionClear: sessionClear.output,
    setCookie: setCookie.output,
    setCookieRead: setCookieRead.output,
    deleteCookie: deleteCookie.output,
    deletedCookieRead: deletedCookieRead.output,
    attributes: attributes.output,
    emulate: emulate.output,
    emulatedState: emulatedState.output,
    emulateReset: emulateReset.output,
    resetState: resetState.output,
    navigationWait: navigationWait.output,
    rejectedClick: rejectedClick.error,
    viewport: viewport.output,
    drag: drag.output,
    dragStatus: dragStatus.output,
    pdf: pdf.output,
    downloads: downloads.output,
    approvedClick: approvedClick.output,
    dialog: dialog.output,
    confirmDialog: confirmDialog.output,
    promptDialog: promptDialog.output,
    approvals: summarizeApprovalStats(),
  }, null, 2));
} finally {
  if (controlledTabIds.length > 0) {
    await execTool('browser_finalize_tabs', { closeTabIds: controlledTabIds, closeClaimedTabs: true }).catch(error => {
      console.warn(`live-smoke: tab cleanup failed: ${error.message || error}`);
    });
  }
  approvalSocket.close();
  await closeServer(pageServer);
  rmSync(uploadFixture, { force: true });
  rmSync(pdfOutput, { force: true });
}

function openApprovalSocket() {
  const wsURL = apiUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + `/ws?token=${encodeURIComponent(token)}&client=live-smoke-approval&provider=LiveSmoke`;
  const ws = new WebSocket(wsURL);
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'browser_approval_ask' && msg.approval_id) {
      const decision = approvalDecisions.shift() || { approved: true, reason: 'live smoke test auto approval' };
      approvalStats.asked += 1;
      if (decision.approved) approvalStats.approved += 1;
      else approvalStats.rejected += 1;
      approvalStats.actions.push({
        approval_id: msg.approval_id,
        call_id: msg.call_id || '',
        action: msg.action || '',
        approved: decision.approved,
        reason: decision.reason,
      });
      if (decision.callId && msg.call_id !== decision.callId) {
        approvalStats.mismatches.push(`expected ${decision.callId}, got ${msg.call_id || '<empty>'}`);
      }
      ws.send(JSON.stringify({
        type: 'browser_approval_answer',
        approval_id: msg.approval_id,
        approved: decision.approved,
        reason: decision.reason,
      }));
    } else if (msg.type === 'browser_approval_done') {
      approvalStats.done += 1;
      const callId = msg.call_id || '';
      if (callId) {
        approvalStats.doneCallIds.add(callId);
        const waiter = approvalStats.doneWaiters.get(callId);
        if (waiter) {
          approvalStats.doneWaiters.delete(callId);
          waiter.resolve({ callId });
        }
      }
    }
  });
  return waitForOpen(ws).then(() => ws);
}

function waitForApprovalDone(callId) {
  if (approvalStats.doneCallIds.has(callId)) {
    return Promise.resolve({ callId });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      approvalStats.doneWaiters.delete(callId);
      reject(new Error(`approval done not observed for ${callId}`));
    }, 5000);
    approvalStats.doneWaiters.set(callId, {
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

function summarizeApprovalStats() {
  return {
    asked: approvalStats.asked,
    approved: approvalStats.approved,
    rejected: approvalStats.rejected,
    done: approvalStats.done,
    doneCallIds: Array.from(approvalStats.doneCallIds),
    actions: approvalStats.actions,
    mismatches: approvalStats.mismatches,
  };
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('approval websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('approval websocket error'));
    }, { once: true });
  });
}

async function getStats() {
  const response = await fetch(`${apiUrl}/stats`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`/stats HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function execTool(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, call_id: `live-smoke-${name}-${Date.now()}`, args }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`${name} HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    const message = body.error || body.output || JSON.stringify(body);
    if (SW_DIRECT_DISABLED_RE.test(String(message))) {
      throw new Error(swDirectRelayError(name, message));
    }
    throw new Error(`${name} failed: ${message}`);
  }
  return body;
}

async function execToolAllowError(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, call_id: `live-smoke-${name}-${Date.now()}`, args }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`${name} HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  if (body.status !== 'success') {
    const message = body.error || body.output || JSON.stringify(body);
    if (SW_DIRECT_DISABLED_RE.test(String(message))) {
      throw new Error(swDirectRelayError(name, message));
    }
  }
  return body;
}

async function step(label, fn) {
  process.stdout.write(`live-smoke: ${label}... `);
  try {
    const result = await fn();
    process.stdout.write('ok\n');
    return result;
  } catch (error) {
    process.stdout.write('failed\n');
    throw error;
  }
}

async function waitForLiveDownload() {
  const deadline = Date.now() + 15000;
  const downloadURL = `http://127.0.0.1:${pagePort}/download`;
  const downloadName = `piercode-live-report-${pagePort}.txt`;
  let last;
  while (Date.now() < deadline) {
    last = await execTool('browser_downloads', { state: 'complete', limit: 25 });
    const output = String(last.output || '');
    if (output.includes(downloadName) && output.includes(downloadURL)) return last;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`download history did not include current live report URL ${downloadURL}: ${JSON.stringify(last)}`);
}

function parseTabId(output) {
  const match = String(output || '').match(/\btabId=(\d+)\b/);
  return match ? Number(match[1]) : 0;
}

function parseSnapshotId(output) {
  const match = String(output || '').match(/\bsnapshotId=(snap_[^\s]+)/);
  return match ? match[1] : '';
}

function parseRefForLabel(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[(e\\d+)\\]\\s+button\\s+"${escaped}"`);
  const match = String(output || '').match(re);
  return match ? match[1] : '';
}

function parseCoordinateValue(output) {
  const match = String(output || '').match(/value=(\d+),(\d+)/);
  if (!match) {
    throw new Error(`could not parse coordinate output: ${output}`);
  }
  return [Number(match[1]), Number(match[2])];
}

function parseSavedPath(output) {
  const text = String(output || '');
  const saved = text.match(/Saved to:\s*(.+)$/m);
  if (saved) return saved[1].trim();
  const zoom = text.match(/zoom screenshot saved:\s*(.+?)\s*\(\d+ bytes\)/);
  return zoom ? zoom[1].trim() : '';
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
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}
