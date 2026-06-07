import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import CanvasNodeCard from '../hub/canvas/CanvasNodeCard';
import type { CanvasNode } from '../hub/project-store';

let dom: JSDOM;
let root: Root | null;
let host: HTMLElement;

const node: CanvasNode = { id: 'n1', providerId: 'qwen', x: 0, y: 0, w: 400, h: 300 };

function render(ui: React.ReactElement) {
  act(() => {
    root = createRoot(host);
    root.render(ui);
  });
}

describe('CanvasNodeCard', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.SVGElement = dom.window.SVGElement;
    host = document.getElementById('root') as HTMLElement;
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.restoreAllMocks();
  });

  const noop = () => {};

  it('does NOT render the pointer shield when idle (iframe is interactive)', () => {
    render(
      <CanvasNodeCard node={node} focused={false} gesturing={false} onStartDrag={noop} onFocus={noop} onClose={noop} />,
    );
    expect(document.querySelector('.canvas-node-shield')).toBeNull();
    // The iframe must be present and not covered.
    expect(document.querySelector('.canvas-node-frame')).not.toBeNull();
  });

  it('renders the pointer shield only while a gesture is in progress', () => {
    render(
      <CanvasNodeCard node={node} focused={false} gesturing={true} onStartDrag={noop} onFocus={noop} onClose={noop} />,
    );
    expect(document.querySelector('.canvas-node-shield')).not.toBeNull();
  });

  it('close button fires onClose (not swallowed by the drag handle)', () => {
    const onClose = vi.fn();
    const onStartDrag = vi.fn();
    render(
      <CanvasNodeCard node={node} focused={false} gesturing={false} onStartDrag={onStartDrag} onFocus={noop} onClose={onClose} />,
    );
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.title === '关闭')!;
    act(() => {
      closeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith('n1');
  });
});
