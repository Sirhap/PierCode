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
