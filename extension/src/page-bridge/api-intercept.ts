// API Intercept: monkey-patch window.fetch to detect code_interpreter calls
// in SSE streams from AI platform APIs. Runs in page context (MAIN world).
//
// The interceptor is ALWAYS active (fetch is patched unconditionally) because
// chrome.storage is not accessible from MAIN world. The enabled/disabled gate
// lives in the content script's event listener — it checks
// apiInterceptEnabled from chrome.storage before processing events.
//
// This means the SSE analysis runs even when the feature is off, but the
// CustomEvent is lightweight and the content script silently ignores it.

// Chat API endpoint patterns to intercept (Qwen only for now).
const CHAT_API_PATTERNS: RegExp[] = [
  /\/api\/v2\/chat\/completions/, // Qwen
];

// Translate a shell command to a PierCode tool call.
type ToolTranslator = (code: string) => { name: string; args: Record<string, unknown> } | null;

function matchLs(code: string): ReturnType<ToolTranslator> {
  // ls, dir, tree with optional flags and path
  const m = code.match(/(?:ls|dir)\s+(?:-[a-zA-Z]+\s+)?['"]?([^'"\n]+)['"]?/);
  if (m) return { name: 'list_dir', args: { path: m[1].trim() } };
  const t = code.match(/tree\s+(?:-[a-zA-Z]+\s+)?['"]?([^'"\n]+)['"]?/);
  if (t) return { name: 'list_dir', args: { path: t[1].trim() } };
  return null;
}

function matchCat(code: string): ReturnType<ToolTranslator> {
  const m = code.match(/cat\s+['"]?([^'"\n]+)['"]?/);
  if (m) return { name: 'read_file', args: { path: m[1].trim() } };
  const h = code.match(/head\s+(?:-(\d+)\s+)?['"]?([^'"\n]+)['"]?/);
  if (h) return { name: 'read_file', args: { path: h[2].trim(), limit: h[1] ? parseInt(h[1], 10) : 10 } };
  const t = code.match(/tail\s+(?:-(\d+)\s+)?['"]?([^'"\n]+)['"]?/);
  if (t) return { name: 'read_file', args: { path: t[2].trim(), limit: t[1] ? parseInt(t[1], 10) : 10 } };
  return null;
}

function matchGrep(code: string): ReturnType<ToolTranslator> {
  const m = code.match(/grep\s+(?:-[a-zA-Z]+\s+)?['"](.+?)['"]\s+['"]?([^'"\n]+)['"]?/);
  if (m) return { name: 'grep', args: { pattern: m[1], path: m[2].trim() || '.' } };
  return null;
}

function matchFind(code: string): ReturnType<ToolTranslator> {
  const m = code.match(/find\s+\S+\s+-name\s+['"](.+?)['"]/);
  if (m) return { name: 'glob', args: { pattern: `**/${m[1]}` } };
  return null;
}

const TRANSLATORS: ToolTranslator[] = [matchLs, matchCat, matchGrep, matchFind];

function translateCodeToTool(code: string): { name: string; args: Record<string, unknown> } | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  for (const t of TRANSLATORS) {
    const r = t(trimmed);
    if (r) return r;
  }
  // Fallback: short commands → exec_cmd
  if (trimmed.length > 0 && trimmed.length < 500) {
    return { name: 'exec_cmd', args: { command: trimmed } };
  }
  return null;
}

// Parse code from code_interpreter function_call.arguments (JSON string).
function extractCodeFromInterpreter(args: string): string | null {
  try {
    const parsed = JSON.parse(args);
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

// Check if a URL matches any chat API pattern.
function isChatAPI(url: string): boolean {
  return CHAT_API_PATTERNS.some(p => p.test(url));
}

// Accumulate incremental code_interpreter arguments across SSE deltas.
// Qwen streams function_call.arguments as incremental JSON chunks:
//   delta 1: {"name": "list
//   delta 2: _dir", "args
//   ...
// We accumulate the raw string and parse when the phase changes away.
interface PendingInterpreter {
  code: string;       // accumulated code from function_call.arguments
  functionId: string;  // function_call.function_id for dedup
}

// Accumulate answer-phase text to detect piercode-tool blocks.
interface PendingAnswer {
  content: string;  // accumulated answer text
}

const pendingByConversation = new Map<string, PendingInterpreter>();
const answerByConversation = new Map<string, PendingAnswer>();

function getConversationKey(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.searchParams.get('chat_id') || 'default';
  } catch {
    return 'default';
  }
}

// Regex to detect piercode-tool fenced blocks in accumulated text.
const TOOL_FENCE_RE = /```piercode-tool\s*\n([\s\S]*?)\n```/gi;

function extractToolCallsFromText(text: string): Array<{ name: string; args: Record<string, unknown>; call_id: string }> {
  const calls: Array<{ name: string; args: Record<string, unknown>; call_id: string }> = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_FENCE_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.name === 'string') {
        calls.push({
          name: parsed.name,
          args: parsed.args || {},
          call_id: parsed.call_id || `intercept-${match.index}`,
        });
      }
    } catch {}
  }
  return calls;
}

// Process one SSE data event. Returns true if a tool call was detected.
function processSSEEvent(json: Record<string, unknown>, conversationKey: string): boolean {
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices)) return false;

  let detected = false;

  for (const choice of choices) {
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    const phase = delta.phase as string | undefined;
    const fc = delta.function_call as Record<string, unknown> | undefined;

    // Accumulate code_interpreter arguments.
    if (phase === 'code_interpreter' && fc) {
      const fId = (delta.function_id as string) || (fc.function_id as string) || '';
      const rawArgs = (fc.arguments as string) || '';

      const existing = pendingByConversation.get(conversationKey);
      // A function_id that differs from the accumulating call starts a NEW call:
      // reset the buffer instead of prepending the previous call's leftover code
      // (which would corrupt the JSON and drop both calls).
      const isNewCall = !!(existing && fId && existing.functionId && existing.functionId !== fId);
      if (existing && fId && existing.functionId === fId) {
        existing.code += rawArgs;
      } else if (isNewCall) {
        pendingByConversation.set(conversationKey, { code: rawArgs, functionId: fId });
      } else if (rawArgs || fId) {
        pendingByConversation.set(conversationKey, {
          code: (existing?.code || '') + rawArgs,
          functionId: fId || existing?.functionId || '',
        });
      }
      continue;
    }

    // Accumulate answer-phase content for piercode-tool detection.
    if (phase === 'answer' && typeof delta.content === 'string') {
      const existing = answerByConversation.get(conversationKey);
      if (existing) {
        existing.content += delta.content;
      } else {
        answerByConversation.set(conversationKey, { content: delta.content });
      }
    }

    // Phase changed away from code_interpreter — flush accumulated code.
    const pending = pendingByConversation.get(conversationKey);
    if (pending && pending.code) {
      pendingByConversation.delete(conversationKey);
      const code = extractCodeFromInterpreter(pending.code);
      if (code) {
        const toolCall = translateCodeToTool(code);
        if (toolCall) {
          console.log(`[PierCode API] 检测到 code_interpreter → ${toolCall.name}`, toolCall.args);
          try {
            window.dispatchEvent(new CustomEvent('piercode-api-tool-call', {
              detail: { ...toolCall, source: 'api-intercept', originalCode: code }
            }));
          } catch {}
          detected = true;
        }
      }
    } else if (pending) {
      pendingByConversation.delete(conversationKey);
    }
  }
  return detected;
}

