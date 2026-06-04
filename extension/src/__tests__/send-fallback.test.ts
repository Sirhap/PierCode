import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { dispatchEnterAsSendFallback, setContentEditableValueAndNotify, setTextAreaValueAndNotify } from '../content/send-fallback';

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

  it('sets textarea value and dispatches rich input notifications', () => {
    const dom = new JSDOM('<textarea>old</textarea>');
    const editor = dom.window.document.querySelector('textarea')!;
    const events: string[] = [];
    editor.addEventListener('beforeinput', event => events.push(`${event.type}:${(event as InputEvent).inputType || ''}`));
    editor.addEventListener('input', event => events.push(`${event.type}:${(event as InputEvent).inputType || ''}`));
    editor.addEventListener('change', event => events.push(event.type));
    editor.addEventListener('keyup', event => events.push(`${event.type}:${(event as KeyboardEvent).key}`));

    setTextAreaValueAndNotify(editor, 'new prompt');

    expect(editor.value).toBe('new prompt');
    expect(events).toContain('beforeinput:insertText');
    expect(events).toContain('input:insertText');
    expect(events).toContain('change');
    expect(events).toContain('keyup:Process');
  });

  it('prefers page insertText for textarea so controlled inputs can enable send buttons', () => {
    const dom = new JSDOM('<textarea>old</textarea>');
    const editor = dom.window.document.querySelector('textarea')!;
    let execCommandCalled = false;
    dom.window.document.execCommand = ((command: string, _showUI?: boolean, value?: string) => {
      execCommandCalled = command === 'insertText';
      editor.value = value || '';
      return true;
    }) as typeof dom.window.document.execCommand;

    setTextAreaValueAndNotify(editor, 'new prompt');

    expect(execCommandCalled).toBe(true);
    expect(editor.value).toBe('new prompt');
  });

  it('sets contenteditable text and dispatches rich input notifications', () => {
    const dom = new JSDOM('<div contenteditable="true" id="prompt-textarea"><p>old</p></div>');
    const editor = dom.window.document.querySelector<HTMLElement>('#prompt-textarea')!;
    const events: string[] = [];
    editor.addEventListener('beforeinput', event => events.push(`${event.type}:${(event as InputEvent).inputType || ''}`));
    editor.addEventListener('input', event => events.push(`${event.type}:${(event as InputEvent).inputType || ''}`));
    editor.addEventListener('change', event => events.push(event.type));
    editor.addEventListener('keyup', event => events.push(`${event.type}:${(event as KeyboardEvent).key}`));

    setContentEditableValueAndNotify(editor, 'new prompt');

    expect(editor.textContent).toContain('new prompt');
    expect(events).toContain('beforeinput:insertText');
    expect(events).toContain('input:insertText');
    expect(events).toContain('change');
    expect(events).toContain('keyup:Process');
  });
});
