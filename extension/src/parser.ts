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

// matchObjectEnd returns the index of the `}` closing the object that starts at
// `start` (which must be a `{`), or -1 when the object never closes (incomplete
// stream). String-aware: braces and backticks inside JSON string values are
// consumed as string content, never as structure.
function matchObjectEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// FENCE_OPEN_RE matches only the fence OPENER. The body is then consumed by
// brace matching instead of a non-greedy regex.
const FENCE_OPEN_RE = /```(?:piercode-tool|tool)\b[ \t]*\r?\n?/gi;

// extractFenceToolCalls scans full text for ```piercode-tool / ```tool fences
// and returns every complete tool call inside them.
//
// Why not FENCE_RE over the whole fence? Its non-greedy body stops at the FIRST
// ``` — a tool whose args contain a markdown code fence (write_file of a .md or
// code file) gets its JSON truncated mid-string, and the leftover tail can then
// re-match as a phantom "fence" that parses into a DIFFERENT tool. Here each
// `{` starts a string-aware brace match, so ``` inside JSON strings is plain
// content; multiple concatenated objects in one fence all parse. A fence whose
// object never closes or that has no closing ``` yet is still streaming —
// nothing is emitted for it (the next scan retries).
export function extractFenceToolCalls(text: string): Array<{ name: string; callId: string | null; args: Record<string, unknown> }> {
  const out: Array<{ name: string; callId: string | null; args: Record<string, unknown> }> = [];
  FENCE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_OPEN_RE.exec(text)) !== null) {
    let i = m.index + m[0].length;
    let closed = false;
    const segs: string[] = [];
    while (i < text.length) {
      if (text.startsWith('```', i)) { closed = true; break; }
      if (text[i] === '{') {
        const end = matchObjectEnd(text, i);
        if (end === -1) break; // incomplete object — still streaming
        segs.push(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      i++;
    }
    if (!closed) continue; // no closing fence yet — still streaming
    for (const seg of segs) {
      const cleaned = seg.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
      const tc = parseJsonFenceToolCall(cleaned);
      if (tc) out.push(tc);
    }
    // Skip past the closing ``` so text inside this fence (which may itself
    // contain a literal "```piercode-tool" within a string arg) is never
    // re-scanned as a new opener.
    FENCE_OPEN_RE.lastIndex = i + 3;
  }
  return out;
}

// hasIncompleteToolFence reports whether ANY tool fence in the text is still
// streaming: its closing ``` is missing, or an object inside it never closes.
// Content scans use this to schedule a settle-retry instead of dropping the
// fence forever when it happens to be the response's final segment.
export function hasIncompleteToolFence(text: string): boolean {
  FENCE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_OPEN_RE.exec(text)) !== null) {
    let i = m.index + m[0].length;
    let closed = false;
    while (i < text.length) {
      if (text.startsWith('```', i)) { closed = true; break; }
      if (text[i] === '{') {
        const end = matchObjectEnd(text, i);
        if (end === -1) return true; // object never closes
        i = end + 1;
        continue;
      }
      i++;
    }
    if (!closed) return true; // opener with no closing fence
    FENCE_OPEN_RE.lastIndex = i + 3;
  }
  return false;
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
  // #16: carry an OPTIONAL purpose (intent line shown on the approval card) only
  // when the model actually provided a non-empty string. Backward-compatible: a
  // fence without purpose yields the exact same {name, callId, args} shape as
  // before, so dedup hashing and toEqual consumers are unaffected.
  const purpose = typeof obj.purpose === 'string' && obj.purpose.trim() ? obj.purpose.trim() : undefined;
  return {
    name: obj.name,
    callId: obj.call_id || obj.callId || null,
    args: obj.args || {},
    ...(purpose !== undefined ? { purpose } : {}),
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

// REPAIR_CHAIN is the ordered list of progressive JSON repairs tried after a
// strict parse fails. Each step is string-aware (never mutates inside a string
// literal) and composes the cheaper structural fixes (smart→ASCII quotes,
// single→double quotes, trailing-comma strip, missing-brace completion) so a
// payload needing several slips fixed at once still parses. Shared by
// tryParseToolJSON (gated on looksLikeToolCall) and tryParseLenientJSON (no gate).
const REPAIR_CHAIN: ((s: string) => string)[] = [
  stripTrailingCommas,
  repairUnescapedQuotes,
  (s) => repairUnescapedQuotes(stripTrailingCommas(s)),
  // #13 additions — quote-shape normalizers run first so the later repairs see
  // ASCII-quoted JSON, then brace completion patches a truncated final object.
  normalizeSmartQuotes,
  (s) => stripTrailingCommas(normalizeSmartQuotes(s)),
  singleToDoubleQuotes,
  (s) => stripTrailingCommas(singleToDoubleQuotes(s)),
  (s) => singleToDoubleQuotes(normalizeSmartQuotes(s)),
  completeMissingBraces,
  (s) => completeMissingBraces(stripTrailingCommas(normalizeSmartQuotes(s))),
  (s) => completeMissingBraces(stripTrailingCommas(singleToDoubleQuotes(normalizeSmartQuotes(s)))),
];

export function tryParseToolJSON(raw: string): any | null {
  // 将非断空格替换为普通空格（Monaco Editor 的 &nbsp; 会被 textContent 转为  ）
  const normalized = raw.replace(/ /g, ' ');
  try { return JSON.parse(normalized); } catch {}

  // 渐进式修复：每一步在前一步基础上叠加，命中即返回。所有修复都是字符串感知的
  // （不动字符串字面量内部），且只在结果"看起来像工具调用"时才采纳，避免静默错位。
  for (const repair of REPAIR_CHAIN) {
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
  for (const repair of REPAIR_CHAIN) {
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

// normalizeSmartQuotes converts curly/smart quotes that the model used as JSON
// delimiters into their ASCII forms (U+201C/U+201D → ", U+2018/U+2019 → '). It
// is string-aware: once an ASCII double-quoted string has opened, smart quotes
// inside it are legitimate content (e.g. `"echo “hi”"`) and are left verbatim;
// only smart quotes sitting in STRUCTURAL position become ASCII delimiters. The
// straight-quote escape state tracks `\` so an escaped `\"` doesn't toggle.
function normalizeSmartQuotes(input: string): string {
  let result = '';
  let inString = false; // inside an ASCII (") string literal
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      result += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; result += ch; continue; }
    // Structural position: fold smart quotes to ASCII.
    if (ch === '“' || ch === '”') { result += '"'; continue; }
    if (ch === '‘' || ch === '’') { result += "'"; continue; }
    result += ch;
  }
  return result;
}

// singleToDoubleQuotes rewrites single-quoted JSON (a frequent model slip:
// `{'name':'x'}`) into valid double-quoted JSON. String-aware: a `'` that
// appears INSIDE an already-open ASCII double-quoted string is a literal
// apostrophe and is preserved; only a `'` in structural position opens a
// single-quoted string whose delimiters become `"` and whose inner `"`
// characters are escaped to `\"`. Backslash escapes inside either string flavor
// are passed through so `\'` / `\"` don't mis-toggle the state.
function singleToDoubleQuotes(input: string): string {
  let result = '';
  let inDouble = false; // inside a "…" string
  let inSingle = false; // inside a '…' string being converted
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inDouble) {
      result += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (escaped) {
        // Preserve the escape, but `\'` becomes a plain ' inside the new "…".
        if (ch === "'") result += "'"; else result += '\\' + ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === "'") { result += '"'; inSingle = false; continue; }
      if (ch === '"') { result += '\\"'; continue; } // escape inner double quote
      result += ch;
      continue;
    }
    if (ch === '"') { inDouble = true; result += ch; continue; }
    if (ch === "'") { inSingle = true; result += '"'; continue; }
    result += ch;
  }
  // A `\` that opened just before EOF inside a single-quoted string: drop the
  // dangling escape rather than emit an invalid trailing backslash.
  if (inSingle && escaped) result += '\\';
  return result;
}

