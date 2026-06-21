import { describe, it, expect } from 'vitest';
import {
  createCompletionDetector,
  attachCompletionDetection,
  completionSignature,
  COMPLETION_SETTLE_MS,
  COMPLETION_COOLDOWN_MS,
} from '../platform-adapters/completion';
import {
  qwenAdapter,
  chatGPTAdapter,
  mimoAdapter,
  aiStudioAdapter,
  chatZAdapter,
  claudeAdapter,
  geminiAdapter,
  defaultAdapter,
} from '../platform-adapters';

// ── #15 completion-detection state machine (settle + signature) ─────────────

describe('completionSignature', () => {
  it('combines messageIndex with a hash of the text', () => {
    const a = completionSignature(0, 'hello');
    const b = completionSignature(1, 'hello'); // same text, different turn
    const c = completionSignature(0, 'hello!'); // same turn, different text
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Deterministic for identical inputs.
    expect(completionSignature(0, 'hello')).toBe(a);
  });
});

describe('createCompletionDetector — settle window', () => {
  it('does not fire while the stop control is visible (still streaming)', () => {
    const d = createCompletionDetector();
    expect(d.observe({ stopVisible: true, messageIndex: 0, text: 'partial' }, 0)).toBe(false);
    expect(d.observe({ stopVisible: true, messageIndex: 0, text: 'partial more' }, 1000)).toBe(false);
  });

  it('fires only after the stop control is gone AND text is stable for the settle window', () => {
    const d = createCompletionDetector();
    // Stop gone, first idle observation — starts the settle window, not complete yet.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done text' }, 0)).toBe(false);
    // Same text, but before the settle window elapses.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done text' }, COMPLETION_SETTLE_MS - 1)).toBe(false);
    // Settle window elapsed with stable text → complete.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done text' }, COMPLETION_SETTLE_MS)).toBe(true);
  });

  it('restarts the settle window when the text changes mid-settle (jitter)', () => {
    const d = createCompletionDetector();
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'a' }, 0)).toBe(false);
    // Text changed at t=400 → window restarts from here.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'ab' }, 400)).toBe(false);
    // 600ms after the FIRST observation but only 200ms of stability → not yet.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'ab' }, 600)).toBe(false);
    // 600ms of stability since the change → complete.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'ab' }, 400 + COMPLETION_SETTLE_MS)).toBe(true);
  });

  it('restarts the settle window if the stop control reappears (regeneration)', () => {
    const d = createCompletionDetector();
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'x' }, 0)).toBe(false);
    // Stop reappears before settle → abort the in-flight settle.
    expect(d.observe({ stopVisible: true, messageIndex: 0, text: 'x re-streaming' }, 300)).toBe(false);
    // Stop gone again — settle starts fresh; the old 0..300 does not count.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'x final' }, 400)).toBe(false);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'x final' }, 400 + COMPLETION_SETTLE_MS - 1)).toBe(false);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'x final' }, 400 + COMPLETION_SETTLE_MS)).toBe(true);
  });
});

