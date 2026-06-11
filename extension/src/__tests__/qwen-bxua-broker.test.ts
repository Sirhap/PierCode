import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBxUaBroker } from '../background/qwen-bxua-broker';

describe('createBxUaBroker', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns cached value without re-borrowing on second call', async () => {
    const borrow = vi.fn().mockResolvedValue({ bxUa: 'X', umid: 'Y' });
    const broker = createBxUaBroker(borrow);
    const a = await broker.getBxUa();
    const b = await broker.getBxUa();
    expect(a).toEqual({ bxUa: 'X', umid: 'Y' });
    expect(b).toEqual({ bxUa: 'X', umid: 'Y' });
    expect(borrow).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent borrows into a single in-flight call', async () => {
    let resolveBorrow: (v: { bxUa: string; umid: string }) => void = () => {};
    const borrow = vi.fn().mockReturnValue(new Promise(r => { resolveBorrow = r; }));
    const broker = createBxUaBroker(borrow);
    const p1 = broker.getBxUa();
    const p2 = broker.getBxUa();
    resolveBorrow({ bxUa: 'X', umid: 'Y' });
    await Promise.all([p1, p2]);
    expect(borrow).toHaveBeenCalledTimes(1);
  });

  it('re-borrows after invalidate', async () => {
    const borrow = vi.fn()
      .mockResolvedValueOnce({ bxUa: 'A', umid: '1' })
      .mockResolvedValueOnce({ bxUa: 'B', umid: '2' });
    const broker = createBxUaBroker(borrow);
    expect(await broker.getBxUa()).toEqual({ bxUa: 'A', umid: '1' });
    broker.invalidate();
    expect(await broker.getBxUa()).toEqual({ bxUa: 'B', umid: '2' });
    expect(borrow).toHaveBeenCalledTimes(2);
  });

  it('returns null when borrow fails, and does not cache the failure', async () => {
    const borrow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bxUa: 'A', umid: '1' });
    const broker = createBxUaBroker(borrow);
    expect(await broker.getBxUa()).toBeNull();
    expect(await broker.getBxUa()).toEqual({ bxUa: 'A', umid: '1' });
    expect(borrow).toHaveBeenCalledTimes(2);
  });
});
