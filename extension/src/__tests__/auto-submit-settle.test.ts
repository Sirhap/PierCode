import { describe, expect, it } from 'vitest';
import { AUTO_SUBMIT_RESPONSE_SETTLE_MS, autoSubmitSettleRemainingMs } from '../content/auto-submit-settle';

describe('autoSubmitSettleRemainingMs', () => {
  it('allows immediate submit when no response or tool activity is known', () => {
    expect(autoSubmitSettleRemainingMs(1000, 0, 0)).toBe(0);
  });

  it('waits for the remaining response settle window before final submit', () => {
    expect(autoSubmitSettleRemainingMs(1200, 1000, 0)).toBe(AUTO_SUBMIT_RESPONSE_SETTLE_MS - 200);
  });

  it('uses the latest activity between response mutation and tool discovery', () => {
    expect(autoSubmitSettleRemainingMs(1300, 1000, 1200)).toBe(AUTO_SUBMIT_RESPONSE_SETTLE_MS - 100);
  });

  it('allows immediate submit after the settle window has elapsed', () => {
    expect(autoSubmitSettleRemainingMs(2000, 1000, 1200)).toBe(0);
  });
});
