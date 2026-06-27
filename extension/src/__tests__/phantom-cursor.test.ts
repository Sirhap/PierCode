import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPhantomCursorExpression, syncPhantomCursor } from '../background/phantom-cursor';

const sendCommand = vi.fn();
(globalThis as any).chrome = {
  debugger: { sendCommand },
};

describe('syncPhantomCursor', () => {
  beforeEach(() => {
    sendCommand.mockReset();
    sendCommand.mockResolvedValue({});
  });

  it('sends Runtime.evaluate with rounded coordinates before mouse events', async () => {
    await syncPhantomCursor(7, { type: 'mouseMoved', x: 10.6, y: 20.2 });

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const [target, method, args] = sendCommand.mock.calls[0];
    expect(target).toEqual({ tabId: 7 });
    expect(method).toBe('Runtime.evaluate');
    expect(args.awaitPromise).toBe(true);
    expect(args.expression).toContain('.move(11, 20, "mouseMoved")');
  });

  it('skips when coordinates are missing', async () => {
    await syncPhantomCursor(7, { type: 'mouseMoved' });
    await syncPhantomCursor(7, { type: 'mouseMoved', x: 'a', y: 1 });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('waits for the move animation on mouseMoved/mousePressed but caps the wait', async () => {
    vi.useFakeTimers();
    try {
      sendCommand.mockReturnValue(new Promise(() => {})); // 页面端永不 resolve
      let settled = false;
      const p = syncPhantomCursor(7, { type: 'mousePressed', x: 1, y: 2 }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(319); // MOVE_WAIT_CAP_MS = 320
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait on mouseReleased', async () => {
    sendCommand.mockReturnValue(new Promise(() => {}));
    await syncPhantomCursor(7, { type: 'mouseReleased', x: 1, y: 2 });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('swallows debugger errors', async () => {
    sendCommand.mockRejectedValue(new Error('No tab with given id'));
    await expect(syncPhantomCursor(7, { type: 'mouseMoved', x: 1, y: 2 })).resolves.toBeUndefined();
  });
});

describe('phantom cursor renderer (page context)', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    // 让渲染器里的 setTimeout/clearTimeout 走宿主(可被 vi.useFakeTimers 控制)的实现,
    // 否则它们绑在 JSDOM realm 上,fake timers 推不动。
    dom.window.setTimeout = ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof dom.window.setTimeout;
    dom.window.clearTimeout = ((id: number) => clearTimeout(id)) as typeof dom.window.clearTimeout;
  });

  afterEach(() => {
    // Tear the renderer down (disconnect observer, clear idle timers, remove
    // host) BEFORE closing the JSDOM realm. Without this, a queued self-heal
    // MutationObserver callback fires after window.close() and throws an uncaught
    // "Cannot read properties of undefined (reading 'body')" (audit #15).
    try {
      const pcc = (dom.window as any).__piercodePhantomCursor;
      if (pcc && typeof pcc.destroy === 'function') pcc.destroy();
    } catch { /* ignore */ }
    dom.window.close();
  });

  function move(x: number, y: number, type?: string): Promise<void> {
    return dom.window.eval(buildPhantomCursorExpression(x, y, type)) as Promise<void>;
  }

  // The cursor now lives inside a CLOSED shadow root on a neutral host element,
  // so it is intentionally unreachable via document.querySelector. The host is
  // the only fixed-position, max-z-index div we add; find it that way.
  function findHost(): HTMLElement | null {
    const divs = Array.from(dom.window.document.body.querySelectorAll('div')) as HTMLElement[];
    return divs.find(d => d.style.zIndex === '2147483646' && d.style.position === 'fixed') || null;
  }

  it('mounts a closed-shadow host on first move (cursor not exposed to the page)', async () => {
    await move(100, 50);

    // Old #id is gone — the page cannot find the cursor by id anymore.
    expect(dom.window.document.getElementById('piercode-phantom-cursor')).toBeNull();
    const host = findHost();
    expect(host).toBeTruthy();
    expect(host!.isConnected).toBe(true);
    // Closed shadow root is not reachable from the host.
    expect((host as any).shadowRoot).toBeNull();
  });

  it('reuses the single host instead of creating another', async () => {
    await move(10, 10);
    const first = findHost();

    await move(200, 300); // JSDOM 不发 transitionend,靠 220ms 兜底 resolve

    const second = findHost();
    expect(second).toBe(first);
    // Only one host overlay exists.
    const hosts = Array.from(dom.window.document.body.querySelectorAll('div')).filter(
      d => (d as HTMLElement).style.zIndex === '2147483646' && (d as HTMLElement).style.position === 'fixed',
    );
    expect(hosts).toHaveLength(1);
  });

  it('resolves immediately when the position is unchanged', async () => {
    await move(10, 10);
    const start = Date.now();
    await move(10, 10);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('destroy() tears down the host and observer immediately (audit #15)', async () => {
    await move(10, 10);
    const host = findHost();
    expect(host).toBeTruthy();
    const pcc = (dom.window as any).__piercodePhantomCursor;
    expect(typeof pcc.destroy).toBe('function');
    pcc.destroy();
    // Host overlay is gone right away (no 15s idle wait).
    expect(findHost()).toBeNull();
    // A subsequent body mutation must NOT throw — the observer was disconnected.
    expect(() => {
      const d = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(d);
      d.remove();
    }).not.toThrow();
  });

  it('removes the host overlay after the idle remove delay', async () => {
    vi.useFakeTimers();
    try {
      await move(10, 10);
      const host = findHost()!;
      expect(host).toBeTruthy();

      // IDLE_HIDE_MS(9000): the cursor dims but the host stays mounted.
      await vi.advanceTimersByTimeAsync(9100);
      expect(host.isConnected).toBe(true);

      // After IDLE_REMOVE_MS(6000) more, the whole host overlay is torn down.
      await vi.advanceTimersByTimeAsync(6100);
      expect(host.isConnected).toBe(false);
      expect(findHost()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
