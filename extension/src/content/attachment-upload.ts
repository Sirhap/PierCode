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

function tryAssignFileInput(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    transfer.setData('text/plain', file.name);
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
