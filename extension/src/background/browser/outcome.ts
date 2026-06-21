// Interaction-outcome classifier (item #1, "Outcome Contract").
//
// After a click/type/select, judge whether the action actually took effect by
// comparing a before/after page signature: DOM-size delta, aria-state change
// (aria-checked|selected|expanded|pressed), focus movement, URL change, or a new
// dialog/modal/menu. Returns a structured enum so the web AI can self-correct.
//
// Reference: openchrome utils/ralph/outcome-classifier.ts (SUCCESS_PATTERNS /
// TOOLTIP_PATTERNS, see docs/2026-06-17-oss-reference-borrow.md appendix C). The
// classifier is OBSERVATION-ONLY: it never blocks existing behavior, it only
// annotates the tool's returned output text. Skyvern's WebVoyager result (68.7% →
// 85.85%) showed outcome validation alone is the single highest-ROI reliability win.

export type Outcome = 'SUCCESS' | 'SILENT_CLICK' | 'WRONG_ELEMENT' | 'UNKNOWN'

export interface OutcomeResult { outcome: Outcome; reason: string }

// Compact page signature captured before + after an interaction. Kept small (no raw
// HTML) so the in-page eval is cheap and the JSON crossing CDP stays tiny.
export interface PageSig {
  url: string
  activeTag: string        // document.activeElement.tagName
  activeText: string       // focused field value / textContent (trimmed, capped)
  dialogCount: number      // open <dialog>/[role=dialog]/[role=alertdialog]/[aria-modal]
  openMenuCount: number    // [role=menu]/[role=listbox]/[aria-expanded=true] visible
  domSize: number          // document.getElementsByTagName('*').length
  ariaState: string        // aria-checked|selected|expanded|pressed of the target (or focused)
  targetVisible: boolean   // element at the click point still present/visible
  newOverlayText: string   // role/class signature of any overlay that appeared (for tooltip check)
}

// Affordances that signal a *hover* tooltip/popover rather than a real click target —
// if the ONLY thing that changed is one of these, the click likely hit the wrong
// element (port TOOLTIP_PATTERNS).
const TOOLTIP_PATTERNS = /\b(tooltip|popover|cdk-overlay|mat-tooltip|role=tooltip|aria-describedby)\b/i

// Affordances that signal a real state change in the new-overlay string (port a slice
// of SUCCESS_PATTERNS that applies to appearing overlays — dialog/menu/drawer).
const OVERLAY_SUCCESS_PATTERNS = /\b(dialog|modal|drawer|menu|listbox|combobox|sheet|popup)\b/i

// A DOM-size swing this large counts as a meaningful mutation (new nodes rendered).
const DOM_DELTA_THRESHOLD = 8

/** Classify before→after into an outcome enum. Pure (testable); no CDP. */
export function classifyOutcome(before: PageSig | null, after: PageSig | null, action: 'click' | 'type' | 'select'): OutcomeResult {
  if (!before || !after) return { outcome: 'UNKNOWN', reason: 'no signature captured' }

  // 1. Navigation is the strongest signal.
  if (after.url !== before.url) return { outcome: 'SUCCESS', reason: `url changed ${before.url} → ${after.url}` }

  // 2. A new dialog/modal opened.
  if (after.dialogCount > before.dialogCount) return { outcome: 'SUCCESS', reason: 'a dialog/modal opened' }

  // 3. A new menu/listbox/expanded surface opened.
  if (after.openMenuCount > before.openMenuCount) return { outcome: 'SUCCESS', reason: 'a menu/listbox opened' }

  // 4. aria-state of the target flipped (checked/selected/expanded/pressed).
  if (after.ariaState && after.ariaState !== before.ariaState) {
    return { outcome: 'SUCCESS', reason: `aria-state changed (${before.ariaState || 'none'} → ${after.ariaState})` }
  }

  // For type/select, the success signal is the focused field's value changing.
  if (action === 'type' || action === 'select') {
    if (after.activeText !== before.activeText) return { outcome: 'SUCCESS', reason: 'focused field value changed' }
    // Couldn't observe a value delta but we are focused in a field — inconclusive, not a hard fail.
    if (after.activeTag === 'INPUT' || after.activeTag === 'TEXTAREA' || after.activeText !== '') {
      return { outcome: 'UNKNOWN', reason: 'value change not observable (controlled component?)' }
    }
  }

  // 5. Focus moved INTO a new element (click landed on a focusable control).
  if (after.activeTag !== before.activeTag && after.activeTag !== 'BODY' && after.activeTag !== '') {
    return { outcome: 'SUCCESS', reason: `focus moved to <${after.activeTag.toLowerCase()}>` }
  }

  // 6. Meaningful DOM-size delta (content rendered/removed in response).
  if (Math.abs(after.domSize - before.domSize) >= DOM_DELTA_THRESHOLD) {
    return { outcome: 'SUCCESS', reason: `dom changed by ${after.domSize - before.domSize} nodes` }
  }

  // 7. Only a tooltip/popover appeared (hover affordance) and it's NOT a real surface →
  //    we likely clicked the wrong element.
  if (after.newOverlayText && TOOLTIP_PATTERNS.test(after.newOverlayText) && !OVERLAY_SUCCESS_PATTERNS.test(after.newOverlayText)) {
    return { outcome: 'WRONG_ELEMENT', reason: 'only a tooltip/popover appeared (likely wrong element)' }
  }

  // 8. The point we clicked is no longer there/visible — something re-rendered.
  if (before.targetVisible && !after.targetVisible) {
    return { outcome: 'SUCCESS', reason: 'target re-rendered after the action' }
  }

  // Nothing observable changed.
  return { outcome: 'SILENT_CLICK', reason: 'no observable change (DOM/aria/focus/url/dialog all unchanged)' }
}

