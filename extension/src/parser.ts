export const FENCE_RE = /```(?:openlink-tool|tool)\s*\n([\s\S]*?)\n```/gi;

export const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/(?:tool|function)(?:_call)?>/gi;

export function parseJsonFenceToolCall(jsonStr: string): any | null {
  try {
    const obj = JSON.parse(jsonStr.replace(/\u00A0/g, ' '));
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
  // 将非断空格替换为普通空格（Monaco Editor 的 &nbsp; 会被 textContent 转为 \u00A0）
  const normalized = raw.replace(/\u00A0/g, ' ');
  try { return JSON.parse(normalized); } catch {}
  try {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (escaped) { result += ch; escaped = false; continue; }
      if (ch === '\\') { result += ch; escaped = true; continue; }
      if (ch === '"') {
        if (!inString) { inString = true; result += ch; continue; }
        let j = i + 1;
        while (j < normalized.length && normalized[j] === ' ') j++;
        const next = normalized[j];
        if (next === ':' || next === ',' || next === '}' || next === ']') {
          inString = false; result += ch;
        } else {
          result += '\\"';
        }
        continue;
      }
      result += ch;
    }
    return JSON.parse(result);
  } catch {}
  return null;
}
