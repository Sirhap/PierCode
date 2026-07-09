/**
 * #8 init-context-too-long -> attachment upload.
 *
 * When the init prompt injected into a platform exceeds the input-length wall,
 * the content init-injection flow uploads it as a .txt attachment instead of
 * typing it (which would be truncated by the editor). These are the pure
 * decision + file-shaping units; the DOM injection itself is exercised by the
 * existing attachment-upload path (attachFileToCurrentChat).
 *
 * attachment-upload imports ws-linker, which reads `window` at module-eval to
 * mint a per-document client id, so a DOM must exist before importing.
 */
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as any;
globalThis.document = dom.window.document;
(globalThis as any).File = dom.window.File;
(globalThis as any).Blob = dom.window.Blob;

// The module reads bare globals (`new DataTransfer()`, `new Event(...)`,
// `dispatchEvent`), which resolve to globalThis — so the shims must live there,
// not only on dom.window. The test runs under vitest's node environment, so
// these aren't present unless we set them. jsdom also ships no DataTransfer and
// no writable `files` setter on file inputs; tryAssignFileInput's real
// assignment is a browser-only concern, so shim just enough for the try-block to
// complete and reach the dispatchEvent this test pins.
(globalThis as any).Event = dom.window.Event;
(globalThis as any).DataTransfer = class {
  _files: File[] = [];
  items = { add: (f: File) => { this._files.push(f); } };
  get files() { return this._files; }
};
Object.defineProperty(dom.window.HTMLInputElement.prototype, 'files', {
  configurable: true,
  get() { return (this as any).__files ?? []; },
  set(v) { (this as any).__files = v; },
});

let mod: typeof import('../content/attachment-upload');

beforeAll(async () => {
  mod = await import('../content/attachment-upload');
});

describe('#8 shouldUploadInitAsAttachment', () => {
  it('returns false for text at or under the limit', () => {
    expect(mod.shouldUploadInitAsAttachment('short', 100)).toBe(false);
    expect(mod.shouldUploadInitAsAttachment('x'.repeat(100), 100)).toBe(false);
  });

  it('returns true once the text exceeds the limit', () => {
    expect(mod.shouldUploadInitAsAttachment('x'.repeat(101), 100)).toBe(true);
  });

  it('treats a non-positive / missing limit as no wall (never upload)', () => {
    expect(mod.shouldUploadInitAsAttachment('x'.repeat(10000), 0)).toBe(false);
    expect(mod.shouldUploadInitAsAttachment('x'.repeat(10000), -1)).toBe(false);
    expect(mod.shouldUploadInitAsAttachment('x'.repeat(10000), undefined)).toBe(false);
  });

  it('ships a sane default threshold', () => {
    expect(mod.INIT_ATTACHMENT_THRESHOLD).toBeGreaterThan(1000);
  });
});

describe('#8 buildTextAttachmentFile', () => {
  it('wraps text into a named text/plain File', () => {
    const f = mod.buildTextAttachmentFile('hello world', 'piercode-init.txt');
    expect(f.name).toBe('piercode-init.txt');
    expect(f.type).toBe('text/plain');
    expect(f.size).toBeGreaterThan(0);
  });

  it('defaults the filename when omitted', () => {
    const f = mod.buildTextAttachmentFile('hi');
    expect(f.name).toMatch(/\.txt$/);
  });
});

describe('all non-aistudio platforms upload when prompt exceeds threshold', () => {
  it('a 20k+ char prompt (init_prompt.txt size) triggers upload at the default threshold', () => {
    const longPrompt = 'x'.repeat(21000);
    expect(mod.shouldUploadInitAsAttachment(longPrompt, mod.INIT_ATTACHMENT_THRESHOLD)).toBe(true);
  });

  it('a short prompt (qwen_base size ~7k) does NOT trigger upload', () => {
    const shortPrompt = 'x'.repeat(7500);
    expect(mod.shouldUploadInitAsAttachment(shortPrompt, mod.INIT_ATTACHMENT_THRESHOLD)).toBe(false);
  });
});

// Gemini regression: a platform's own async upload pipeline (observed: a
// one-time consent dialog on first file upload) can silently swallow the file
// input's `change` event without ever attaching it. attachFileToCurrentChat
// doesn't throw (the DOM dispatch itself succeeded), so uploadInitPromptAsAttachment
// must independently confirm the attachment chip actually rendered before the
// caller sends a "已作为附件上传" pointer message for a file that was never
// really attached.
describe('waitForAttachmentChip (Gemini one-time-dialog regression)', () => {
  afterEach(() => {
    document.body.textContent = '';
  });

  it('resolves true as soon as the filename appears in the page text', async () => {
    document.body.innerHTML = '<div>TXT piercode-init</div>';
    const ok = await mod.waitForAttachmentChip('piercode-init.txt', 2000);
    expect(ok).toBe(true);
  });

  it('resolves true matching the full filename with extension', async () => {
    document.body.innerHTML = '<div>Attached: piercode-init.txt</div>';
    const ok = await mod.waitForAttachmentChip('piercode-init.txt', 2000);
    expect(ok).toBe(true);
  });

  it('resolves false on timeout when the chip never appears (dialog swallowed the upload)', async () => {
    document.body.innerHTML = '<div>嗨，zhang，今天有什么安排？</div>';
    const ok = await mod.waitForAttachmentChip('piercode-init.txt', 300);
    expect(ok).toBe(false);
  });
});

describe('uploadInitPromptAsAttachment falls back when the chip never confirms', () => {
  beforeAll(() => {
    mod.initAttachmentUploadDeps({
      checkContext: () => true,
      bgFetch: async () => ({ ok: true, status: 200, body: '' }),
      apiEndpoint: (apiUrl, path) => apiUrl + path,
      focusCurrentTabForSend: async () => {},
      getEditorEl: () => null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('throws (so the caller falls back to typing) when no file input exists AND no chip appears', async () => {
    // No file input, no contenteditable target in the DOM → attachFileToCurrentChat
    // itself throws "未找到可用的附件上传入口" before waitForAttachmentChip even runs.
    await expect(mod.uploadInitPromptAsAttachment('x'.repeat(20000), 'piercode-init.txt'))
      .rejects.toThrow();
  });
});

// Regression: z.ai bound its upload handler to BOTH `input` and `change` on the
// file input, so dispatching both events fired the upload twice on a single init
// click (the file uploaded twice). tryAssignFileInput must dispatch exactly one
// `change` and zero `input` events — the canonical file-input event that covers
// React (file inputs are the React exception that uses `change`, not `input`) and
// vanilla handlers alike.
describe('tryAssignFileInput dispatches a single change event (no double upload)', () => {
  it('fires change exactly once and never fires input', () => {
    const input = document.createElement('input');
    input.type = 'file';
    document.body.appendChild(input);
    let changeCount = 0;
    let inputCount = 0;
    input.addEventListener('change', () => { changeCount++; });
    input.addEventListener('input', () => { inputCount++; });

    const file = mod.buildTextAttachmentFile('payload', 'piercode-init.txt');
    const ok = mod.tryAssignFileInput(input, file);

    expect(ok).toBe(true);
    expect(changeCount).toBe(1);
    expect(inputCount).toBe(0);
    expect(input.files?.length).toBe(1);
    input.remove();
  });
});
