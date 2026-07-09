// Security + approval gates that run before a mutating browser tool executes.
// Separated from dispatch.ts (which stays a pure router) and controller.ts (which
// stays free of an approval/dispatch import). Ports controller.go gate logic:
//   - sensitive page → HARD refuse (not a prompt)
//   - action approval → approval.ask with an action class (evaluate/cookie/clipboard/
//     upload/dialog/interact), session-grantable per host+class.
// The AI-page gate (refuse driving a user's AI tab) lives in controller.ensureTab.
import type { ApprovalManager } from './approval'
import type { SecurityPolicy } from './security'
import type { BrowserTab } from './types'

/** Map a tool NAME to its approval action class (port controller.go actionClassFor,
 *  keyed by tool name instead of the human action label). */
export function actionClassFor(name: string): string {
  switch (name) {
    case 'browser_evaluate': return 'evaluate'
    case 'browser_set_cookie':
    case 'browser_cookies': return 'cookie'
    case 'browser_clipboard': return 'clipboard'
    case 'browser_upload':
    case 'browser_attachment_upload': return 'upload'
    case 'browser_handle_dialog': return 'dialog'
    default: return 'interact'
  }
}

// Tools that require Gate-B action approval (mirror the Go c.ask call sites).
// Cross-origin navigate approval is decided inside the navigate method (origin
// compare), so browser_navigate is NOT blanket-listed here.
// Source of truth = the Go controller methods that call c.ask unconditionally.
// browser_navigate / browser_go_back / browser_go_forward ask ONLY on cross-origin
// (decided inside the method), so they are NOT blanket-listed here.
export const APPROVAL_TOOLS = new Set([
  'browser_click', 'browser_type', 'browser_hover', 'browser_select', 'browser_press_key',
  'browser_drag', 'browser_form_input', 'browser_evaluate', 'browser_clipboard', 'browser_upload',
  'browser_handle_dialog', 'browser_cookies', 'browser_set_cookie', 'browser_use_tab',
  'browser_finalize_tabs', 'browser_zoom',
])

// Tools that ESTABLISH/manage tab control and must SKIP the AI-page gate during the
// dispatcher's tab pre-resolution. Gating them deadlocks (use_tab/new_tab ARE the
// approval path; the gate's remedy is "use browser_use_tab") or is a false block
// (finalize_tabs closes tabs by an explicit id list and ignores the resolved tab).
// They still get their normal approval prompt via APPROVAL_TOOLS. Centralized here so a
// newly-added tab-management tool can't silently re-introduce the gate deadlock.
export const GATE_BYPASS_AI_PAGE_TOOLS = new Set([
  'browser_use_tab', 'browser_new_tab', 'browser_finalize_tabs',
])

export interface GateCtx {
  name: string
  tab: BrowserTab
  callId: string
  approval: ApprovalManager
  security: SecurityPolicy
  args?: Record<string, unknown>  // tool args, so a cookie write can key its grant on the COOKIE'S target domain, not the controlled tab
  originTabId?: number   // AI-page tab to show the approval card on (targeted, not broadcast)
  skipApproval?: boolean // caller gates approval itself (browser-agent route); keep sensitivity refuse
}

/** Host the approval grant is keyed on. Normally the controlled tab's host, BUT a
 *  cookie write targets an ARBITRARY domain (args.domain/args.url) independent of
 *  the controlled tab — so a session grant ("always allow") must be keyed to the
 *  cookie's target, or a grant earned on tab A silently authorizes cookie writes
 *  onto a different domain B (within host_permissions) the user never approved.
 *  Falls back to the tab host when no explicit cookie target is given. */
function grantHostFor(ctx: GateCtx): string {
  const tabHost = (() => { try { return new URL(ctx.tab.url).hostname } catch { return '' } })()
  if (ctx.name === 'browser_set_cookie' || ctx.name === 'browser_cookies') {
    const a = ctx.args || {}
    const domain = typeof a.domain === 'string' ? a.domain.trim() : ''
    if (domain) return domain.replace(/^\./, '')   // leading-dot cookie domains → bare host
    const url = typeof a.url === 'string' ? a.url.trim() : ''
    if (url) { try { return new URL(url).hostname } catch { /* fall through */ } }
  }
  return tabHost
}

/** Run the security + approval gates. Throws to abort the tool (refusal/rejection). */
export async function runGates(ctx: GateCtx): Promise<void> {
  // Sensitive payment/financial page → hard refuse (never just a prompt).
  if (ctx.security.isSensitive(ctx.tab)) {
    throw new Error(`${ctx.name} refused on sensitive payment/financial page`)
  }
  // Action approval for the tools that require it.
  if (!ctx.skipApproval && APPROVAL_TOOLS.has(ctx.name)) {
    const host = grantHostFor(ctx)
    // An empty host means ApprovalManager.hasGrant/recordGrant silently no-op
    // (both guard on `!!host`) — the user could pick "本站点始终允许" and the
    // grant would never persist, re-prompting on every subsequent call with no
    // indication why. Fail loudly instead of asking for an approval that can't
    // be remembered.
    if (!host) {
      throw new Error(`${ctx.name} refused: cannot determine target host for approval`)
    }
    await ctx.approval.ask({ host, actionClass: actionClassFor(ctx.name), action: ctx.name, callId: ctx.callId, originTabId: ctx.originTabId })
  }
}
