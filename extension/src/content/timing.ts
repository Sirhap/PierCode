// timing.ts — centralized timing constants. Previously scattered as magic numbers
// in setTimeout calls. Documented so the trade-off (why this delay) is explicit.
export const TIMING = {
  // Wait for the chat editor to hydrate before injecting a large handoff payload.
  HANDOFF_EDITOR_SETTLE_MS: 800,
  // Poll interval while waiting for the Qwen editor element to appear.
  EDITOR_POLL_MS: 500,
  // Re-scan delay after expanding a Qwen Monaco overflow placeholder.
  MONACO_OVERFLOW_RESCAN_MS: 300,
} as const
