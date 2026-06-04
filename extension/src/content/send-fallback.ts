export function setTextAreaValueAndNotify(editor: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const view = editor.ownerDocument.defaultView ?? window;
  const ctor = editor instanceof (view.HTMLInputElement ?? HTMLInputElement)
    ? view.HTMLInputElement
    : view.HTMLTextAreaElement;
  const nativeSetter = Object.getOwnPropertyDescriptor(ctor.prototype, 'value')?.set;

  editor.focus();
  editor.dispatchEvent(new view.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: 'insertText',
  }));

  let insertedByPage = false;
  try {
    editor.select();
    insertedByPage = editor.ownerDocument.execCommand?.('insertText', false, value) === true
      && editor.value === value;
  } catch {
    insertedByPage = false;
  }
  if (!insertedByPage) {
    if (nativeSetter) nativeSetter.call(editor, value);
    else editor.value = value;
  }

  const tracker = (editor as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker;
  try {
    tracker?.setValue('');
  } catch {}

  const end = value.length;
  try {
    editor.setSelectionRange(end, end);
  } catch {}
  editor.dispatchEvent(new view.InputEvent('input', {
    bubbles: true,
    data: value,
    inputType: 'insertText',
  }));
  editor.dispatchEvent(new view.Event('change', { bubbles: true }));
  editor.dispatchEvent(new view.KeyboardEvent('keyup', {
    key: 'Process',
    code: 'Process',
    bubbles: true,
  }));
}

export function setContentEditableValueAndNotify(editor: HTMLElement, value: string): void {
  const view = editor.ownerDocument.defaultView ?? window;
  const text = value.trimEnd();

  editor.focus();
  editor.dispatchEvent(new view.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: text,
    inputType: 'insertText',
  }));

  const selection = view.getSelection();
  if (selection && typeof editor.ownerDocument.execCommand === 'function') {
    const range = editor.ownerDocument.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.ownerDocument.execCommand('insertText', false, text);
  }

  const current = (editor.innerText || editor.textContent || '').trim();
  if (current !== text.trim()) {
    editor.textContent = '';
    const paragraph = editor.ownerDocument.createElement('p');
    paragraph.textContent = text;
    editor.appendChild(paragraph);
  }

  editor.dispatchEvent(new view.InputEvent('input', {
    bubbles: true,
    data: text,
    inputType: 'insertText',
  }));
  editor.dispatchEvent(new view.Event('change', { bubbles: true }));
  editor.dispatchEvent(new view.KeyboardEvent('keyup', {
    key: 'Process',
    code: 'Process',
    bubbles: true,
  }));
}

export function dispatchEnterAsSendFallback(editor: HTMLElement): boolean {
  const view = editor.ownerDocument.defaultView;
  const KeyboardEventCtor = view?.KeyboardEvent ?? KeyboardEvent;
  const event = new KeyboardEventCtor('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}
