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
    dom.window.close();
  });

  function move(x: number, y: number, type?: string): Promise<void> {
    return dom.window.eval(buildPhantomCursorExpression(x, y, type)) as Promise<void>;
  }

  it('creates the cursor element at the given position on first move', async () => {
    await move(100, 50);

    const el = dom.window.document.getElementById('piercode-phantom-cursor');
    expect(el).toBeTruthy();
    expect(el!.style.transform).toBe('translate3d(100px,50px,0)');
    expect(el!.style.pointerEvents).toBe('none');
    expect(el!.getAttribute('aria-hidden')).toBe('true');
    expect(el!.querySelectorAll('svg')).toHaveLength(2);
    expect(el!.querySelectorAll('path')).toHaveLength(4);
  });

  it('moves the existing element instead of recreating it', async () => {
    await move(10, 10);
    const first = dom.window.document.getElementById('piercode-phantom-cursor');

    await move(200, 300); // JSDOM 不发 transitionend,靠 220ms 兜底 resolve

    const second = dom.window.document.getElementById('piercode-phantom-cursor');
    expect(second).toBe(first);
    expect(second!.style.transform).toBe('translate3d(200px,300px,0)');
    expect(dom.window.document.querySelectorAll('#piercode-phantom-cursor')).toHaveLength(1);
  });

  it('resolves immediately when the position is unchanged', async () => {
    await move(10, 10);
    const start = Date.now();
    await move(10, 10);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('dims to a resident state at idle, then removes the cursor after the remove delay', async () => {
    vi.useFakeTimers();
    try {
      await move(10, 10);
      const el = dom.window.document.getElementById('piercode-phantom-cursor')!;

      // IDLE_HIDE_MS(9000): 降到半透明驻留,仍在 DOM 中
      await vi.advanceTimersByTimeAsync(9100);
      expect(el.isConnected).toBe(true);
      expect(el.style.opacity).toBe('0.35');

      // 再过 IDLE_REMOVE_MS(6000): 真正移除
      await vi.advanceTimersByTimeAsync(6100);
      expect(el.isConnected).toBe(false);
      expect(dom.window.document.getElementById('piercode-phantom-cursor')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
