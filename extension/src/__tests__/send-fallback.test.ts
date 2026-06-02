import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { dispatchEnterAsSendFallback } from '../content/send-fallback';

describe('dispatchEnterAsSendFallback', () => {
  it('does not report success when Enter is not handled', () => {
    const dom = new JSDOM('<textarea>prompt</textarea>');
    const editor = dom.window.document.querySelector('textarea')!;

    expect(dispatchEnterAsSendFallback(editor)).toBe(false);
  });

  it('reports success when the page handles Enter as a send action', () => {
    const dom = new JSDOM('<textarea>prompt</textarea>');
    const editor = dom.window.document.querySelector('textarea')!;
    editor.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Enter') event.preventDefault();
    });

    expect(dispatchEnterAsSendFallback(editor)).toBe(true);
  });
});
