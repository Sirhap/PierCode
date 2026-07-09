// 截图附件注入（extracted from content/index.ts）。
//
// 服务端 browser_screenshot 后通过 WS 请求把截图作为附件挂进当前聊天：
// 取 /attachments/screenshot → File → file input 赋值（按离编辑器距离排序）→
// paste → drop 三级回退。API 访问 / tab 聚焦 / 编辑器定位经 deps 注入。

import { onBrowserAttachmentUpload, sendBrowserAttachmentUploadResult } from './ws-linker';
import { showToast } from './toast';

export interface AttachmentUploadDeps {
  checkContext(showNotice?: boolean): boolean;
  bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }>;
  apiEndpoint(apiUrl: string, path: string): string;
  focusCurrentTabForSend(): Promise<void>;
  getEditorEl(): HTMLElement | null;
}

let deps!: AttachmentUploadDeps;
export function initAttachmentUploadDeps(d: AttachmentUploadDeps): void {
  deps = d;
}

interface AttachmentPayload {
  name: string;
  mimeType: string;
  dataBase64: string;
  bytes?: number;
}

// ── #8 init-context-too-long → attachment upload ────────────────────────────
// When the init/system prompt is longer than a platform's input-box wall, typing
// it gets truncated. Instead we drop it in as a .txt attachment (the editor reads
// uploaded files fully). These leaf helpers carry the threshold decision + file
// shaping; uploadInitPromptAsAttachment reuses the same file-input/paste/drop
// injection as the screenshot path.

/** Default character ceiling above which the init prompt is uploaded instead of
 *  typed. Conservative — most chat inputs accept far more, but a few platforms
 *  silently clip very long pastes. Callers may pass a per-platform override. */
export const INIT_ATTACHMENT_THRESHOLD = 16000;

/** Pure decision: should `text` be uploaded as an attachment rather than typed?
 *  A non-positive / missing `limit` means "no wall" → never upload (preserves
 *  the default type-it behaviour on platforms with no known limit). */
export function shouldUploadInitAsAttachment(text: string, limit: number | undefined): boolean {
  if (!limit || limit <= 0) return false;
  return text.length > limit;
}

/** Wrap text into a named text/plain File for attachment upload. */
export function buildTextAttachmentFile(text: string, name = 'piercode-init.txt'): File {
  return new File([text], name, { type: 'text/plain', lastModified: Date.now() });
}

/** Upload `text` as a .txt attachment into the current chat (init-prompt
 *  fallback). Throws if no upload entry point is found, OR if the attachment
 *  never visibly attaches (see waitForAttachmentChip) — either way the caller
 *  falls back to typing the full prompt instead of sending a pointer message
 *  for an attachment that isn't really there. */
export async function uploadInitPromptAsAttachment(text: string, name = 'piercode-init.txt'): Promise<void> {
  await attachFileToCurrentChat(buildTextAttachmentFile(text, name));
  // attachFileToCurrentChat only confirms the DOM dispatch didn't throw — it does
  // NOT confirm the platform actually attached the file. Some platforms (observed:
  // Gemini) run an async pipeline after the file input's `change` event (read file
  // → sometimes a one-time permission/consent dialog on first use → render a
  // preview chip → mark the message as having an attachment) that a startup-time
  // consent dialog can stall indefinitely. Without this check, sendInitPrompt sent
  // "已作为附件 piercode-init.txt 上传" immediately after — a message telling the
  // model to read a file that was never actually attached.
  if (!(await waitForAttachmentChip(name))) {
    throw new Error(`附件 ${name} 上传后未在页面上确认挂载（可能被平台自身的一次性弹窗/异步处理打断）`);
  }
}

/** Poll for `name` (or its extension-stripped stem) anywhere in the page's text —
 *  the attachment preview chip virtually every platform renders once an upload
 *  actually registers. textContent (not innerText) deliberately: we only care
 *  whether the DOM has the chip at all, not whether it's currently laid out /
 *  visible, and innerText's dependence on rendered layout made this diverge
 *  between real browsers and the jsdom-based unit tests. This is a DOM-structure-
 *  agnostic signal (works across platforms without a per-platform chip selector)
 *  at the cost of being a heuristic: a false positive would require unrelated
 *  text to contain the exact filename, which is not realistic for the
 *  `piercode-init` stem. Exported (with a timeoutMs override) so tests don't have
 *  to wait out the real 4s default to exercise the timeout branch. */
