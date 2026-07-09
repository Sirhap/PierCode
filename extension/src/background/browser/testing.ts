// Testing primitives for the SW browser controller: browser_assert (declarative
// page-state checks), browser_wait_stable (DOM-quiet settle), and the report
// shaping for browser_test (scripted step runner). Pure helpers live here so
// controller.ts stays a thin method table and vitest can cover the comparison /
// report logic without CDP.

const q = (s: string) => JSON.stringify(s)

// ── browser_assert ──────────────────────────────────────────────────────────

export type AssertKind =
  | 'url' | 'title'
  | 'element_exists' | 'element_not_exists' | 'element_visible'
  | 'element_text' | 'element_count' | 'attribute'
  | 'console_clean' | 'network_ok'

export type AssertMatch = 'contains' | 'equals' | 'regex'

export interface AssertArgs {
  tabId?: number
  kind: AssertKind
  selector?: string
  attribute?: string
  expect?: string
  match?: AssertMatch
  count?: number
  op?: '=' | '>=' | '<='
  pattern?: string
}

const ELEMENT_KINDS = new Set<AssertKind>([
  'element_exists', 'element_not_exists', 'element_visible',
  'element_text', 'element_count', 'attribute',
])

export function isElementKind(kind: AssertKind): boolean { return ELEMENT_KINDS.has(kind) }

/** Validate assert args shape; returns an error string or null. */
export function validateAssertArgs(a: AssertArgs): string | null {
  const kinds: AssertKind[] = ['url', 'title', 'element_exists', 'element_not_exists', 'element_visible',
    'element_text', 'element_count', 'attribute', 'console_clean', 'network_ok']
  if (!a.kind || !kinds.includes(a.kind)) return `kind must be one of: ${kinds.join(', ')}`
  if (isElementKind(a.kind) && !(a.selector && a.selector.trim())) return `kind=${a.kind} requires a selector`
  if (a.kind === 'attribute' && !(a.attribute && a.attribute.trim())) return 'kind=attribute requires an attribute name'
  if ((a.kind === 'url' || a.kind === 'title' || a.kind === 'element_text' || a.kind === 'attribute') &&
    (a.expect == null || a.expect === '')) return `kind=${a.kind} requires expect`
  if (a.kind === 'element_count' && typeof a.count !== 'number') return 'kind=element_count requires a numeric count'
  if (a.match && !['contains', 'equals', 'regex'].includes(a.match)) return 'match must be contains, equals, or regex'
  if (a.op && !['=', '>=', '<='].includes(a.op)) return 'op must be =, >= or <='
  return null
}

/** In-page probe for element kinds — one evaluate returns everything the
 *  comparisons need. Never throws in-page; a missing element yields count=0. */
export function elementProbeExpr(selector: string, attribute?: string): string {
  return `(function(){
  var els = document.querySelectorAll(${q(selector)});
  var el = els.length ? els[0] : null;
  var vis = false, text = '', attr = null;
  if (el) {
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
    var cs = window.getComputedStyle ? getComputedStyle(el) : { display: '', visibility: '' };
    vis = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    text = (el.innerText || el.textContent || el.value || '').trim().slice(0, 2000);
    attr = ${attribute ? `el.getAttribute(${q(attribute)})` : 'null'};
  }
  return JSON.stringify({ count: els.length, visible: vis, text: text, attr: attr });
})()`
}

export interface ElementProbe { count: number; visible: boolean; text: string; attr: string | null }

export function parseElementProbe(raw: unknown): ElementProbe {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      count: Number((o as any)?.count) || 0,
      visible: (o as any)?.visible === true,
      text: String((o as any)?.text ?? ''),
      attr: (o as any)?.attr == null ? null : String((o as any).attr),
    }
  } catch {
    return { count: 0, visible: false, text: '', attr: null }
  }
}

/** String comparison for url/title/element_text/attribute. */
export function matchValue(actual: string, expect: string, match: AssertMatch = 'contains'): boolean {
  if (match === 'equals') return actual === expect
  if (match === 'regex') {
    try { return new RegExp(expect).test(actual) } catch { return false }
  }
  return actual.includes(expect)
}

export function compareCount(actual: number, expected: number, op: '=' | '>=' | '<=' = '='): boolean {
  if (op === '>=') return actual >= expected
  if (op === '<=') return actual <= expected
  return actual === expected
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s)

