import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import WebSocket from 'ws';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runDir = join(repoRoot, '.piercode', 'tools-e2e');
const rootDir = join(runDir, 'workspace');
const serverExe = join(runDir, process.platform === 'win32' ? 'piercode-tools-e2e.exe' : 'piercode-tools-e2e');
const token = 'e'.repeat(64);

rmSync(runDir, { recursive: true, force: true });
mkdirSync(rootDir, { recursive: true });
mkdirSync(join(rootDir, '.skills', 'receipt-review'), { recursive: true });
writeFileSync(join(rootDir, '.skills', 'receipt-review', 'SKILL.md'), [
  '---',
  'name: receipt-review',
  'description: Review purchase receipts and approval notes',
  '---',
  '',
  '# Receipt Review',
  '',
  'Check request owner, receipt total, and approval state.',
  '',
].join('\n'), 'utf8');

runChecked('go', ['build', '-o', serverExe, './cmd/server'], repoRoot);

const port = await freePort();
const toolEvents = {
  streams: [],
  taskDone: [],
  injects: [],
  questions: [],
};
let ws;
let piercode;
const localFetchServer = createServer((req, res) => {
  if (req.url === '/receipt') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Receipt E2E</title><main><h1>Receipt lookup</h1><p>Ada approved invoice 42.</p></main>');
    return;
  }
  res.writeHead(404).end('not found');
});
const localFetchPort = await freePort();
await listen(localFetchServer, localFetchPort);

