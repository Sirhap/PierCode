export const AUTO_SUBMIT_RESPONSE_SETTLE_MS = 700;

export function autoSubmitSettleRemainingMs(
  now: number,
  lastResponseMutationAt: number,
  lastAutoToolSeenAt: number,
  settleMs = AUTO_SUBMIT_RESPONSE_SETTLE_MS,
): number {
  const lastActivity = Math.max(lastResponseMutationAt, lastAutoToolSeenAt);
  if (lastActivity === 0) return 0;
  return Math.max(0, settleMs - (now - lastActivity));
}
