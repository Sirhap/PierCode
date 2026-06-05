export const FENCE_RE = /```(?:piercode-tool|tool)\s*\n([\s\S]*?)\n```/gi;

export const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/(?:tool|function)(?:_call)?>/gi;

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
