import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../background/browser/dispatch';

describe('KeyedLock key eviction (audit #20)', () => {
  it('drops a key entry after its chain drains', async () => {
    const lock = new KeyedLock();
    await lock.run('tab:1', async () => 'ok');
    // Let the post-settle cleanup microtask run.
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });

  it('does not accumulate one entry per distinct key', async () => {
    const lock = new KeyedLock();
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      runs.push(lock.run(`tab:${i}`, async () => i));
    }
    await Promise.all(runs);
    // Flush cleanup microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });

  it('still serializes same-key work in order', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    const a = lock.run('tab:default', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    const b = lock.run('tab:default', async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });

  it('a rejected chain does not poison the key and is still evicted', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('tab:x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A subsequent run on the same key still executes.
    const v = await lock.run('tab:x', async () => 'recovered');
    expect(v).toBe('recovered');
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });
});
