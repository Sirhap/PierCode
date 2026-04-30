const INJECTED_FENCE_RE = /```(?:openlink-tool|tool)\s*\n([\s\S]*?)\n```/gi;

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
  console.log('[OpenLink] 插件已加载');
  const originalFetch = window.fetch;
  let buffer = '';

  // Global dedup: keyed by conversation ID extracted from URL
  const processedByConv = new Map<string, Set<string>>();

  function getConvId(): string {
    // Claude: /chat/<id>, ChatGPT: /c/<id>, DeepSeek: ?id=<id> or path
    const m = location.pathname.match(/\/(?:chat|c)\/([^/?#]+)/) ||
              location.search.match(/[?&]id=([^&]+)/);
    return m ? m[1] : '__default__';
  }

  function getProcessed(): Set<string> {
    const id = getConvId();
    if (!processedByConv.has(id)) processedByConv.set(id, new Set());
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
                const toolCall = parseInjectedJsonFenceToolCall(cleanedJson) || tryParseInjectedToolJSON(cleanedJson);
                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                } else {
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