// completeMissingBraces patches a truncated FINAL object: when generation cut off
// mid-stream the closing `}`/`]` (and possibly a dangling open string) never
// arrived. String-aware scan tracks the bracket stack and whether a string is
// still open; it then appends a closing `"` if needed followed by the unwound
// `}`/`]` in reverse order. Braces/brackets inside string values are content and
// never counted. A balanced input is returned unchanged.
//
// Conservatism contract: PierCode's content scan already drops genuinely
// incomplete fences via extractFenceToolCalls (brace-match) + hasIncompleteToolFence
// + settle-retry, so this repair is a last-resort backstop, NOT the streaming
// gate. To avoid resurrecting a call that is still mid-stream, it REFUSES to
// complete when the truncation point is still "expecting a value": the last
// significant (non-string, non-whitespace) char is an opener `{`/`[`, a `,`, or a
// `:` — e.g. `{"name":"x","args":{` (empty args incoming). Completion only fires
// when the tail is a finished value/string/`}`/`]`, where only closers are missing
// (e.g. `{"name":"read_file","args":{"path":"README.md"`).
function completeMissingBraces(input: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSignificant = ''; // last structural char seen outside a string
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; lastSignificant = '"'; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (/\s/.test(ch)) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
    lastSignificant = ch;
  }
  if (!inString && stack.length === 0) return input; // already balanced
  // Mid-value truncation → still streaming; refuse (leave it to settle-retry).
  if (!inString && (lastSignificant === '{' || lastSignificant === '[' || lastSignificant === ',' || lastSignificant === ':')) {
    return input;
  }
  let suffix = '';
  // A string left open at EOF (e.g. truncated mid-value) — close it first. A
  // trailing lone backslash would escape our closing quote, so neutralize it.
  if (inString) suffix += (escaped ? '\\' : '') + '"';
  for (let i = stack.length - 1; i >= 0; i--) suffix += stack[i];
  return input + suffix;
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
