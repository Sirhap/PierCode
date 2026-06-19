// Port of internal/browser/events.go ring buffers + waiters.
// Console ring capped 1000/tab, network ring capped 500/tab. Dialog/nav waiters
// become Promises resolved by handle*Event.
export interface ConsoleMessage { level: string; text: string }
export interface NetworkRequest { requestId: string; url: string; method: string; status?: number }

const CONSOLE_CAP = 1000
const NETWORK_CAP = 500

export class EventBus {
  private console = new Map<number, ConsoleMessage[]>()
  private network = new Map<number, NetworkRequest[]>()
  private enabledDomains = new Map<number, Set<string>>()
  private navWaiters = new Map<number, Array<(r: any) => void>>()
  private dialogWaiters = new Map<number, Array<(r: any) => void>>()

  recordConsole(tabId: number, m: ConsoleMessage): void {
    const arr = this.console.get(tabId) ?? []
    arr.push(m); if (arr.length > CONSOLE_CAP) arr.shift()
    this.console.set(tabId, arr)
  }
  readConsole(tabId: number): ConsoleMessage[] { return this.console.get(tabId) ?? [] }

  recordNetwork(tabId: number, r: NetworkRequest): void {
    const arr = this.network.get(tabId) ?? []
    arr.push(r); if (arr.length > NETWORK_CAP) arr.shift()
    this.network.set(tabId, arr)
  }
  readNetwork(tabId: number): NetworkRequest[] { return this.network.get(tabId) ?? [] }

  domainEnabled(tabId: number, domain: string): boolean { return this.enabledDomains.get(tabId)?.has(domain) ?? false }
  markDomainEnabled(tabId: number, domain: string): void {
    const s = this.enabledDomains.get(tabId) ?? new Set<string>(); s.add(domain); this.enabledDomains.set(tabId, s)
  }

  clearTab(tabId: number): void {
    this.console.delete(tabId); this.network.delete(tabId)
    this.enabledDomains.delete(tabId); this.navWaiters.delete(tabId); this.dialogWaiters.delete(tabId)
  }

  // --- navigation waiters (port WaitForNavigation event-driven path) ---
  waitForNav(tabId: number, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const arr = this.navWaiters.get(tabId) ?? []
      const t = setTimeout(() => reject(new Error('navigation wait timed out')), timeoutMs)
      arr.push((r: any) => { clearTimeout(t); resolve(r) })
      this.navWaiters.set(tabId, arr)
    })
  }
  handleNavEvent(tabId: number, r: any): void {
    const arr = this.navWaiters.get(tabId); if (!arr || !arr.length) return
    this.navWaiters.set(tabId, [])
    for (const w of arr) w(r)
  }

  // --- dialog waiters (port HandleDialog) ---
  waitForDialog(tabId: number, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const arr = this.dialogWaiters.get(tabId) ?? []
      const t = setTimeout(() => reject(new Error('dialog wait timed out')), timeoutMs)
      arr.push((r: any) => { clearTimeout(t); resolve(r) })
      this.dialogWaiters.set(tabId, arr)
    })
  }
  handleDialogEvent(tabId: number, r: any): void {
    const arr = this.dialogWaiters.get(tabId); if (!arr || !arr.length) return
    this.dialogWaiters.set(tabId, [])
    for (const w of arr) w(r)
  }
}