export async function waitForAttachmentChip(name: string, timeoutMs = 4000): Promise<boolean> {
  const stem = name.replace(/\.[^.]+$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = document.body.textContent || '';
    if (text.includes(name) || (stem && text.includes(stem))) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let attachmentUploadDispatcherRegistered = false;

export function ensureAttachmentUploadDispatcher() {
  if (attachmentUploadDispatcherRegistered) return;
  attachmentUploadDispatcherRegistered = true;
  onBrowserAttachmentUpload(async msg => {
    try {
      const payload = await fetchScreenshotAttachment(msg.path);
      const file = new File([base64ToArrayBuffer(payload.dataBase64)], payload.name || msg.name || 'screenshot.jpg', {
        type: payload.mimeType || msg.mimeType || 'image/jpeg',
        lastModified: Date.now(),
      });
      await attachFileToCurrentChat(file);
      sendBrowserAttachmentUploadResult(msg.call_id, true);
      showToast(`截图已作为附件添加：${file.name}`, 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendBrowserAttachmentUploadResult(msg.call_id, false, message);
      showToast(`截图附件上传失败：${message}`, 5000);
    }
  });
}

// SW-direct screenshot attachment: the service worker already holds the image bytes
// (from CDP Page.captureScreenshot), so it sends them straight here — no /attachments
// fetch. Reuses the same file-input/paste/drop injection as the WS path. Replies
// {ok} so the SW knows whether to fall back to returning the dataURL inline.
let runtimeAttachmentListenerInstalled = false;
export function installAttachmentRuntimeListener() {
  if (runtimeAttachmentListenerInstalled) return;
  runtimeAttachmentListenerInstalled = true;
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'BROWSER_ATTACHMENT_UPLOAD' || typeof msg.base64 !== 'string') return;
      (async () => {
        try {
          const file = new File([base64ToArrayBuffer(msg.base64)], msg.name || 'screenshot.png', {
            type: msg.mime || 'image/png', lastModified: Date.now(),
          });
          await attachFileToCurrentChat(file);
          showToast(`截图已作为附件添加：${file.name}`, 3000);
          sendResponse({ ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showToast(`截图附件上传失败：${message}`, 5000);
          sendResponse({ ok: false, error: message });
        }
      })();
      return true;   // async sendResponse
    });
  } catch { /* no runtime */ }
}

async function fetchScreenshotAttachment(path: string): Promise<AttachmentPayload> {
  if (!deps.checkContext(true)) throw new Error('扩展上下文已失效');
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) throw new Error('未配置 API 地址');
  const headers: any = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await deps.bgFetch(`${deps.apiEndpoint(apiUrl, '/attachments/screenshot')}?path=${encodeURIComponent(path)}`, { headers });
  if (response.status === 401) throw new Error('认证失败');
  if (!response.ok) throw new Error(response.body || `HTTP ${response.status}`);
  const payload = JSON.parse(response.body) as AttachmentPayload;
  if (!payload.dataBase64) throw new Error('截图数据为空');
  return payload;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function attachFileToCurrentChat(file: File): Promise<void> {
  await deps.focusCurrentTabForSend();
  const editor = deps.getEditorEl();
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .filter(input => !input.disabled && acceptsImageFile(input, file));

  for (const input of prioritizeFileInputs(inputs, editor)) {
    if (tryAssignFileInput(input, file)) return;
  }
  if (editor && dispatchClipboardFile(editor, file)) return;
  if (editor && dispatchDropFile(editor, file)) return;
  throw new Error('未找到可用的附件上传入口');
}

function acceptsImageFile(input: HTMLInputElement, file: File): boolean {
  const accept = (input.getAttribute('accept') || '').trim().toLowerCase();
  if (!accept) return true;
  if (accept.includes('image/*')) return true;
  if (accept.includes(file.type.toLowerCase())) return true;
  const ext = file.name.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
  return accept.split(',').map(s => s.trim()).includes(ext);
}

function prioritizeFileInputs(inputs: HTMLInputElement[], editor: HTMLElement | null): HTMLInputElement[] {
  if (!editor) return inputs;
  const editorRect = editor.getBoundingClientRect();
  return inputs.slice().sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const ad = Math.abs(ar.top - editorRect.top) + Math.abs(ar.left - editorRect.left);
    const bd = Math.abs(br.top - editorRect.top) + Math.abs(br.left - editorRect.left);
    return ad - bd;
  });
}

// Exported for the double-fire regression test. Assigns `file` to a file input
// and dispatches exactly one `change` event.
export function tryAssignFileInput(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    // Dispatch ONLY `change` — the canonical event for <input type="file">. React's
    // onChange on a file input also binds the native `change` event (file inputs are
    // the exception where React uses change, not input), so change alone covers both
    // React and vanilla handlers. Dispatching `input` too made sites that listen to
    // both (e.g. z.ai) fire their upload handler twice → the file uploaded twice on
    // a single init click.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!input.files && input.files.length > 0;
  } catch (error) {
    console.warn('[PierCode] file input 附件注入失败:', error);
    return false;
  }
}

function dispatchClipboardFile(target: HTMLElement, file: File): boolean {
  try {
    target.focus();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    // Do NOT also set text/plain to the filename. A file paste doesn't need it,
    // and if the site ignores the pasted FILE the filename text lands in the
    // editor — which then fools waitForAttachmentChip (it scans body.textContent
    // for the filename), reporting a phantom "attached" for a file that never
    // uploaded. The drop path deliberately omits it for the same reason.
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return true;
  } catch (error) {
    console.warn('[PierCode] paste 附件注入失败:', error);
    return false;
  }
}

function dispatchDropFile(target: HTMLElement, file: File): boolean {
  try {
    target.focus();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const events = ['dragenter', 'dragover', 'drop'];
    for (const type of events) {
      const event = new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    }
    return true;
  } catch (error) {
    console.warn('[PierCode] drop 附件注入失败:', error);
    return false;
  }
}