// Flush accumulated answer text and detect piercode-tool blocks.
// Called when the SSE stream ends ([DONE] or stream close).
function flushAnswerToolCalls(conversationKey: string): boolean {
  const answer = answerByConversation.get(conversationKey);
  if (!answer || !answer.content) return false;
  answerByConversation.delete(conversationKey);

  const toolCalls = extractToolCallsFromText(answer.content);
  for (const tc of toolCalls) {
    console.log(`[PierCode API] 检测到 piercode-tool → ${tc.name}`, tc.args);
    try {
      window.dispatchEvent(new CustomEvent('piercode-api-tool-call', {
        detail: { ...tc, source: 'piercode-tool' }
      }));
    } catch {}
  }
  return toolCalls.length > 0;
}

// Tee the response body and parse the analysis stream for code_interpreter calls.
function interceptSSEStream(response: Response, url: string): Response {
  const body = response.body;
  if (!body) return response;

  const [pageStream, analysisStream] = body.tee();
  const conversationKey = getConversationKey(url);

  // Background analysis — does not block the page's stream consumption.
  const reader = analysisStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();

          if (data === '[DONE]') {
            // Stream ended — flush accumulated answer for piercode-tool detection.
            flushAnswerToolCalls(conversationKey);
            continue;
          }

          try {
            const json = JSON.parse(data) as Record<string, unknown>;
            processSSEEvent(json, conversationKey);
          } catch {}
        }
      }
    } catch (e) {
      // Stream errors are non-fatal — the page stream continues normally.
      console.warn('[PierCode API] 分析流错误:', e);
    } finally {
      // Flush any remaining answer content for tool detection.
      flushAnswerToolCalls(conversationKey);
      // Drop any half-accumulated code_interpreter buffer for this stream so a
      // truncated call (stream errored before a phase-change flush) can't leak
      // into the next conversation that reuses the same conversation key.
      pendingByConversation.delete(conversationKey);
      reader.releaseLock();
    }
  })();

  return new Response(pageStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Install the fetch interceptor. Idempotent (guarded by a global flag).
// Always patches fetch — the enabled gate is in the content script's event listener.
export function installApiIntercept(): void {
  if ((window as any).__PIERCODE_API_INTERCEPT__) return;
  (window as any).__PIERCODE_API_INTERCEPT__ = true;

  const originalFetch = window.fetch;

  window.fetch = async function (this: typeof globalThis, ...args: Parameters<typeof fetch>): Promise<Response> {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : (input as Request)?.url || '';
    const method = ((init as RequestInit)?.method || 'GET').toUpperCase();

    // Only intercept POST requests to chat API endpoints.
    if (method !== 'POST' || !isChatAPI(url)) {
      return originalFetch.apply(this, args);
    }

    const response = await originalFetch.apply(this, args);
    const contentType = response.headers.get('content-type') || '';

    // Only intercept SSE responses.
    if (!contentType.includes('event-stream') && !contentType.includes('text/event-stream')) {
      return response;
    }

    return interceptSSEStream(response, url);
  };

  console.log('[PierCode API] fetch 拦截器已安装（开关在 popup 控制，content script 侧判断）');
}
