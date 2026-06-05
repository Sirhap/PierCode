import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
globalThis.window = window as any;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const storage = new Map<string, unknown>();
(globalThis as any).chrome = {
  storage: {
    local: {
      get: (_keys: string[], cb: (r: Record<string, unknown>) => void) => cb({}),
      set: (obj: Record<string, unknown>) => { for (const k in obj) storage.set(k, obj[k]); },
    },
  },
};

import { statusPanel, opStateLabel } from '../content/status-panel';

beforeEach(() => {
  document.body.innerHTML = '';
  statusPanel.destroy();
});

describe('status-panel opStateLabel', () => {
  it('maps states to zh labels', () => {
    expect(opStateLabel('idle')).toBe('空闲');
    expect(opStateLabel('thinking')).toBe('思考中');
    expect(opStateLabel('executing')).toBe('执行工具');
    expect(opStateLabel('done')).toBe('完成');
    expect(opStateLabel('error')).toBe('错误');
  });
});

describe('status-panel render', () => {
  it('mounts a root on init', () => {
    statusPanel.init();
    statusPanel.setProvider('gemini', 'gemini');
    expect(document.querySelector('[data-piercode-status-root]')).not.toBeNull();
  });

  it('defers mount until DOMContentLoaded when body is missing (document_start)', () => {
    // 模拟 document_start：body 尚未就绪。init 不应同步建 DOM。
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    statusPanel.init();
    expect(document.querySelector('[data-piercode-status-root]')).toBeNull();
    // 恢复 body，派发 DOMContentLoaded → 面板补建。
    Object.defineProperty(document, 'body', { value: realBody, configurable: true });
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    expect(document.querySelector('[data-piercode-status-root]')).not.toBeNull();
  });

  it('shows provider and tokens when expanded', () => {
    statusPanel.init();
    statusPanel.setProvider('claude', 'claude');
    statusPanel.setMeter({ input: 100, output: 50, total: 150, accuracy: 'estimate' }, 1000);
    statusPanel.expandForTest();
    const text = document.querySelector('[data-piercode-status-root]')!.textContent!;
    expect(text).toContain('claude');
    expect(text).toContain('150');
  });

  it('renders controlled tab info', () => {
    statusPanel.init();
    statusPanel.setControlledTab({ tabId: 7, title: 'Example', url: 'https://e.com' });
    statusPanel.expandForTest();
    const text = document.querySelector('[data-piercode-status-root]')!.textContent!;
    expect(text).toContain('Example');
    expect(text).toContain('7');
  });

  it('hides root in stealth mode', () => {
    statusPanel.init();
    statusPanel.configure({ stealth: true });
    const root = document.querySelector('[data-piercode-status-root]') as HTMLElement;
    expect(root.style.display).toBe('none');
  });
});
