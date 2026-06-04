// Throwaway stub: registers a fake "ai-page" WebSocket client against a running
// PierCode server and answers ai_query messages, simulating a browser AI page.
//
//   node scripts/fake-ai-page.mjs <port> <token> [mode]
//
// mode (default "echo"):
//   echo  - reply with a fixed line.
//   tool  - drive a tiny agent loop: the FIRST query that mentions a file read
//           request returns a piercode-call tool block for Read; once the prompt
//           contains a "Tool Read result:" (the tool_result fed back), reply with
//           a final plain-text answer. Lets us exercise the full Claude Code
//           agent loop (tool_use -> execute -> tool_result -> final text).
//
import WebSocket from 'ws';

const port = process.argv[2] || '63643';
const token = process.argv[3] || '';
const mode = process.argv[4] || 'echo';

const id = 'fake-ai-' + Math.random().toString(36).slice(2, 10);
const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}` +
  `&id=${id}&client=content&role=ai-page&provider=Claude&host=claude.ai`;

const ws = new WebSocket(url);

ws.on('open', () => console.error(`[fake-ai-page] connected ${id} mode=${mode}`));

function decideReply(promptText) {
  if (mode === 'tool') {
    // Second turn: the tool result has been fed back → give the final answer.
    if (/Tool\s+Read\s+result:/i.test(promptText)) {
      const m = promptText.match(/module\s+([^\s]+)/i);
      const mod = m ? m[1] : '(unknown)';
      return `The module name is ${mod}. (answered by fake browser AI after reading the file)`;
    }
    // First turn: ask Claude Code to read go.mod via a tool call.
    return 'I need to read the file first.\n```piercode-call\n' +
      '{"tool":"Read","input":{"file_path":"go.mod"}}\n```';
  }
  return 'Hello from the fake browser AI page.';
}

ws.on('message', data => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type !== 'ai_query') return;
  const text = String(msg.text || '');
  console.error(`[fake-ai-page] ai_query ${msg.query_id} (${text.length} chars)`);
  const reply = decideReply(text);
  ws.send(JSON.stringify({
    type: 'ai_query_result',
    query_id: msg.query_id,
    call_id: msg.call_id,
    provider: 'Claude',
    url: 'https://claude.ai/chat/fake',
    text: reply,
  }));
  console.error(`[fake-ai-page] replied: ${reply.slice(0, 60).replace(/\n/g, ' ')}...`);
});

ws.on('close', () => { console.error('[fake-ai-page] closed'); process.exit(0); });
ws.on('error', err => { console.error('[fake-ai-page] error', err.message); process.exit(1); });
