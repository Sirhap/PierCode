// Network interception for deterministic testing (browser_intercept): a per-tab
// rule store + matching, kept PURE (no CDP) so vitest covers the match logic.
// The controller owns Fetch.enable/disable and the CDP fulfill/fail/continue;
// the SW's chrome.debugger.onEvent routes Fetch.requestPaused to the controller.
//
// INVARIANT: once Fetch is enabled every matching request PAUSES and MUST be
// resolved (fulfill/fail/continue) or the page hangs. handlePaused therefore
// always resolves — a non-matching or errored request falls through to continue.

export interface InterceptFulfill {
  status?: number
  body?: string
  contentType?: string
  headers?: Record<string, string>
}

export interface InterceptRule {
  id: number
  urlPattern: string        // substring, or a *glob* when it contains '*'
  method?: string           // optional METHOD filter (upper-cased)
  fulfill?: InterceptFulfill // mock a response …
  fail?: string             // … or fail the request with this CDP errorReason
  times?: number            // apply at most N times, then fall through (undefined = unlimited)
  hits: number
}

// Valid CDP Network.ErrorReason values accepted for `fail`.
export const FAIL_REASONS = new Set([
  'Failed', 'Aborted', 'TimedOut', 'AccessDenied', 'ConnectionClosed',
  'ConnectionReset', 'ConnectionRefused', 'ConnectionAborted', 'ConnectionFailed',
  'NameNotResolved', 'InternetDisconnected', 'AddressUnreachable', 'BlockedByClient',
  'BlockedByResponse',
])

/** Compile a URL matcher: '*'-containing patterns become anchored-substring
 *  globs (each `*` = `.*`), otherwise plain substring containment. */
export function urlMatches(pattern: string, url: string): boolean {
  if (!pattern) return true
  if (pattern.includes('*')) {
    const re = new RegExp(pattern.split('*').map(escapeRe).join('.*'))
    return re.test(url)
  }
  return url.includes(pattern)
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export type PausedResolution =
  | { kind: 'fulfill'; rule: InterceptRule; fulfill: InterceptFulfill }
  | { kind: 'fail'; rule: InterceptRule; reason: string }
  | { kind: 'continue' }

/** Pick the first rule (in insertion order) matching url+method whose `times`
 *  budget isn't spent, and bump its hit counter. Pure — mutation is only the
 *  matched rule's `hits`, which the store owns. */
export function resolvePaused(rules: InterceptRule[], url: string, method: string): PausedResolution {
  const m = (method || 'GET').toUpperCase()
  for (const r of rules) {
    if (r.method && r.method !== m) continue
    if (!urlMatches(r.urlPattern, url)) continue
    if (typeof r.times === 'number' && r.hits >= r.times) continue
    r.hits++
    if (r.fail) return { kind: 'fail', rule: r, reason: r.fail }
    return { kind: 'fulfill', rule: r, fulfill: r.fulfill ?? {} }
  }
  return { kind: 'continue' }
}

export class InterceptStore {
  private byTab = new Map<number, { rules: InterceptRule[]; seq: number }>()

  has(tabId: number): boolean { return (this.byTab.get(tabId)?.rules.length ?? 0) > 0 }
  rules(tabId: number): InterceptRule[] { return this.byTab.get(tabId)?.rules ?? [] }

  add(tabId: number, rule: Omit<InterceptRule, 'id' | 'hits'>): InterceptRule {
    let e = this.byTab.get(tabId)
    if (!e) { e = { rules: [], seq: 0 }; this.byTab.set(tabId, e) }
    const full: InterceptRule = { ...rule, id: ++e.seq, hits: 0 }
    e.rules.push(full)
    return full
  }

  /** Returns the rules that were dropped (for the controller to decide on disable). */
  clearTab(tabId: number): void { this.byTab.delete(tabId) }

  /** Human-readable listing for browser_intercept action=list. */
  describe(tabId: number): string {
    const rules = this.rules(tabId)
    if (!rules.length) return '(no active intercepts)'
    return rules.map(r => {
      const what = r.fail ? `fail(${r.fail})` : `fulfill(${r.fulfill?.status ?? 200})`
      const meth = r.method ? `${r.method} ` : ''
      const budget = typeof r.times === 'number' ? ` [${r.hits}/${r.times}]` : ` [${r.hits} hits]`
      return `#${r.id} ${meth}${JSON.stringify(r.urlPattern)} → ${what}${budget}`
    }).join('\n')
  }
}
