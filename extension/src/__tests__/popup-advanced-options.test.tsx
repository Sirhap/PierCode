import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import App from '../popup/App';

type StorageData = Record<string, unknown>;

let dom: JSDOM;
let root: Root | null;
let host: HTMLElement;
let storageData: StorageData;
let storageSet: ReturnType<typeof vi.fn>;

function installChromeMock(initial: StorageData = {}) {
  storageData = { ...initial };
  storageSet = vi.fn((value: StorageData, callback?: () => void) => {
    Object.assign(storageData, value);
    callback?.();
  });

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn((keys: string[] | string, callback: (result: StorageData) => void) => {
          const names = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(names.map((name) => [name, storageData[name]])));
        }),
        set: storageSet,
        remove: vi.fn((keys: string[] | string, callback?: () => void) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
          callback?.();
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(),
      lastError: undefined,
    },
  };
}

async function renderPopup(initialStorage?: StorageData) {
  installChromeMock(initialStorage);
  await act(async () => {
    root = createRoot(host);
    root.render(<App />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('popup advanced options', () => {
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

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    vi.restoreAllMocks();
  });

  it('keeps advanced-only options hidden until the section is expanded', async () => {
    await renderPopup();

    expect(document.body.textContent).toContain('高级选项');
    expect(document.body.textContent).not.toContain('隐身模式');
    expect(document.body.textContent).not.toContain('自动审批浏览器操作');
    expect(document.body.textContent).not.toContain('自动提交随机延迟');

    await act(async () => {
      const advancedButton = Array.from(document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('高级选项')
      ) as HTMLButtonElement | undefined;
      advancedButton?.click();
    });

    expect(document.body.textContent).toContain('隐身模式');
    expect(document.body.textContent).toContain('自动审批浏览器操作');
    expect(document.body.textContent).toContain('自动提交随机延迟');
  });

  it('persists the stealth mode default on first load', async () => {
    await renderPopup();

    expect(storageSet).toHaveBeenCalledWith({ stealthMode: false });
    expect(storageData.stealthMode).toBe(false);
  });
});
