import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.window = window as any;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
  cb(0);
  return 1;
};

const sendMessage = vi.fn();
(globalThis as any).chrome = {
  runtime: { sendMessage },
};

let visualIndicator: typeof import('../content/visual-indicator').visualIndicator;

describe('visualIndicator', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    sendMessage.mockClear();
    vi.resetModules();
    ({ visualIndicator } = await import('../content/visual-indicator'));
  });

  it('shows a pulsing border and user-visible stop button during browser work', () => {
    visualIndicator.showPulsingBorder();
    visualIndicator.showStatusBadge('loading');

    const container = document.getElementById('piercode-shadow-container');
    const root = container?.shadowRoot;

    expect(root?.getElementById('piercode-agent-glow-border')).toBeTruthy();
    expect(root?.getElementById('piercode-agent-stop-button')?.textContent).toContain('停止操作');
    expect(root?.getElementById('piercode-status-badge')?.textContent).toContain('Loading');
    expect(visualIndicator.state.isPulsingActive).toBe(true);
  });

  it('sends STOP_BROWSER_OPERATION when the stop button is clicked', () => {
    visualIndicator.showPulsingBorder();

    const button = document
      .getElementById('piercode-shadow-container')
      ?.shadowRoot
      ?.getElementById('piercode-agent-stop-button') as HTMLButtonElement | null;
    expect(button).toBeTruthy();

    button?.click();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'STOP_BROWSER_OPERATION' });
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('正在停止');
  });

  it('hides indicators while preserving enough state to show them again after tool UI work', () => {
    visualIndicator.showPulsingBorder();
    visualIndicator.showStatusBadge('completed');
    visualIndicator.hideForToolUse();

    const root = document.getElementById('piercode-shadow-container')?.shadowRoot;
    expect(root?.getElementById('piercode-agent-glow-border')?.style.display).toBe('none');
    expect(root?.getElementById('piercode-agent-stop-container')?.style.display).toBe('none');
    expect(visualIndicator.state.wasPulsingBeforeHide).toBe(true);

    visualIndicator.showAfterToolUse();

    expect(root?.getElementById('piercode-agent-glow-border')?.style.display).toBe('');
    expect(root?.getElementById('piercode-agent-stop-container')?.style.display).toBe('');
    expect(visualIndicator.state.wasPulsingBeforeHide).toBe(false);
  });
});
