const MONACO_REQUEST = 'PIERCODE_MONACO_TEXT_REQUEST';
const MONACO_RESPONSE = 'PIERCODE_MONACO_TEXT_RESPONSE';

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
