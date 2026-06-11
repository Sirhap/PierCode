// The newline after the tag and before the closing ``` are OPTIONAL — models
// often emit ```piercode-tool{...}``` on one line. Body is captured up to ```.
export const FENCE_RE = /```(?:piercode-tool|tool)\b[ \t]*\r?\n?([\s\S]*?)```/gi;

// splitFenceObjects pulls every top-level {...} JSON object out of a fence body.
// Models frequently pack several tool calls into ONE fence as concatenated
// objects ({...}{...}), which a single parse rejects. Brace-match each object
// (string-aware, so braces inside string values don't split). Returns the body
// as a single segment when no top-level object is found, so callers can still
// try their normal parse path.
export function splitFenceObjects(body: string): string[] {
  const objs: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { objs.push(body.slice(start, i + 1)); start = -1; } }
  }
  return objs.length > 0 ? objs : [body];
}

// parseFenceToolCalls parses a fence body that may contain one OR several tool
// objects, returning every valid tool call (via the shared repair chain).
export function parseFenceToolCalls(body: string): Array<{ name: string; callId: string | null; args: Record<string, unknown> }> {
  const out: Array<{ name: string; callId: string | null; args: Record<string, unknown> }> = [];
  for (const seg of splitFenceObjects(body.trim())) {
    const tc = parseJsonFenceToolCall(seg);
    if (tc) out.push(tc);
  }
  return out;
}

export const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/(?:tool|function)(?:_call)?>/gi;

// stableStringify serializes a value with object keys sorted recursively, so two
// structurally-equal payloads always produce the identical string regardless of
// key insertion order. Used to key exec-dedup on the tool's *semantics*.
export function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function djb31Hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

// toolDedupHash hashes the *parsed* tool semantics ({name, args}) rather than the
// raw rendered fence text. Qwen renders finished tool blocks through Monaco,
// which virtualizes view-lines: after a refresh the same block extracts to a
// DIFFERENT string (only visible lines, varying whitespace) than at generation
// time, so a codeText hash drifted and `isExecuted` missed → every history tool
// re-ran on refresh. The parsed semantics are render-independent, so the dedup
// key is stable across the refresh.
export function toolDedupHash(data: any): number {
  return djb31Hash(stableStringify({ name: data?.name, args: data?.args ?? data?.arguments ?? {} }));
}

export function parseJsonFenceToolCall(jsonStr: string): any | null {
  // Share tryParseToolJSON's repair chain (unescaped quotes, trailing commas)
  // so a fenced block with a common LLM JSON slip still parses instead of being
  // silently dropped.
  const obj = tryParseToolJSON(jsonStr);
  if (!obj || !obj.name || typeof obj.name !== 'string') return null;
  return {
    name: obj.name,
    callId: obj.call_id || obj.callId || null,
    args: obj.args || {}
  };
}

export interface AgentResultPacket {
  agentId: string;
  status: string;
  summary: string;
  result: string;
}

// parseAgentResultPacket parses a worker's `piercode-agent-result` JSON body.
// Returns null when the JSON is incomplete (still streaming, or truncated by a
// Qwen Monaco `.mtkoverflow` placeholder), so callers can retry on a later scan
// instead of forwarding a half packet. Mirrors tryParseToolJSON's normalization
// (U+00A0 from Monaco &nbsp;, zero-width chars) before JSON.parse.
export function parseAgentResultPacket(jsonStr: string): AgentResultPacket | null {
  const normalized = jsonStr.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ").trim();
  // Cheap streaming/truncation guard: a complete object body ends with `}`.
  if (!normalized.endsWith('}')) return null;
  // Use the SAME repair primitives as tool calls (trailing commas, unescaped
  // quotes) so a worker's common JSON slip still parses \u2014 a raw JSON.parse would
  // drop it and the coordinator would never get the callback ("\u5B50agent \u4E0D\u6309\u683C\u5F0F\u54CD\u5E94"
  // \u2014 it DID respond, parse failed). NOTE: cannot reuse tryParseToolJSON here, it
  // gates on a tool-call `name` field which a result packet does not have.
  const obj = tryParseLenientJSON(normalized);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const status = typeof obj.status === 'string' && obj.status.trim() ? obj.status.trim() : 'completed';
  return {
    agentId: typeof obj.agent_id === 'string' ? obj.agent_id.trim() : '',
    status,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    result: typeof obj.result === 'string' ? obj.result : '',
  };
}

