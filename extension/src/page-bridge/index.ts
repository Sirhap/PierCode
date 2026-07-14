import { installApiListen } from './api-listen';

const MONACO_REQUEST = 'PIERCODE_MONACO_TEXT_REQUEST';
const MONACO_RESPONSE = 'PIERCODE_MONACO_TEXT_RESPONSE';

// Passive listen channel: page-context fetch interceptor (tees chat-API SSE
// responses back to the SW). The relay gate __PIERCODE_API_LISTEN_ON__ is
// flipped by content via the message below; installing it is always safe (no
// relay until the flag is on).
const API_LISTEN_SET = 'PIERCODE_API_LISTEN_SET';

// Qwen page-context fetch proxy. The service worker can't carry baxia's dynamic
// bx-ua/bx-umidtoken anti-bot headers (the SDK monkey-patches XHR/fetch only in
// the real qwen page). So the SW forwards qwen API requests here, where calling
// window.fetch runs through baxia's patch and gets signed automatically. We
// stream the response back chunk-by-chunk to content (→ port → SW).
const PAGE_FETCH_REQUEST = 'PIERCODE_PAGE_FETCH_EXEC';        // content → page-bridge
const PAGE_FETCH_HEAD = 'PIERCODE_PAGE_FETCH_EXEC_HEAD';      // page-bridge → content
const PAGE_FETCH_CHUNK = 'PIERCODE_PAGE_FETCH_EXEC_CHUNK';
const PAGE_FETCH_DONE = 'PIERCODE_PAGE_FETCH_EXEC_DONE';
const PAGE_FETCH_ERROR = 'PIERCODE_PAGE_FETCH_EXEC_ERROR';
const PAGE_FETCH_ABORT = 'PIERCODE_PAGE_FETCH_EXEC_ABORT';

// content → page-bridge: borrow a baxia bx-ua by sending a blink request.
const BXUA_BORROW = 'PIERCODE_BXUA_BORROW';
// page-bridge → content: result of the borrow.
const BXUA_RESULT = 'PIERCODE_BXUA_RESULT';

// Keep-alive visibility shim. Chrome heavily throttles background tabs and —
// worse — AI sites themselves listen for `visibilitychange` / `document.hidden`
// to pause their streaming (SSE) response rendering when the tab is not focused.
// That is why a worker tab (or any background AI tab) "stops returning streaming
// output" until brought to the front. We spoof the page into believing it is
// always visible/focused and swallow the hide signals, so generation keeps
// flowing in the background. (Electron multi-AI apps like ai-gate get this for
// free because hidden BrowserViews are not throttled; a Chrome extension must
// fake it at the page level.)
//
// Applied to every supported AI host, not just Qwen. The hosts list mirrors the
// manifest content_scripts matches.
const KEEP_ALIVE_HOSTS = [
  'qwen.ai', 'qwenlm.ai',
  'chatgpt.com', 'chat.openai.com',
  'claude.ai', 'free.easychat.top',
  'gemini.google.com', 'aistudio.google.com',
  'kimi.com', 'chat.z.ai',
  'aistudio.xiaomimimo.com',
  'ultraspeed.xiaomimimo.com',
];

