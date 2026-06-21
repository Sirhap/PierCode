// completion.ts — shared turn-completion state machine for platform adapters.
//
// Why this exists: historically each adapter / the content scan inferred
// "streaming finished" inconsistently (text-stopped heuristics, session-active
// gates), which produced both false-positives (a still-streaming response judged
// done → a half tool fence executed) and false-negatives (a finished response
// never marked complete → tool results never submitted). See memory
// `session-gating-tool-detection`.
//
// This module centralizes ONLY the timing logic, mirroring webcode's
// completion_notifier: a turn is "complete" exactly when
//   1) the stop/generate control has DISAPPEARED (idle), AND
//   2) the response text has been STABLE for a settle window (default 600ms),
//      so a momentary streaming pause near a value boundary doesn't fire early, AND
//   3) the turn's signature (messageIndex:hash(text)) differs from the last one
//      we already reported — so the same finished turn is reported at most once.
//
// It is intentionally DOM-AGNOSTIC and pure: the caller feeds it observations
// (`stopVisible`, `messageIndex`, `text`) plus a clock, and it returns whether
// THIS observation transitions the turn to complete. Adapters keep their own
// selector knowledge (the stop control lives in content's PLATFORM_SELECTORS);
// they only borrow this settle+signature timing. That separation keeps the state
// machine unit-testable with a fake clock and no jsdom.

export const COMPLETION_SETTLE_MS = 600;
// After a turn fires complete, ignore re-fires for this long (debounce a noisy
// observer that keeps polling the same idle DOM). Mirrors webcode's 1000ms cooldown.
export const COMPLETION_COOLDOWN_MS = 1000;
// Cap the dedup set so a very long session can't grow it unbounded (FIFO evict).
export const COMPLETION_KEY_LIMIT = 200;

export interface CompletionObservation {
  // Is the "stop generating" control currently in the DOM? true ⇒ still streaming.
  stopVisible: boolean;
  // Index of the message/turn being observed (monotonic per conversation). Part
  // of the signature so two turns with byte-identical text still count as distinct.
  messageIndex: number;
  // Current rendered response text of that turn.
  text: string;
}

export interface CompletionDetectorOptions {
  settleMs?: number;
  cooldownMs?: number;
  keyLimit?: number;
}

// djb2-ish 31-mult hash (same family as parser.djb31Hash / tool-card.hashStr) so
// the signature is cheap and stable. Local copy keeps this module dependency-free.
function hashText(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

export function completionSignature(messageIndex: number, text: string): string {
  return `${messageIndex}:${hashText(text)}`;
}

export interface CompletionDetector {
  // Feed one observation at time `now` (ms). Returns true EXACTLY on the
  // observation that transitions this turn to complete (stop gone + text stable
  // for the settle window + a not-yet-reported signature). Returns false while
  // streaming, while settling, or for an already-reported turn.
  observe(obs: CompletionObservation, now: number): boolean;
  // Drop all remembered state (e.g. on conversation switch).
  reset(): void;
}

// createCompletionDetector builds an independent detector instance. Keep one per
// conversation/page; the dedup set is per-instance.
export function createCompletionDetector(opts: CompletionDetectorOptions = {}): CompletionDetector {
  const settleMs = opts.settleMs ?? COMPLETION_SETTLE_MS;
  const cooldownMs = opts.cooldownMs ?? COMPLETION_COOLDOWN_MS;
  const keyLimit = opts.keyLimit ?? COMPLETION_KEY_LIMIT;

  // Signatures already reported, FIFO-evicted at keyLimit.
  const notified = new Set<string>();
  // The signature we are currently waiting to settle, and since when its text
  // last stayed unchanged while idle.
  let pendingSig = '';
  let stableSince = 0;
  let lastFiredAt = -Infinity;

  function remember(sig: string): void {
    notified.add(sig);
    if (notified.size > keyLimit) {
      const oldest = notified.values().next().value;
      if (oldest !== undefined) notified.delete(oldest);
    }
  }

  return {
    observe(obs, now) {
      // Still generating → not complete; clear any in-flight settle so the timer
      // restarts once the stop control disappears.
      if (obs.stopVisible) {
        pendingSig = '';
        stableSince = 0;
        return false;
      }
      const sig = completionSignature(obs.messageIndex, obs.text);
      // Already reported this exact finished turn → suppress (idempotent).
      if (notified.has(sig)) return false;
      // Within cooldown after a previous fire → suppress chatter.
      if (now - lastFiredAt < cooldownMs) {
        // Still track the settle baseline so we fire promptly once cooldown ends.
        if (sig !== pendingSig) { pendingSig = sig; stableSince = now; }
        return false;
      }
      // New idle signature → start (or restart) the settle window.
      if (sig !== pendingSig) {
        pendingSig = sig;
        stableSince = now;
        return false;
      }
      // Same idle signature held long enough → complete.
      if (now - stableSince >= settleMs) {
        remember(sig);
        lastFiredAt = now;
        pendingSig = '';
        stableSince = 0;
        return true;
      }
      return false;
    },
    reset() {
      notified.clear();
      pendingSig = '';
      stableSince = 0;
      lastFiredAt = -Infinity;
    },
  };
}

// attachCompletionDetection returns the `{ detectComplete, resetCompletion }`
// pair an adapter spreads into itself to gain the shared turn-completion timing.
// Each adapter that opts in gets its OWN detector instance (independent dedup
// set). `now` defaults to Date.now() so production callers can omit it while
// tests inject a fake clock. Centralizes the timing wiring so the adapter files
// stay one-liners and the settle/signature logic lives in exactly one place.
export function attachCompletionDetection(opts: CompletionDetectorOptions = {}): {
  detectComplete: (obs: CompletionObservation, now?: number) => boolean;
  resetCompletion: () => void;
} {
  const detector = createCompletionDetector(opts);
  return {
    detectComplete: (obs, now = Date.now()) => detector.observe(obs, now),
    resetCompletion: () => detector.reset(),
  };
}
