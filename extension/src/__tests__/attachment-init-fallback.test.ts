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
import { beforeAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as any;
globalThis.document = dom.window.document;
(globalThis as any).File = dom.window.File;
(globalThis as any).Blob = dom.window.Blob;

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