function installKeepAliveVisibilityShim(): void {
  const host = location.hostname.toLowerCase();
  if (!KEEP_ALIVE_HOSTS.some(h => host.includes(h))) return;
  // Only spoof visibility for worker tabs (carries the ?piercode_agent marker) that
  // need to keep generating while running in the background. Normal foreground tabs
  // the user opened directly are left alone so the site keeps its own real
  // pause-when-hidden behavior.
  const isWorkerTab = /[?&]piercode_agent=/.test(location.search);
  if (!isWorkerTab) return;
  if ((window as any).__PIERCODE_KEEP_ALIVE_SHIM__) return;
  (window as any).__PIERCODE_KEEP_ALIVE_SHIM__ = true;

  const defineGetter = (target: object, prop: string, value: unknown) => {
    // configurable:false so a site can't redefine the property back to hidden:true
    // and defeat the shim. Re-defining the same prop then throws, but the shim is
    // installed once (guarded above) and defineGetter swallows the throw anyway.
    try {
      Object.defineProperty(target, prop, { configurable: false, get: () => value });
    } catch {}
  };

  defineGetter(Document.prototype, 'hidden', false);
  defineGetter(Document.prototype, 'visibilityState', 'visible');
  defineGetter(Document.prototype, 'webkitHidden', false);
  defineGetter(Document.prototype, 'webkitVisibilityState', 'visible');
  try {
    Document.prototype.hasFocus = () => true;
  } catch {}

  const blockedEvents = new Set([
    'visibilitychange',
    'webkitvisibilitychange',
    'blur',
    'pagehide',
    'freeze',
  ]);

  const blockHiddenSignal = (event: Event) => {
    event.stopImmediatePropagation();
  };

  for (const eventName of blockedEvents) {
    window.addEventListener(eventName, blockHiddenSignal, true);
    document.addEventListener(eventName, blockHiddenSignal, true);
  }

  // Map each original listener to the wrapper actually registered, so a later
  // removeEventListener(type, original) can find and detach the wrapper. Without
  // this, removal silently fails (Chrome looks up `original`, only `wrapped` is
  // registered) and dead no-op listeners accumulate for the page's lifetime.
  const wrapperFor = new WeakMap<object, EventListener>();
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if ((this === window || this === document) && blockedEvents.has(type) && listener) {
      const existing = wrapperFor.get(listener as object);
      const wrapped: EventListener = existing ?? function(this: EventTarget, event: Event) {
        if (blockedEvents.has(event.type)) return;
        if (typeof listener === 'function') return listener.call(this, event);
        return (listener as EventListenerObject)?.handleEvent?.(event);
      };
      if (!existing) wrapperFor.set(listener as object, wrapped);
      return originalAddEventListener.call(this, type, wrapped, options);
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if ((this === window || this === document) && blockedEvents.has(type) && listener) {
      const wrapped = wrapperFor.get(listener as object);
      if (wrapped) return originalRemoveEventListener.call(this, type, wrapped, options);
    }
    return originalRemoveEventListener.call(this, type, listener, options);
  };
}

installKeepAliveVisibilityShim();

// Install the passive fetch interceptor at document_start (must beat the site's
// own fetch calls). Relay stays off until content flips the flag.
try { installApiListen(); } catch {}

// content → page-bridge: toggle the listen relay flag.
window.addEventListener('message', event => {
  if (event.source !== window) return;
  const d = event.data;
  if (d && d.type === API_LISTEN_SET) {
    (window as any).__PIERCODE_API_LISTEN_ON__ = d.on === true;
  }
});

function normalize(text: string): string {
  return text.replace(/\u00A0/g, ' ').trim();
}

function getMonacoEditors(): any[] {
  const editors = (window as any).monaco?.editor?.getEditors?.();
  return Array.isArray(editors) ? editors : [];
}

function getMonacoModels(): any[] {
  const models = (window as any).monaco?.editor?.getModels?.();
  return Array.isArray(models) ? models : [];
}

