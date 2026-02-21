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
      const reader = response.body!.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            let match;
            while ((match = buffer.match(/<tool>([\s\S]*?)<\/tool(?:_call)?>/))) {
              const raw = match[1].trim();
              const processed = getProcessed();
              if (!processed.has(raw)) {
                processed.add(raw);
                let toolCall = null;
                const tries = [
                  () => JSON.parse(raw),
                  () => JSON.parse(raw.replace(/\\n/g, '')),
                  () => JSON.parse(raw.replace(/\\"/g, '"')),
                  () => JSON.parse(JSON.parse('"' + raw + '"'))
                ];
                for (const fn of tries) {
                  try { toolCall = fn(); break; } catch {}
                }
                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                }
              }
              buffer = buffer.replace(match[0], '');
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