export function parseXmlToolCall(raw: string, decodeHTMLEntities: (s: string) => string = s => s): any | null {
  const nameMatch = raw.match(/^<tool\s+name=(["'])([^"']+)\1(?:\s+call_id=(["'])([^"']+)\3)?/i);
  if (!nameMatch) return null;
  const name = nameMatch[2];
  const callId = nameMatch[4] || null;
  const args: Record<string, string> = {};
  const paramRe = /<parameter\s+name=(["'])([^"']+)\1>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = paramRe.exec(raw)) !== null) args[m[2]] = decodeHTMLEntities(m[3]).trim();
  return { name, args, callId };
}

export function tryParseToolJSON(raw: string): any | null {
  // 将非断空格替换为普通空格（Monaco Editor 的 &nbsp; 会被 textContent 转为  ）
  const normalized = raw.replace(/ /g, ' ');
  try { return JSON.parse(normalized); } catch {}

  // 渐进式修复：每一步在前一步基础上叠加，命中即返回。所有修复都是字符串感知的
  // （不动字符串字面量内部），且只在结果"看起来像工具调用"时才采纳，避免静默错位。
  const repairs: ((s: string) => string)[] = [
    stripTrailingCommas,
    repairUnescapedQuotes,
    (s) => repairUnescapedQuotes(stripTrailingCommas(s)),
  ];
  for (const repair of repairs) {
    try {
      const parsed = JSON.parse(repair(normalized));
      if (looksLikeToolCall(parsed)) return parsed;
    } catch {}
  }
  return null;
}

// tryParseLenientJSON parses an arbitrary JSON object with the same progressive
// repair chain as tryParseToolJSON, but WITHOUT the tool-call `name` gate — for
// payloads that are valid JSON but not tool calls (e.g. piercode-agent-result).
export function tryParseLenientJSON(raw: string): any | null {
  const normalized = raw.replace(/ /g, ' ');
  try { return JSON.parse(normalized); } catch {}
  const repairs: ((s: string) => string)[] = [
    stripTrailingCommas,
    repairUnescapedQuotes,
    (s) => repairUnescapedQuotes(stripTrailingCommas(s)),
  ];
  for (const repair of repairs) {
    try { return JSON.parse(repair(normalized)); } catch {}
  }
  return null;
}

// stripTrailingCommas removes commas that sit immediately before a closing } or
// ] (a common LLM slip). String-aware: a comma inside a JSON string value is
// left untouched.
function stripTrailingCommas(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (ch === ',' && !inString) {
      // Look ahead past whitespace; drop the comma if the next non-space is } or ].
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === '}' || input[j] === ']') continue;
    }
    result += ch;
  }
  return result;
}

function repairUnescapedQuotes(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) { inString = true; result += ch; continue; }
      // 已在字符串内：判断当前 " 是闭合还是出现在值里。前看跳过空白后
      // 是 :  ,  }  ] 视为闭合；否则视为字符串内的 " 并补成 \"。
      let j = i + 1;
      while (j < input.length && input[j] === ' ') j++;
      const next = input[j];
      if (next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false; result += ch;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += ch;
  }
  return result;
}

function looksLikeToolCall(v: any): boolean {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && v.name.length > 0;
}

// formatToolResults renders tool execution results as the continuation message
// fed back to the model: one `### name #call_id` block per result, blank-line
// joined. Shared by the API channel (chat-api.ts) and the content channel.
export function formatToolResults(
  results: Array<{ name: string; call_id?: string | null; output: string }>
): string {
  return results
    .map(r => `### ${r.name} #${r.call_id ?? ''}\n\n${r.output}`)
    .join('\n\n')
}