try {
  piercode = spawn(serverExe, [
    '-port', String(port),
    '-dir', rootDir,
    '-timeout', '15',
    '-token', token,
  ], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  piercode.stdout.on('data', chunk => process.stdout.write(chunk));
  piercode.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitForHTTP(`${apiURL()}/health`, {}, body => body.status === 'ok');
  await waitForHTTP(`${apiURL()}/stats`, authHeaders(), body => typeof body.browser_clients === 'number');

  ws = await openEventSocket();

  await step('POST /auth validates fixed token', async () => {
    const body = await postJSON('/auth', { token });
    assert(body.valid === true, `/auth did not accept fixed token: ${JSON.stringify(body)}`);
  });
  await step('GET /config returns test workspace', async () => {
    const body = await getJSON('/config');
    assert(body.rootDir === rootDir, `/config rootDir mismatch: ${JSON.stringify(body)}`);
  });
  await step('GET /tools exposes every non-browser bridge tool', async () => {
    const body = await getJSON('/tools');
    const names = new Set((body.tools || []).map(t => t.name));
    for (const name of [
      'exec_cmd', 'list_dir', 'read_file', 'write_file', 'apply_patch', 'glob',
      'grep', 'edit', 'multi_edit', 'move', 'undo', 'web_fetch', 'question',
      'skill', 'todo_write', 'todo_read', 'task_list', 'task_output',
      'task_stop', 'send_stdin', 'tool_help',
    ]) {
      assert(names.has(name), `/tools missing ${name}`);
    }
  });
  await step('POST /cwd changes and restores workspace within sandbox', async () => {
    mkdirSync(join(rootDir, 'sub-workspace'), { recursive: true });
    const sub = await postJSON('/cwd', { path: 'sub-workspace' });
    assert(sub.rootDir.endsWith('sub-workspace'), `/cwd did not switch to subdir: ${JSON.stringify(sub)}`);
    const restored = await postJSON('/cwd', { path: rootDir });
    assert(restored.rootDir === rootDir, `/cwd did not restore root: ${JSON.stringify(restored)}`);
  });
  await step('GET /prompt renders embedded prompt and tool list', async () => {
    const text = await getText('/prompt?profile=qwen');
    assert(text.includes('PierCode'), '/prompt missed PierCode identity');
    assert(text.includes('write_file'), '/prompt missed tool list');
  });
  await step('GET /skills lists workspace skill', async () => {
    const body = await getJSON('/skills');
    const text = JSON.stringify(body);
    assert(text.includes('receipt-review'), `/skills missed test skill: ${text}`);
  });

  await execSuccess('write_file', {
    path: 'orders/receipt.txt',
    content: 'Requester: Ada Lovelace\nAmount: 42\nStatus: pending\nReviewer: Grace Hopper\n',
  }, out => out.includes('写入成功'));
  await execSuccess('write_file', {
    path: 'orders/receipt.txt',
    mode: 'append',
    content: 'Note: rush request\n',
  }, out => out.includes('写入成功'));
  await execSuccess('read_file', {
    path: 'orders/receipt.txt',
    offset: 1,
    limit: 3,
  }, out => out.includes('Requester: Ada Lovelace') && /^\s*1\t/m.test(out));
  await execSuccess('list_dir', { path: 'orders' }, out => out.includes('receipt.txt'));
  await execSuccess('glob', { pattern: '**/*.txt' }, out => out.includes('receipt.txt'));
  await execSuccess('grep', { pattern: 'Ada|Grace', path: 'orders', include: '*.txt' }, out => out.includes('Ada Lovelace'));
  await execSuccess('edit', {
    path: 'orders/receipt.txt',
    old_string: 'Status: pending',
    new_string: 'Status: approved',
  }, out => out.includes('已替换'));
  await execSuccess('multi_edit', {
    path: 'orders/receipt.txt',
    edits: [
      { old_string: 'Amount: 42', new_string: 'Amount: 43' },
      { old_string: 'Note: rush request', new_string: 'Note: receipt verified' },
    ],
  }, out => out.includes('2 处编辑'));
  await execSuccess('apply_patch', {
    patch: [
      '*** Begin Patch',
      '*** Add File: orders/approval.md',
      '+# Approval',
      '+',
      '+Approved by Grace for Ada.',
      '*** End Patch',
    ].join('\n'),
    final_newline: 'add',
  }, out => out.includes('orders/approval.md'));
  await execSuccess('move', {
    from: 'orders/approval.md',
    to: 'archive/approval.md',
  }, out => out.includes('已移动'));
  await execSuccess('undo', { action: 'list' }, out => out.includes('Snapshots'));
  await execSuccess('undo', { action: 'revert' }, out => out.includes('已回滚快照'));
  await execSuccess('tool_help', { tool: 'write_file' }, out => out.includes('write_file') && out.includes('content'));
  await execSuccess('skill', {}, out => out.includes('receipt-review'));
  await execSuccess('skill', { skill: 'receipt-review' }, out => out.includes('<skill_content') && out.includes('Receipt Review'));
  await execSuccess('todo_write', {
    todos: [
      { text: 'Collect receipt', status: 'completed' },
      { text: 'Verify approval', status: 'in_progress' },
      { text: 'Archive packet', status: 'pending' },
    ],
  }, out => out.includes('[x] Collect receipt') && out.includes('[~] Verify approval'));
  await execSuccess('todo_read', {}, out => out.includes('当前有 3 个任务') && out.includes('Archive packet'));

  await execSuccess('exec_cmd', {
    command: 'node -e "console.log(\'receipt cli ok\')"',
  }, out => out.includes('receipt cli ok'));
  const bg = await execTool('exec_cmd', {
    command: 'node -e "process.stdin.on(\'data\', d => console.log(\'STDIN:\' + d.toString().trim())); setInterval(() => {}, 1000)"',
    background: true,
  }, { allowedStatuses: ['running'] });
  const taskID = parseTaskID(bg.output);
  assert(taskID, `could not parse background task id: ${bg.output}`);
  await execSuccess('task_list', { status: 'running' }, out => out.includes(taskID));
  await execSuccess('send_stdin', { task_id: taskID, data: 'approval-id=42' }, out => out.includes('stdin'));
  await waitUntil(async () => {
    const body = await execTool('task_output', { task_id: taskID });
    return body.output.includes('STDIN:approval-id=42') ? body : null;
  }, `task_output did not show stdin echo for ${taskID}`);
  await execSuccess('task_stop', { task_id: taskID }, out => out.includes(taskID));
  await waitUntil(async () => {
    const body = await execTool('task_output', { task_id: taskID });
    return /\[(canceled|failed|done)\]/.test(body.output) ? body : null;
  }, `task ${taskID} did not stop`);
  await step('REST /tasks endpoints expose background task state', async () => {
    const list = await getJSON('/tasks');
    assert(JSON.stringify(list).includes(taskID), `/tasks did not include ${taskID}: ${JSON.stringify(list)}`);
    const detail = await getJSON(`/tasks/${encodeURIComponent(taskID)}`);
    assert(JSON.stringify(detail).includes('STDIN:approval-id=42'), `/tasks/:id missed stdout: ${JSON.stringify(detail)}`);
  });

  await step('web_fetch rejects proxy-mapped internal DNS target', async () => {
    const body = await execTool('web_fetch', { url: 'https://example.com', format: 'text' }, { allowedStatuses: ['error'] });
    assert((body.error || body.output).includes('private/internal') || (body.error || body.output).includes('internal address'), `web_fetch did not reject proxy-mapped internal DNS: ${JSON.stringify(body)}`);
  });
  await step('web_fetch blocks loopback SSRF target', async () => {
    const body = await execTool('web_fetch', { url: `http://127.0.0.1:${localFetchPort}/receipt` }, { allowedStatuses: ['error'] });
    assert((body.error || body.output).includes('private/internal') || (body.error || body.output).includes('internal address'), `web_fetch did not block loopback: ${JSON.stringify(body)}`);
  });

  await step('question broadcasts over WS and receives answer', async () => {
    const callID = 'tools-e2e-question';
    const promise = execTool('question', {
      question: 'Which approval route should the E2E choose?',
      options: ['standard', 'expedite'],
      timeout_sec: 10,
    }, { callID });
    await waitUntil(() => toolEvents.questions.find(q => q.call_id === callID) || null, 'question_ask was not observed');
    ws.send(JSON.stringify({ type: 'question_answer', call_id: callID, answer: 'standard' }));
    const answer = await promise;
    assert(answer.output.includes('A: standard'), `question answer mismatch: ${JSON.stringify(answer)}`);
  });

  await step('POST /inject broadcasts visible text over WS', async () => {
    const injected = await postJSON('/inject', { text: 'E2E injection message' });
    assert(injected.status === 'injected', `/inject failed: ${JSON.stringify(injected)}`);
    await waitUntil(() => toolEvents.injects.find(msg => msg.text === 'E2E injection message') || null, 'inject event was not observed');
  });

  await step('foreground exec_cmd streamed chunks over WS', async () => {
    const callID = 'tools-e2e-stream';
    await execTool('exec_cmd', { command: 'node -e "console.log(\'stream-one\'); console.error(\'stream-two\')"' }, { callID });
    await waitUntil(() => {
      const joined = toolEvents.streams.filter(s => s.call_id === callID).map(s => s.text).join('\n');
      return joined.includes('stream-one') && joined.includes('stream-two') ? joined : null;
    }, 'tool_stream events were not observed for foreground exec_cmd');
  });

  const finalTasks = await execTool('task_list', {});
  console.log(JSON.stringify({
    ok: true,
    port,
    workspace: rootDir,
    taskID,
    wsEvents: {
      streamEvents: toolEvents.streams.length,
      taskDoneEvents: toolEvents.taskDone.length,
      injectEvents: toolEvents.injects.length,
      questionEvents: toolEvents.questions.length,
    },
    finalTasks: finalTasks.output,
  }, null, 2));
} finally {
  ws?.close();
  await closeServer(localFetchServer);
  await terminateProcess(piercode);
  rmSync(serverExe, { force: true });
}

function apiURL() {
  return `http://127.0.0.1:${port}`;
}

function authHeaders(extra = {}) {
  const { headers = {}, ...rest } = extra;
  return {
    ...rest,
    headers: {
      authorization: `Bearer ${token}`,
      ...headers,
    },
  };
}

async function getJSON(path) {
  const res = await fetch(`${apiURL()}${path}`, authHeaders());
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getText(path) {
  const res = await fetch(`${apiURL()}${path}`, authHeaders());
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}

async function postJSON(path, payload) {
  const res = await fetch(`${apiURL()}${path}`, authHeaders({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function execSuccess(name, args, predicate = () => true) {
  const body = await execTool(name, args);
  assert(predicate(String(body.output || '')), `${name} output failed predicate: ${JSON.stringify(body)}`);
  return body;
}

async function execTool(name, args, options = {}) {
  const callID = options.callID || `tools-e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const allowed = new Set(options.allowedStatuses || ['success']);
  const res = await fetch(`${apiURL()}/exec`, authHeaders({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, call_id: callID, args }),
  }));
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!allowed.has(body.status)) {
    throw new Error(`${name} failed: ${body.error || body.output || JSON.stringify(body)}`);
  }
  return body;
}

async function openEventSocket() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}&id=tools-e2e-client&client=tools-e2e&provider=ToolsE2E`);
  socket.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'tool_stream') toolEvents.streams.push(msg);
    if (msg.type === 'tool_done') toolEvents.taskDone.push(msg);
    if (msg.type === 'inject') toolEvents.injects.push(msg);
    if (msg.type === 'question_ask') toolEvents.questions.push(msg);
  });
  return waitForOpen(socket);
}

function parseTaskID(output) {
  const match = String(output || '').match(/\b(bg-[A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

async function step(label, fn) {
  process.stdout.write(`tools-e2e: ${label}... `);
  try {
    const result = await fn();
    process.stdout.write('ok\n');
    return result;
  } catch (error) {
    process.stdout.write('failed\n');
    throw error;
  }
}

async function waitForHTTP(url, options, predicate) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        last = await response.json();
        if (predicate(last)) return last;
      } else {
        last = await response.text();
      }
    } catch (error) {
      last = error.message;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}; last=${JSON.stringify(last)}`);
}

async function waitUntil(fn, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(message);
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
      const { port: selectedPort } = server.address();
      server.close(() => resolve(selectedPort));
    });
  });
}

function listen(server, listenPort) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