const GLYPH: Record<Outcome, string> = { SUCCESS: '✓', SILENT_CLICK: '⚠', WRONG_ELEMENT: '✗', UNKNOWN: '?' }

/** Render a compact one-line annotation appended to the tool's output text. */
export function formatOutcome(r: OutcomeResult): string {
  const tail = r.reason ? ` (${r.reason})` : ''
  return `\n[${GLYPH[r.outcome]} outcome=${r.outcome}]${tail}`
}

/** In-page expression that captures a PageSig. Optionally scopes aria-state +
 *  targetVisible to a viewport point (the click/type coordinate). Returns the
 *  JSON-string of a PageSig via Runtime.evaluate. */
export function outcomeSnapshotExpr(point?: { x: number; y: number }): string {
  const px = point ? Math.round(point.x) : -1
  const py = point ? Math.round(point.y) : -1
  return `(function(){
  function vis(el){ if(!el||!el.getBoundingClientRect) return false; var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) return false; var s=getComputedStyle(el); return s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')!==0; }
  function ariaOf(el){ if(!el||!el.getAttribute) return ''; var out=[]; var keys=['aria-checked','aria-selected','aria-expanded','aria-pressed']; for(var i=0;i<keys.length;i++){ var v=el.getAttribute(keys[i]); if(v!=null) out.push(keys[i].slice(5)+'='+v); } return out.join(','); }
  var ae=document.activeElement;
  var px=${px}, py=${py};
  var pointEl=(px>=0&&py>=0)?document.elementFromPoint(px,py):null;
  // aria-state: prefer the element at the click point, else the focused element.
  var ariaSrc=pointEl||ae;
  var dialogs=document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]');
  var dlgCount=0; for(var i=0;i<dialogs.length;i++){ if(vis(dialogs[i])) dlgCount++; }
  var menus=document.querySelectorAll('[role=menu],[role=listbox],[aria-expanded=true]');
  var menuCount=0; for(var j=0;j<menus.length;j++){ if(vis(menus[j])) menuCount++; }
  // overlay signature: highest-z fixed/absolute element near the top, for tooltip detection.
  var ov='';
  var overlays=document.querySelectorAll('[role=tooltip],.tooltip,.popover,[class*=cdk-overlay],[class*=mat-tooltip],[aria-describedby]');
  for(var k=0;k<overlays.length;k++){ if(vis(overlays[k])){ ov=(overlays[k].getAttribute('role')?('role='+overlays[k].getAttribute('role')+' '):'')+(overlays[k].className||''); break; } }
  var sig={
    url: location.href,
    activeTag: ae?ae.tagName:'',
    activeText: ae?((ae.value!=null?ae.value:(ae.textContent||'')).trim().slice(0,200)):'',
    dialogCount: dlgCount,
    openMenuCount: menuCount,
    domSize: document.getElementsByTagName('*').length,
    ariaState: ariaOf(ariaSrc),
    targetVisible: pointEl?vis(pointEl):true,
    newOverlayText: ov.slice(0,200)
  };
  return JSON.stringify(sig);
})()`
}

/** Parse the JSON-string PageSig from runtimeEvaluate; null-tolerant. */
export function parsePageSig(raw: unknown): PageSig | null {
  if (raw == null) return null
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (o && typeof o === 'object') return o as PageSig
  } catch { /* malformed → treat as no signature */ }
  return null
}