function readEditorByDomId(domId: string): string | null {
  for (const editor of getMonacoEditors()) {
    const dom = editor.getDomNode?.();
    if (dom?.getAttribute?.('data-piercode-monaco-id') === domId) {
      const value = editor.getModel?.()?.getValue?.();
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

function readModelByVisibleText(visibleText: string): string | null {
  const normalizedVisible = normalize(visibleText);
  const prefix = normalizedVisible.slice(0, 160);
  if (!prefix) return null;

  const candidates = getMonacoModels()
    .map(model => model?.getValue?.())
    .filter((value): value is string => typeof value === 'string' && value.includes('"name"'))
    .filter(value => normalize(value).includes(prefix));

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

// ── Qwen page-context fetch proxy ───────────────────────────────────────────

// Active proxied fetches, keyed by requestId, so an ABORT can cancel the stream.
const pageFetchAborts = new Map<string, AbortController>();

/** Uint8Array → base64. The content↔SW port is JSON-only, so chunk bytes must be
 *  base64-encoded for transit. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  // Chunked to avoid String.fromCharCode arg-count limits on large frames.
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  }
  return btoa(bin);
}

function post(msg: Record<string, unknown>): void {
  window.postMessage(msg, '*');
}

async function execPageFetch(req: {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  stream: boolean;
}): Promise<void> {
  const { requestId } = req;
  const controller = new AbortController();
  pageFetchAborts.set(requestId, controller);
  try {
    // window.fetch here runs in page context → baxia's fetch/XHR patch injects
    // bx-ua/bx-umidtoken automatically. Same-origin to chat.qwen.ai → cookies sent.
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: 'include',
      signal: controller.signal,
    });
    post({ type: PAGE_FETCH_HEAD, requestId, ok: res.ok, status: res.status });

    if (!res.ok) {
      // Surface the error body so the SW can show the 风控/auth message.
      const text = await res.text().catch(() => '');
      post({ type: PAGE_FETCH_CHUNK, requestId, b64: btoa(unescape(encodeURIComponent(text))) });
      post({ type: PAGE_FETCH_DONE, requestId });
      return;
    }

    if (!res.body) {
      // No stream (shouldn't happen for these endpoints) — fall back to full text.
      const text = await res.text().catch(() => '');
      post({ type: PAGE_FETCH_CHUNK, requestId, b64: btoa(unescape(encodeURIComponent(text))) });
      post({ type: PAGE_FETCH_DONE, requestId });
      return;
    }

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) post({ type: PAGE_FETCH_CHUNK, requestId, b64: bytesToBase64(value) });
    }
    post({ type: PAGE_FETCH_DONE, requestId });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    if (!aborted) {
      post({ type: PAGE_FETCH_ERROR, requestId, error: err instanceof Error ? err.message : String(err) });
    } else {
      post({ type: PAGE_FETCH_DONE, requestId });
    }
  } finally {
    pageFetchAborts.delete(requestId);
  }
}

// Borrow a baxia bx-ua by calling the SDK's own getUA() synchronously. baxia
// exposes window.baxiaCommon.getUA() which computes a fresh, full-length bx-ua
// (~1560 chars on a healthy session) — the same signature it injects on real
// chat/completions requests. Empirically this bx-ua clears completions risk
// control when replayed on a clean SW fetch, so the SW caches it and replays.
//
// This needs NO blink request: no extra traffic, no garbage chat message, no
// side effects. (An earlier version fired a chats/new "blink" request and tried
// to capture the injected header — that failed because baxia only injects on
// completions, and wrapping window.fetch bypassed baxia's own patch entirely.)
//
// Caveat: getUA() on an account already in the punish/滑块 state returns a
// shorter (~1312 char) truncated value that is rejected. We can't detect that
// here; the SW's RGV587 retry handles it (invalidate → re-borrow once).
async function borrowBxUa(requestId: string): Promise<void> {
  try {
    const baxia = (window as unknown as { baxiaCommon?: { getUA?: () => string } }).baxiaCommon;
    const getUA = baxia?.getUA;
    if (typeof getUA !== 'function') {
      post({ type: BXUA_RESULT, requestId, error: 'baxiaCommon.getUA unavailable (SDK not loaded)' });
      return;
    }
    const bxUa = getUA.call(baxia);
    if (typeof bxUa === 'string' && bxUa.length > 0) {
      // umid is not produced by getUA and is not required (completions accepts
      // bx-ua alone), so it is intentionally left empty.
      post({ type: BXUA_RESULT, requestId, bxUa, umid: '' });
    } else {
      post({ type: BXUA_RESULT, requestId, error: 'getUA returned empty bx-ua' });
    }
  } catch (e) {
    post({ type: BXUA_RESULT, requestId, error: e instanceof Error ? e.message : String(e) });
  }
}

window.addEventListener('message', event => {
  if (event.source !== window) return;
  const d = event.data;
  if (d && typeof d.requestId === 'string') {
    if (d.type === PAGE_FETCH_REQUEST) {
      void execPageFetch({
        requestId: d.requestId,
        url: String(d.url),
        method: String(d.method || 'POST'),
        headers: (d.headers && typeof d.headers === 'object') ? d.headers : {},
        body: typeof d.body === 'string' ? d.body : '',
        stream: d.stream === true,
      });
      return;
    }
    if (d.type === PAGE_FETCH_ABORT) {
      pageFetchAborts.get(d.requestId)?.abort();
      return;
    }
    if (d.type === BXUA_BORROW) {
      void borrowBxUa(d.requestId);
      return;
    }
  }
});

window.addEventListener('message', event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== MONACO_REQUEST || typeof data.requestId !== 'string') return;

  let text: string | null = null;
  let error: string | null = null;
  try {
    if (typeof data.domId === 'string') {
      text = readEditorByDomId(data.domId);
    }
    if (!text && typeof data.visibleText === 'string') {
      text = readModelByVisibleText(data.visibleText);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  window.postMessage({
    type: MONACO_RESPONSE,
    requestId: data.requestId,
    text,
    error
  }, '*');
});
