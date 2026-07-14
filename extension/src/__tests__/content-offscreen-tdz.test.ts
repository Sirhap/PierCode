// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let asyncErrors: string[] = [];
let onError: ((event: ErrorEvent) => void) | null = null;
let onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

// Regression: content/index.ts top-level offscreen-relay block (entered when the
// frame is a qwen subframe WITHOUT the browser-agent sentinel — i.e. the hidden
// offscreen bx-ua iframe) calls injectPageBridge() during module eval. That
// function reads `pageBridgeInjected`. The flag is a module-level `let`; if it is
// declared AFTER the offscreen block, the eval-time call lands in its temporal
// dead zone → "Cannot access 'pageBridgeInjected' before initialization" →
// the whole module aborts before its EOF bootstrap. That stopped the browser-agent
// iframe from ever rendering its ⌁初始化 button / running tool detection.
//
// This test forces the offscreen-frame branch true and imports the module fresh;
// it must not throw. (With the flag hoisted above the block, it doesn't.)
describe('content/index.ts module eval in an offscreen-hosted qwen frame', () => {
  beforeEach(() => {
    vi.resetModules();
    asyncErrors = [];
    onError = event => {
      asyncErrors.push(String(event.error?.message || event.message || event));
    };
    onUnhandledRejection = event => {
      asyncErrors.push(String((event.reason as any)?.message || event.reason || event));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      asyncErrors.push(args.map(String).join(' '));
    });
    // Make isOffscreenHostedFrame() true: a qwen subframe (parent !== self) with
    // NO ?piercode_browser_agent= sentinel (so it is treated as the offscreen
    // frame, not the side-panel browser-agent frame).
    Object.defineProperty(window, 'parent', { value: {}, configurable: true });
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hostname: 'chat.qwen.ai', search: '', href: 'https://chat.qwen.ai/' },
      configurable: true,
    });
    // Minimal chrome stub: the offscreen block guards on chrome.runtime.id, and
    // injectPageScript uses chrome.runtime.getURL.
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        getURL: (p: string) => `chrome-extension://test-ext-id/${p}`,
        onConnect: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        connect: () => ({ postMessage: () => {}, disconnect: () => {}, onDisconnect: { addListener: () => {} }, onMessage: { addListener: () => {} } }),
        sendMessage: () => Promise.resolve(undefined),
      },
      storage: {
        local: { get: () => Promise.resolve({}), set: () => {} },
        onChanged: { addListener: () => {} },
      },
    };
  });

  afterEach(() => {
    if (onError) window.removeEventListener('error', onError);
    if (onUnhandledRejection) window.removeEventListener('unhandledrejection', onUnhandledRejection);
    consoleErrorSpy?.mockRestore();
    onError = null;
    onUnhandledRejection = null;
    consoleErrorSpy = null;
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it('does not throw a temporal-dead-zone error on pageBridgeInjected', async () => {
    // A throw here (TDZ on pageBridgeInjected) would reject the dynamic import.
    await expect(import('../content/index')).resolves.toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asyncErrors).toEqual([]);
  });
});
