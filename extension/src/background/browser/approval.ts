// Port of internal/browser/approval.go; transport = chrome.runtime.sendMessage to UI
// instead of a WS broadcast. pending Promise map + session grants (host+actionClass)
// + 5-min timeout + grant short-circuit.
export interface ApprovalAsk {
  host: string; actionClass: string; action: string; callId: string
  approvalId?: string; target?: string; risk?: string; options?: string[]
  // The AI-page tab the action originates from / is shown on. When set, the prompt is
  // sent to THAT tab only (chrome.tabs.sendMessage) instead of broadcast to every tab —
  // so the approval card doesn't duplicate across other open AI tabs.
  originTabId?: number
}
export interface ApprovalAnswer { approvalId: string; approved: boolean; reason?: string; scope?: string }

// originTabId, when provided, targets a single tab; otherwise the message broadcasts.
type SendFn = (msg: any, originTabId?: number) => void
const defaultSend: SendFn = (msg, originTabId) => {
  try {
    if (typeof originTabId === 'number') chrome.tabs.sendMessage(originTabId, msg).catch(() => { /* tab closed → fall back */ chrome.runtime.sendMessage(msg).catch(() => {}) })
    else chrome.runtime.sendMessage(msg)
  } catch { /* UI closed */ }
}
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export class ApprovalManager {
  private pending = new Map<string, (a: ApprovalAnswer) => void>()
  private grants = new Set<string>()
  private seq = 0
  constructor(private send: SendFn = defaultSend, private timeoutMs = APPROVAL_TIMEOUT_MS) {}

  private grantKey(host: string, actionClass: string) { return `${host}\x00${actionClass}` }
  hasGrant(host: string, actionClass: string): boolean {
    return !!host && !!actionClass && this.grants.has(this.grantKey(host, actionClass))
  }
  recordGrant(host: string, actionClass: string): void {
    if (host && actionClass) this.grants.add(this.grantKey(host, actionClass))
  }

  /** Resolves on approval, rejects (throws) on rejection/timeout. */
  ask(ask: ApprovalAsk): Promise<void> {
    if (this.hasGrant(ask.host, ask.actionClass)) return Promise.resolve()
    const approvalId = ask.approvalId || `browser_approval_${Date.now()}_${++this.seq}`
    const options = ask.options?.length ? ask.options : ['允许', '本站点始终允许', '拒绝']
    const origin = ask.originTabId
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId)
        this.send({ type: 'BROWSER_APPROVAL_DONE', approvalId, callId: ask.callId }, origin)
        reject(new Error('browser action approval timed out'))
      }, this.timeoutMs)
      this.pending.set(approvalId, (answer) => {
        clearTimeout(timer)
        this.pending.delete(approvalId)
        this.send({ type: 'BROWSER_APPROVAL_DONE', approvalId, callId: ask.callId }, origin)
        if (!answer.approved) { reject(new Error(answer.reason || 'user rejected browser action')); return }
        if (answer.scope === 'session' || answer.scope === 'always') this.recordGrant(ask.host, ask.actionClass)
        resolve()
      })
      this.send({
        type: 'BROWSER_APPROVAL_ASK', approvalId, callId: ask.callId,
        action: ask.action, target: ask.target, risk: ask.risk, options,
        host: ask.host, actionClass: ask.actionClass,
      }, origin)
    })
  }

  /** Called from the runtime onMessage handler when the UI answers. */
  deliver(answer: ApprovalAnswer): boolean {
    const fn = this.pending.get(answer.approvalId)
    if (!fn) return false
    fn(answer)
    return true
  }
}
