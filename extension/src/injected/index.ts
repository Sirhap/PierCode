// Newline after the tag / before the closing ``` are OPTIONAL (models emit
// ```piercode-tool{...}``` on one line).
const INJECTED_FENCE_RE = /```(?:piercode-tool|tool)\b[ \t]*\r?\n?([\s\S]*?)```/gi;

// Pull every top-level {...} JSON object out of a fence body (string-aware brace
// match). Models often pack several tool calls into one fence as {...}{...};
// returns the body unchanged as a single segment when no object is found.
function splitInjectedObjects(body: string): string[] {
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

function parseInjectedJsonFenceToolCall(jsonStr: string): any | null {
  try {
    const obj = JSON.parse(jsonStr.replace(/\u00A0/g, ' '));
    if (!obj.name || typeof obj.name !== 'string') return null;
    return { name: obj.name, callId: obj.call_id || null, args: obj.args || {} };
  } catch { return null; }
}

function parseInjectedXmlToolCall(raw: string): any | null {
  const nameMatch = raw.match(/^<tool\s+name="([^"]+)"(?:\s+call_id="([^"]+)")?/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const callId = nameMatch[2] || null;
  const args: Record<string, string> = {};
  const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = paramRe.exec(raw)) !== null) args[m[1]] = m[2].trim();
  return { name, args, callId };
}

function tryParseInjectedToolJSON(raw: string): any | null {
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

(function() {
  console.log('[PierCode] 插件已加载');
  const originalFetch = window.fetch;
  let buffer = '';

  // Global dedup: keyed by conversation ID extracted from URL
  const MAX_CONV_DEDUP = 10;
  const processedByConv = new Map<string, Set<string>>();

  function getConvId(): string {
    // Claude: /chat/<id>, ChatGPT: /c/<id>, DeepSeek: ?id=<id> or path
    const m = location.pathname.match(/\/(?:chat|c)\/([^/?#]+)/) ||
              location.search.match(/[?&]id=([^&]+)/);
    return m ? m[1] : '__default__';
  }

  function getProcessed(): Set<string> {
    const id = getConvId();
    if (!processedByConv.has(id)) {
      // Evict oldest conversation if map exceeds limit.
      if (processedByConv.size >= MAX_CONV_DEDUP) {
        const oldest = processedByConv.keys().next().value;
        if (oldest !== undefined) processedByConv.delete(oldest);
      }
      processedByConv.set(id, new Set());
    }
    return processedByConv.get(id)!;
  }

  window.fetch = function(...args) {
    const decoder = new TextDecoder();
    return originalFetch.apply(this, args).then(async response => {
      if (!response.body) return response;
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            // ── Phase 1: JSON 围栏格式（优先） ──
            INJECTED_FENCE_RE.lastIndex = 0;
            let fenceMatch;
            const fenceMatches: { full: string; inner: string }[] = [];
            while ((fenceMatch = INJECTED_FENCE_RE.exec(buffer)) !== null) {
              fenceMatches.push({ full: fenceMatch[0], inner: fenceMatch[1] });
            }
            for (const { full, inner } of fenceMatches) {
              const processed = getProcessed();
              if (!processed.has(full)) {
                processed.add(full);
                const cleanedJson = inner.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
                // One fence may carry several concatenated tool objects ({...}{...});
                // emit a TOOL_CALL for each. Falls back to single-segment parse.
                const segments = splitInjectedObjects(cleanedJson);
                let anyOk = false;
                for (const seg of segments) {
                  const toolCall = parseInjectedJsonFenceToolCall(seg) || tryParseInjectedToolJSON(seg);
                  if (toolCall && toolCall.name) {
                    window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                    anyOk = true;
                  }
                }
                if (!anyOk) {
                  window.postMessage({type: 'TOOL_CALL_FORMAT_ERROR', raw: full}, '*');
                }
              }
              buffer = buffer.replace(full, '');
            }

            // ── Phase 2: XML 格式（兼容回退） ──
            let match;
            while ((match = buffer.match(/<tool(?:\s[^>]*)?>[\s\S]*?<\/(?:tool|function)(?:_call)?>/))) {
              const full = match[0];
              const processed = getProcessed();
              if (!processed.has(full)) {
                processed.add(full);
                const toolCall = parseInjectedXmlToolCall(full) || tryParseInjectedToolJSON(full.replace(/^<tool[^>]*>|<\/(?:tool|function)(?:_call)?>$/g, '').trim());
                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                } else {
                  window.postMessage({type: 'TOOL_CALL_FORMAT_ERROR', raw: full}, '*');
                }
              }
              buffer = buffer.replace(full, '');
            }
            controller.enqueue(value);
          }
          controller.close();
        }
      });

      return new Response(stream, {
        headers: response.headers,
        status: response.status
      });
    });
  };
})();