describe('createCompletionDetector — signature dedup + cooldown', () => {
  it('reports the same finished turn at most once', () => {
    const d = createCompletionDetector();
    d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, 0);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, COMPLETION_SETTLE_MS)).toBe(true);
    // Any later re-observation of the identical signature is suppressed forever.
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, 10_000)).toBe(false);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, 99_999)).toBe(false);
  });

  it('fires again for a genuinely new turn (different messageIndex)', () => {
    const d = createCompletionDetector();
    d.observe({ stopVisible: false, messageIndex: 0, text: 'first' }, 0);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'first' }, COMPLETION_SETTLE_MS)).toBe(true);
    // New turn well past the cooldown.
    const t = COMPLETION_SETTLE_MS + COMPLETION_COOLDOWN_MS + 1;
    d.observe({ stopVisible: false, messageIndex: 1, text: 'second' }, t);
    expect(d.observe({ stopVisible: false, messageIndex: 1, text: 'second' }, t + COMPLETION_SETTLE_MS)).toBe(true);
  });

  it('suppresses a different-signature fire while within the cooldown of the last fire', () => {
    const d = createCompletionDetector();
    d.observe({ stopVisible: false, messageIndex: 0, text: 'A' }, 0);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'A' }, COMPLETION_SETTLE_MS)).toBe(true);
    const firedAt = COMPLETION_SETTLE_MS;
    // A new turn appears immediately (within cooldown) — must NOT fire yet even
    // though its own settle window would otherwise be satisfied.
    d.observe({ stopVisible: false, messageIndex: 1, text: 'B' }, firedAt + 1);
    expect(d.observe({ stopVisible: false, messageIndex: 1, text: 'B' }, firedAt + COMPLETION_SETTLE_MS)).toBe(false);
    // Once the cooldown passes and the text is still stable → fire.
    expect(d.observe({ stopVisible: false, messageIndex: 1, text: 'B' }, firedAt + COMPLETION_COOLDOWN_MS + 1)).toBe(true);
  });

  it('reset() clears dedup so the same turn can fire again', () => {
    const d = createCompletionDetector();
    d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, 0);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, COMPLETION_SETTLE_MS)).toBe(true);
    d.reset();
    d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, 0);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'done' }, COMPLETION_SETTLE_MS)).toBe(true);
  });

  it('FIFO-evicts dedup keys past the limit so a long session re-fires the oldest', () => {
    const d = createCompletionDetector({ keyLimit: 2, cooldownMs: 0 });
    const fire = (idx: number, t: number) => {
      d.observe({ stopVisible: false, messageIndex: idx, text: `t${idx}` }, t);
      return d.observe({ stopVisible: false, messageIndex: idx, text: `t${idx}` }, t + COMPLETION_SETTLE_MS);
    };
    expect(fire(0, 0)).toBe(true);       // notified = {0}
    expect(fire(1, 1000)).toBe(true);    // notified = {0,1}
    expect(fire(2, 2000)).toBe(true);    // notified = {1,2} (0 evicted)
    // Turn 0's signature was evicted → it can fire again.
    expect(fire(0, 3000)).toBe(true);
  });
});

describe('createCompletionDetector — custom settle knob', () => {
  it('honors an overridden settleMs', () => {
    const d = createCompletionDetector({ settleMs: 100 });
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'q' }, 0)).toBe(false);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'q' }, 99)).toBe(false);
    expect(d.observe({ stopVisible: false, messageIndex: 0, text: 'q' }, 100)).toBe(true);
  });
});

// ── adapter wiring: only the misdetecting platforms opt in ──────────────────

describe('attachCompletionDetection wiring', () => {
  it('returns an independent detector per call', () => {
    const a = attachCompletionDetection();
    const b = attachCompletionDetection();
    // Fire turn on a.
    a.detectComplete({ stopVisible: false, messageIndex: 0, text: 'x' }, 0);
    expect(a.detectComplete({ stopVisible: false, messageIndex: 0, text: 'x' }, COMPLETION_SETTLE_MS)).toBe(true);
    // b is unaffected — its own settle window must still elapse independently.
    b.detectComplete({ stopVisible: false, messageIndex: 0, text: 'x' }, 0);
    expect(b.detectComplete({ stopVisible: false, messageIndex: 0, text: 'x' }, COMPLETION_SETTLE_MS)).toBe(true);
  });

  it('defaults the clock to Date.now() when omitted', () => {
    const a = attachCompletionDetection({ settleMs: 0 });
    // settleMs 0 ⇒ a single idle observation with a stable signature fires on the
    // SECOND call (first call sets the baseline) using the real clock.
    a.detectComplete({ stopVisible: false, messageIndex: 0, text: 'y' });
    expect(a.detectComplete({ stopVisible: false, messageIndex: 0, text: 'y' })).toBe(true);
  });

  it('the misdetecting adapters expose detectComplete + resetCompletion', () => {
    for (const adapter of [qwenAdapter, chatGPTAdapter, mimoAdapter, aiStudioAdapter, chatZAdapter]) {
      expect(adapter.detectComplete, `${adapter.name} detectComplete`).toBeTypeOf('function');
      expect(adapter.resetCompletion, `${adapter.name} resetCompletion`).toBeTypeOf('function');
    }
  });

  it('adapters with reliable CSS stop selectors do not opt in', () => {
    // Claude / Gemini / default have a clean stopBtn CSS selector, so they keep
    // the existing content-side detection and do not carry the optional method.
    for (const adapter of [claudeAdapter, geminiAdapter, defaultAdapter]) {
      expect(adapter.detectComplete, `${adapter.name} should not define detectComplete`).toBeUndefined();
    }
  });

  it('each wired adapter has its own dedup state (no cross-talk)', () => {
    qwenAdapter.resetCompletion!();
    chatGPTAdapter.resetCompletion!();
    qwenAdapter.detectComplete!({ stopVisible: false, messageIndex: 0, text: 'shared text' }, 0);
    expect(qwenAdapter.detectComplete!({ stopVisible: false, messageIndex: 0, text: 'shared text' }, COMPLETION_SETTLE_MS)).toBe(true);
    // ChatGPT seeing the identical signature must still run its own settle window
    // — it is NOT pre-suppressed by qwen having already fired.
    chatGPTAdapter.detectComplete!({ stopVisible: false, messageIndex: 0, text: 'shared text' }, 0);
    expect(chatGPTAdapter.detectComplete!({ stopVisible: false, messageIndex: 0, text: 'shared text' }, COMPLETION_SETTLE_MS)).toBe(true);
  });
});

