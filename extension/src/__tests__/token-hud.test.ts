import { beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { ratioStyle, fmt, tokenHud } from '../content/token-hud';

const storage = new Map<string, unknown>();

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window as any;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.MouseEvent = dom.window.MouseEvent;
  storage.clear();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: (_keys: string[], cb: (r: Record<string, unknown>) => void) => cb({}),
        set: (obj: Record<string, unknown>) => { for (const k in obj) storage.set(k, obj[k]); },
      },
    },
  };
  tokenHud.destroy();
});

describe('token-hud ratioStyle color segments', () => {
  it('is green below 80%', () => {
    expect(ratioStyle(0, 100).label).toBe('green');
    expect(ratioStyle(79, 100).label).toBe('green');
  });

  it('is yellow from 80% to under 100%', () => {
    expect(ratioStyle(80, 100).label).toBe('yellow');
    expect(ratioStyle(99, 100).label).toBe('yellow');
  });

  it('is red at or above 100%', () => {
    expect(ratioStyle(100, 100).label).toBe('red');
    expect(ratioStyle(250, 100).label).toBe('red');
  });

  it('treats zero/invalid threshold as green', () => {
    expect(ratioStyle(500, 0).label).toBe('green');
  });
});

describe('token-hud fmt', () => {
  it('formats thousands and millions', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(950)).toBe('950');
    expect(fmt(1_500)).toBe('1.5k');
    expect(fmt(128_000)).toBe('128k');
    expect(fmt(1_000_000)).toBe('1m');
    expect(fmt(1_250_000)).toBe('1.25m');
  });
});

describe('token-hud panel interactions', () => {
  it('collapses when clicking outside the panel', () => {
    tokenHud.init();
    tokenHud.update({ input: 100, output: 50, total: 150, accuracy: 'estimate' }, 1_000, 'chatgpt');
    const root = document.querySelector('[data-piercode-token-root]') as HTMLElement;
    const dot = root.querySelector('button') as HTMLButtonElement;

    dot.click();
    expect(root.textContent).toContain('PierCode · chatgpt');

    document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));

    const panel = root.querySelector('div') as HTMLElement;
    expect(panel.style.display).toBe('none');
    expect(storage.get('tokenHudExpanded')).toBe(false);
  });
});
