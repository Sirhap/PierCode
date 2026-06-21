// Hint Engine (item #4) — deterministic, non-LLM rule chain that appends a corrective
// hint to a browser tool's result when it matches a known failure/condition pattern.
// Cheaper than asking the model to self-diagnose, and the highest-ROI add for the
// free web-AI route (saves a whole reasoning round-trip + subscription quota).
//
// Reference: openchrome src/hints/hint-engine.ts + hints/rules/*.ts (see
// docs/2026-06-17-oss-reference-borrow.md appendix C). Each rule is a pure
// match(ctx)→string|null; the engine runs them priority-desc and fires each rule's
// non-null hint AT MOST ONCE per session (one-shot, tracked via fireCounts) so the
// model isn't nagged with the same hint every turn.

export interface HintCtx {
  toolName: string
  resultText: string
  isError: boolean
  fireCounts: Map<string, number>   // rule name → times its hint has fired this session
}

export interface HintRule {
  name: string
  priority: number          // higher runs first
  maxSeverity?: string      // advisory tag (mirrors openchrome); unused by the engine itself
  match(ctx: HintCtx): string | null
}

// ── pattern fragments ─────────────────────────────────────────────────────────
const BLOCKING_RE = /\b(overlay|modal|cookie\s*(banner|consent)?|consent|intercepted|click\s+intercepted|obscur|pointer-events|backdrop|paywall|captcha)\b/i
const STALE_RE = /\b(ref\s+\S+\s+(is\s+)?(stale|unknown|not\s+found)|no\s+element|stale\s+(ref|snapshot|element)|not\s+found\s+in\s+this\s+snapshot|take\s+a\s+fresh)\b/i
const PAGINATION_RE = /\b(next\s+page|load\s+more|show\s+more|see\s+more|pagination|page\s+\d+\s+of\s+\d+|infinite\s+scroll)\b/i
const SILENT_RE = /outcome=SILENT_CLICK/
const WRONG_RE = /outcome=WRONG_ELEMENT/

// Count "[level] ..." console lines whose level is error/warning (browser_console output).
function countConsoleErrors(text: string): number {
  let n = 0
  const re = /^\[(error|warn|warning)\]/gim
  while (re.exec(text)) n++
  return n
}

// A rule fires its hint only if it hasn't already this session (one-shot). Helper keeps
// each rule's match() terse.
function once(ctx: HintCtx, name: string, hint: string): string | null {
  if ((ctx.fireCounts.get(name) ?? 0) > 0) return null
  return hint
}

// 7 high-frequency rules, priority-desc.
export const DEFAULT_RULES: HintRule[] = [
  {
    name: 'blocking-page', priority: 100, maxSeverity: 'high',
    match: (c) => (BLOCKING_RE.test(c.resultText)
      ? once(c, 'blocking-page', 'Hint: an overlay/modal/cookie banner may be intercepting the interaction — dismiss it (close button, Escape, or accept cookies) before retrying.')
      : null),
  },
  {
    name: 'error-recovery', priority: 95, maxSeverity: 'high',
    match: (c) => (c.isError
      ? once(c, 'error-recovery', 'Hint: this tool errored — take a fresh browser_snapshot to re-orient before the next action (the page state likely changed).')
      : null),
  },
  {
    name: 'snapshot-stale', priority: 90, maxSeverity: 'medium',
    match: (c) => (STALE_RE.test(c.resultText)
      ? once(c, 'snapshot-stale', 'Hint: the ref/element is stale — the DOM changed since the last snapshot. Take a fresh browser_snapshot and use the new ref.')
      : null),
  },
  {
    name: 'pagination-detection', priority: 80, maxSeverity: 'low',
    match: (c) => (PAGINATION_RE.test(c.resultText)
      ? once(c, 'pagination-detection', 'Hint: this page looks paginated — there may be a "next"/"load more" control; click it (or scroll) to reveal further content.')
      : null),
  },
  {
    name: 'repetition-detection', priority: 70, maxSeverity: 'medium',
    // Fires once the SAME tool has been seen many times — a likely loop. Uses fireCounts
    // as the running per-tool counter (the engine bumps `tool:<name>` every dispatch).
    match: (c) => {
      const calls = c.fireCounts.get(`tool:${c.toolName}`) ?? 0
      return calls >= 5
        ? once(c, 'repetition-detection', `Hint: ${c.toolName} has run ${calls}+ times — if you're not making progress, change strategy (different element, fresh snapshot, or step back and re-plan).`)
        : null
    },
  },
  {
    name: 'console-buffer-pressure', priority: 60, maxSeverity: 'low',
    match: (c) => (countConsoleErrors(c.resultText) >= 5
      ? once(c, 'console-buffer-pressure', 'Hint: the page logged several console errors — the app may be in a broken state; check browser_console output and consider browser_reload.')
      : null),
  },
  {
    name: 'success-hints', priority: 50, maxSeverity: 'low',
    // A silent/wrong-element click that DIDN'T already trip a higher rule: nudge toward
    // verification rather than blindly repeating.
    match: (c) => ((SILENT_RE.test(c.resultText) || WRONG_RE.test(c.resultText))
      ? once(c, 'success-hints', 'Hint: that interaction had no observable effect — verify the target with browser_snapshot/browser_find before retrying; you may be aiming at the wrong element.')
      : null),
  },
]

export class HintEngine {
  private rules: HintRule[]
  // Per-session one-shot ledger + per-tool call counter. Lives for the SW lifetime.
  readonly fireCounts = new Map<string, number>()

  constructor(rules: HintRule[] = DEFAULT_RULES) {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority)
  }

  /** Run the chain over ctx; return concatenated matched hint lines ('' if none).
   *  Each rule's hint fires at most once per session (one-shot), tracked in fireCounts. */
  apply(ctx: Omit<HintCtx, 'fireCounts'>): string {
    // Count this tool invocation for repetition-detection (bump BEFORE matching so the
    // count reflects the current call).
    const tkey = `tool:${ctx.toolName}`
    this.fireCounts.set(tkey, (this.fireCounts.get(tkey) ?? 0) + 1)

    const full: HintCtx = { ...ctx, fireCounts: this.fireCounts }
    const lines: string[] = []
    for (const rule of this.rules) {
      let hint: string | null = null
      try { hint = rule.match(full) } catch { hint = null }   // a rule must never throw
      if (hint) {
        lines.push(hint)
        this.fireCounts.set(rule.name, (this.fireCounts.get(rule.name) ?? 0) + 1)   // one-shot bookkeeping
      }
    }
    return lines.join('\n')
  }
}

// Process-wide singleton (one session = one SW lifetime).
export const hintEngine = new HintEngine()

/** Convenience: run the singleton over a result and return matched hint text ('' if none). */
export function applyHints(ctx: Omit<HintCtx, 'fireCounts'>): string {
  return hintEngine.apply(ctx)
}
