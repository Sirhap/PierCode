const MONACO_REQUEST = 'PIERCODE_MONACO_TEXT_REQUEST';
const MONACO_RESPONSE = 'PIERCODE_MONACO_TEXT_RESPONSE';

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
];

function installKeepAliveVisibilityShim(): void {
  const host = location.hostname.toLowerCase();
  if (!KEEP_ALIVE_HOSTS.some(h => host.includes(h))) return;
  if ((window as any).__PIERCODE_KEEP_ALIVE_SHIM__) return;
  (window as any).__PIERCODE_KEEP_ALIVE_SHIM__ = true;

  const defineGetter = (target: object, prop: string, value: unknown) => {
    try {
      Object.defineProperty(target, prop, { configurable: true, get: () => value });
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

  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if ((this === window || this === document) && blockedEvents.has(type)) {
      const wrapped = function(this: EventTarget, event: Event) {
        if (blockedEvents.has(event.type)) return;
        if (typeof listener === 'function') return listener.call(this, event);
        return listener?.handleEvent?.(event);
      };
      return originalAddEventListener.call(this, type, wrapped, options);
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
}

installKeepAliveVisibilityShim();

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