/** Build the PASS output / FAIL error message. FAIL carries expected vs actual. */
export function assertOutcome(desc: string, pass: boolean, expected: string, actual: string): { pass: boolean; text: string } {
  if (pass) return { pass: true, text: `ASSERT PASS: ${desc}` }
  return { pass: false, text: `ASSERT FAIL: ${desc} — expected ${clip(expected)}; actual ${clip(actual)}` }
}

// ── browser_wait_stable ─────────────────────────────────────────────────────

/** Page-side promise that resolves when the DOM has been mutation-quiet for
 *  quietMs (or timeoutMs elapses — resolves with a note, never rejects). */
export function waitStableExpr(quietMs: number, timeoutMs: number): string {
  const quiet = Math.min(Math.max(Math.trunc(quietMs) || 300, 50), 2000)
  const timeout = Math.min(Math.max(Math.trunc(timeoutMs) || 2000, quiet), 10000)
  return `(function(){
  var quiet = ${quiet}, timeout = ${timeout};
  return new Promise(function(resolve){
    var start = Date.now(), last = Date.now();
    var mo;
    try {
      mo = new MutationObserver(function(){ last = Date.now(); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) { resolve('stable (mutation observer unavailable)'); return; }
    var iv = setInterval(function(){
      var now = Date.now();
      if (now - last >= quiet) { clearInterval(iv); mo.disconnect(); resolve('stable after ' + (now - start) + 'ms (quiet ' + quiet + 'ms)'); }
      else if (now - start >= timeout) { clearInterval(iv); mo.disconnect(); resolve('still mutating after ' + timeout + 'ms (timeout; page may be animating)'); }
    }, 50);
  });
})()`
}

// ── browser_test report ─────────────────────────────────────────────────────

export interface TestStepSpec { name: string; input: Record<string, unknown> }

/** Tolerant step parse: accepts {name,input} (browser_batch shape) or {tool,args}. */
export function parseTestSteps(raw: unknown): TestStepSpec[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'steps must be a non-empty array of {name, input}'
  if (raw.length > 50) return 'a test may contain at most 50 steps'
  const steps: TestStepSpec[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    if (!s || typeof s !== 'object') return `step ${i + 1}: must be an object`
    const o = s as Record<string, unknown>
    const name = String(o.name ?? o.tool ?? '')
    const input = (o.input ?? o.args) as Record<string, unknown> | undefined
    if (!name.startsWith('browser_')) return `step ${i + 1}: ${name || '(missing name)'} is not a browser_* tool`
    if (name === 'browser_test') return `step ${i + 1}: browser_test cannot be nested`
    steps.push({ name, input: input && typeof input === 'object' ? input : {} })
  }
  return steps
}

export interface TestStepResult {
  index: number
  tool: string
  status: 'pass' | 'fail' | 'skipped'
  ms: number
  error?: string
}

export interface TestReport {
  name: string
  result: 'PASS' | 'FAIL'
  passed: number
  failed: number
  skipped: number
  durationMs: number
  steps: TestStepResult[]
  pageUrl?: string
  consoleTail?: string[]
}

/** Render the human-readable report + one machine-readable JSON line. The JSON
 *  stays on a single `JSON: {...}` line (no fenced block: a ``` inside a tool
 *  result nests into the page echo fence and truncates — see FENCE_RE audit). */
export function renderTestReport(r: TestReport): string {
  const lines: string[] = []
  lines.push(`TEST REPORT: ${r.name}`)
  lines.push(`result: ${r.result} (${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped of ${r.steps.length}) in ${r.durationMs}ms`)
  for (const s of r.steps) {
    if (s.status === 'skipped') { lines.push(`${s.index}. ○ ${s.tool} — skipped`); continue }
    const mark = s.status === 'pass' ? '✓' : '✗'
    lines.push(`${s.index}. ${mark} ${s.tool} (${s.ms}ms)${s.error ? ` — ${clip(s.error)}` : ''}`)
  }
  if (r.result === 'FAIL') {
    if (r.pageUrl) lines.push(`page: ${r.pageUrl}`)
    if (r.consoleTail && r.consoleTail.length) {
      lines.push('console tail:')
      for (const c of r.consoleTail) lines.push(`  ${clip(c, 200)}`)
    }
  }
  lines.push(`JSON: ${JSON.stringify(r)}`)
  return lines.join('\n')
}
