import { describe, expect, it, vi } from 'vitest';
import { SinglePacketWaiter } from '../content/qwen-context-packet-waiter';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SinglePacketWaiter', () => {
  it('registers before send without starting the timeout clock', async () => {
    vi.useFakeTimers();
    try {
      const waiter = new SinglePacketWaiter<string>();
      let settled: string | null | undefined;
      const promise = waiter.register();
      promise.then(value => { settled = value; });

      vi.advanceTimersByTime(60_000);
      await flushMicrotasks();
      expect(settled).toBeUndefined();

      waiter.startTimeout(1_000);
      vi.advanceTimersByTime(999);
      await flushMicrotasks();
      expect(settled).toBeUndefined();

      vi.advanceTimersByTime(1);
      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles pending promises when canceled', async () => {
    const waiter = new SinglePacketWaiter<string>();
    const promise = waiter.register();

    waiter.cancel();

    await expect(promise).resolves.toBeNull();
  });

  it('ignores a timeout armed after a fast packet already resolved', async () => {
    vi.useFakeTimers();
    try {
      const waiter = new SinglePacketWaiter<string>();
      const promise = waiter.register();

      expect(waiter.resolve('packet')).toBe(true);
      waiter.startTimeout(1);
      vi.advanceTimersByTime(1);

      await expect(promise).resolves.toBe('packet');
    } finally {
      vi.useRealTimers();
    }
  });
});
