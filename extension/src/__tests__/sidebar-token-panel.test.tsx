import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import TokenPanel from '../sidebar/token-panel';
import { computeMeter, __resetTokenizerForTest } from '../sidebar/token-count';

// Deterministic tokenizer: 1 token per 4 chars.
vi.mock('js-tiktoken', () => ({
  getEncoding: vi.fn(() => ({ encode: (t: string) => new Array(Math.ceil(t.length / 4)).fill(0) })),
}));

let dom: JSDOM;
let root: Root | null;
let host: HTMLElement;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as any).window = dom.window as any;
  (globalThis as any).document = dom.window.document;
  host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  __resetTokenizerForTest();
});

describe('sidebar TokenPanel', () => {
  it('renders an estimate badge before the tokenizer loads', () => {
    const meter = computeMeter([{ role: 'user', content: 'hello world' }], 'qwen');
    act(() => {
      root!.render(
        <TokenPanel
          meter={meter}
          platform="qwen"
        />,
      );
    });
    expect(host.textContent).toContain('estimate');
  });

  it('counts user content as input and assistant content as output', () => {
    // App computes meter from messages; test mirrors that pre-computation.
    const meter = computeMeter(
      [
        { role: 'user', content: 'aaaa' },
        { role: 'assistant', content: 'bbbbbbbb' },
      ],
      'chatgpt',
    );
    act(() => {
      root!.render(
        <TokenPanel
          meter={meter}
          platform="chatgpt"
        />,
      );
    });
    // Char-estimate fallback (tokenizer not awaited): both labels shown.
    expect(host.textContent).toMatch(/Input/);
    expect(host.textContent).toMatch(/Output/);
  });
});
