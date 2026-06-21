// Circuit breaker (item #5) — keep the web AI from death-spiralling on a permanently
// broken element/page. Three independent scopes, each CLOSED → OPEN → HALF_OPEN with a
// cooldown that auto-resets (never a permanent block):
//   - element  key = `${tabId}:${queryHash}`; 3 consecutive fails → OPEN (skip the
//              waterfall, return "unavailable"); cooldown 2min.
//   - page     5 DISTINCT failed elements in a tab → OPEN (suggest a reload); cooldown 1min.
//   - global   10 fails within a 5min sliding window (any tab) → OPEN (pause); cooldown 5min.
// Reference: openchrome utils/ralph/circuit-breaker.ts (docs/2026-06-17-oss-reference-borrow.md
// appendix C). Date.now() is fine here — this is extension runtime code, not a workflow script.
//
// A "failure" is decided by the caller (controller): a SILENT_CLICK / WRONG_ELEMENT
// outcome or a thrown interaction error. A SUCCESS calls recordSuccess to close the
// element circuit. Wired into the click/type paths so a dead element fails fast.

export type Scope = 'element' | 'page' | 'global'

export interface Decision { allowed: boolean; scope?: Scope; reason?: string }

const ELEMENT_FAIL_LIMIT = 3
const PAGE_FAIL_LIMIT = 5
const GLOBAL_FAIL_LIMIT = 10
const ELEMENT_COOLDOWN_MS = 2 * 60_000
const PAGE_COOLDOWN_MS = 1 * 60_000
const GLOBAL_COOLDOWN_MS = 5 * 60_000
const GLOBAL_WINDOW_MS = 5 * 60_000

/** Stable element key: tabId + a cheap hash of the query string (ref/selector/mark). */
export function elementKey(tabId: number, query: string): string {
  let h = 5381
  for (let i = 0; i < query.length; i++) h = ((h << 5) + h + query.charCodeAt(i)) | 0
  return `${tabId}:${(h >>> 0).toString(36)}`
}

interface ElementState { fails: number; openedAt: number }
interface PageState { failed: Set<string>; openedAt: number }

export class CircuitBreaker {
  private elements = new Map<string, ElementState>()
  private pages = new Map<number, PageState>()
  private globalFails: number[] = []   // failure timestamps (sliding 5min window)
  private globalOpenedAt = 0

  /** Should the caller attempt (or escalate) an interaction on this element? */
  allow(tabId: number, key: string): Decision {
    const t = Date.now()
    // global first (broadest): a tripped global pauses everything.
    this.pruneGlobal(t)
    if (this.globalOpen()) {
      if (t - this.globalOpenedAt > GLOBAL_COOLDOWN_MS) { this.resetGlobal() }   // HALF_OPEN trial
      else return { allowed: false, scope: 'global', reason: 'too many browser failures recently — automation paused (cooldown 5min); reassess the task before retrying' }
    }
    // page next.
    const pg = this.pages.get(tabId)
    if (pg && pg.failed.size >= PAGE_FAIL_LIMIT) {
      if (t - pg.openedAt > PAGE_COOLDOWN_MS) { pg.failed.clear(); pg.openedAt = 0 }   // HALF_OPEN
      else return { allowed: false, scope: 'page', reason: `${pg.failed.size} different elements failed on this tab — reload the page (browser_reload) or take a fresh browser_snapshot` }
    }
    // element last (narrowest).
    const el = this.elements.get(key)
    if (el && el.fails >= ELEMENT_FAIL_LIMIT) {
      if (t - el.openedAt > ELEMENT_COOLDOWN_MS) { el.fails = 0; el.openedAt = 0 }   // HALF_OPEN
      else return { allowed: false, scope: 'element', reason: 'this element is unavailable (repeated interactions had no effect); try a different element or a fresh snapshot' }
    }
    return { allowed: true }
  }

  /** Record a failed interaction across all three scopes. */
  recordFailure(tabId: number, key: string): void {
    const t = Date.now()
    // element
    const el = this.elements.get(key) ?? { fails: 0, openedAt: 0 }
    el.fails++
    if (el.fails >= ELEMENT_FAIL_LIMIT && el.openedAt === 0) el.openedAt = t
    this.elements.set(key, el)
    // page (distinct element set per tab); reset the set if its cooldown already elapsed.
    const pg = this.pages.get(tabId) ?? { failed: new Set<string>(), openedAt: 0 }
    if (pg.failed.size >= PAGE_FAIL_LIMIT && pg.openedAt !== 0 && t - pg.openedAt > PAGE_COOLDOWN_MS) {
      pg.failed.clear(); pg.openedAt = 0
    }
    pg.failed.add(key)
    if (pg.failed.size >= PAGE_FAIL_LIMIT && pg.openedAt === 0) pg.openedAt = t
    this.pages.set(tabId, pg)
    // global sliding window
    this.pruneGlobal(t)
    this.globalFails.push(t)
    if (this.globalFails.length >= GLOBAL_FAIL_LIMIT && this.globalOpenedAt === 0) this.globalOpenedAt = t
  }

  /** Record a successful interaction → close the element circuit (and drop it from the
   *  page's failed-element set so the page can recover too). */
  recordSuccess(tabId: number, key: string): void {
    this.elements.delete(key)
    const pg = this.pages.get(tabId)
    if (pg) pg.failed.delete(key)
  }

  private pruneGlobal(t: number): void {
    const cutoff = t - GLOBAL_WINDOW_MS
    while (this.globalFails.length && this.globalFails[0] < cutoff) this.globalFails.shift()
  }
  private globalOpen(): boolean {
    // Open if within-window count hit the limit, OR we are inside a trip's cooldown.
    if (this.globalOpenedAt !== 0) return true
    return this.globalFails.length >= GLOBAL_FAIL_LIMIT
  }
  private resetGlobal(): void { this.globalFails = []; this.globalOpenedAt = 0 }
}
