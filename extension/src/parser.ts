export const FENCE_RE = /```(?:piercode-tool|tool)\s*\n([\s\S]*?)\n```/gi;

export const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/(?:tool|function)(?:_call)?>/gi;

export function parseJsonFenceToolCall(jsonStr: string): any | null {
  try {
    const obj = JSON.parse(jsonStr.replace(/ /g, ' '));
    if (!obj.name || typeof obj.name !== 'string') return null;
    return {
      name: obj.name,
      callId: obj.call_id || null,
      args: obj.args || {}
    };
  } catch { return null; }
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
  // 将非断空格替换为普通空格（Monaco Editor 的 &nbsp; 会被 textContent 转为  ）
  const normalized = raw.replace(/ /g, ' ');
  try { return JSON.parse(normalized); } catch {}
  // 严格解析失败时尝试一次保守修复：把字符串值里出现的「未转义引号」补成
  // \" ——但只在修复后的结果能解析、且看起来像合法工具调用（含 string name）
  // 时才返回，否则宁可返回 null 让 AI 重发，避免静默给出错位转义后的参数
  // （比如把含 " 的 path 写到错误文件名）。
  try {
    const repaired = repairUnescapedQuotes(normalized);
    const parsed = JSON.parse(repaired);
    if (looksLikeToolCall(parsed)) return parsed;
  } catch {}
  return null;
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