// ── per-container detectors: the regression that broke #15 ──────────────────
// content/index.ts mints ONE createCompletionDetector() PER response container
// rather than reusing the adapter's single page-wide detectComplete. This test
// pins WHY: a single shared detector tracks ONE pendingSig/stableSince, so two
// concurrently-streaming containers (distinct text) trample each other's settle
// window — under a shared instance no turn ever settles until the caller's 15s
// deadlock guard fires. Independent per-container instances settle correctly.
describe('#15 per-container isolation (multi-container streaming)', () => {
  it('a SINGLE shared detector cannot settle two interleaved turns (the bug)', () => {
    const shared = createCompletionDetector();
    // Both containers idle (stop gone) but with different text → different sigs.
    // They are observed alternately every 200ms, the way scheduleFinalSubmit ticks
    // every active container per reschedule.
    let firedA = false, firedB = false;
    for (let t = 0; t <= 2000; t += 200) {
      // Container A observation, then container B — each overwrites pendingSig.
      firedA = shared.observe({ stopVisible: false, messageIndex: 0, text: 'answer A' }, t) || firedA;
      firedB = shared.observe({ stopVisible: false, messageIndex: 1, text: 'answer B' }, t) || firedB;
    }
    // Neither ever settles: every A obs resets B's window and vice-versa.
    expect(firedA).toBe(false);
    expect(firedB).toBe(false);
  });

  it('per-container detectors each settle independently (the fix)', () => {
    const detA = createCompletionDetector();
    const detB = createCompletionDetector();
    let firedA = false, firedB = false;
    for (let t = 0; t <= 2000; t += 200) {
      firedA = detA.observe({ stopVisible: false, messageIndex: 0, text: 'answer A' }, t) || firedA;
      firedB = detB.observe({ stopVisible: false, messageIndex: 1, text: 'answer B' }, t) || firedB;
    }
    // Each detector sees only its own stable signature → both settle.
    expect(firedA).toBe(true);
    expect(firedB).toBe(true);
  });

  it('reset() on a per-container detector lets a follow-up turn re-confirm identical text', () => {
    // Mirrors releaseCompletion(): after a cycle submits, the detector is reset so a
    // follow-up turn rendered into the SAME container with byte-identical text is not
    // suppressed by the prior cycle's signature lingering in `notified`.
    const det = createCompletionDetector();
    det.observe({ stopVisible: false, messageIndex: 0, text: 'same' }, 0);
    expect(det.observe({ stopVisible: false, messageIndex: 0, text: 'same' }, COMPLETION_SETTLE_MS)).toBe(true);
    // Without reset, the identical signature is suppressed forever.
    expect(det.observe({ stopVisible: false, messageIndex: 0, text: 'same' }, 5000)).toBe(false);
    det.reset();
    det.observe({ stopVisible: false, messageIndex: 0, text: 'same' }, 6000);
    expect(det.observe({ stopVisible: false, messageIndex: 0, text: 'same' }, 6000 + COMPLETION_SETTLE_MS)).toBe(true);
  });
});
