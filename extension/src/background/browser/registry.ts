// Port of internal/browser/registry.go. THE invariant: any mutating action calls
// markStale(), which marks all cached snapshots' refs stale; resolveRef() on a
// stale snapshot fails. Snapshots capped at 3 per tab (newest kept).
import type { BrowserTab, RefTarget, Point, Bounds } from './types'

interface SnapshotCache { id: string; refs: Record<string, RefTarget>; stale: boolean; createdAt: number }
const MAX_SNAPSHOTS = 3

export interface MarkedElement { mark: number; role: string; name: string; bounds: Bounds }

export class TabRegistry {
  private defaultId: number | null = null
  private tabs = new Map<number, BrowserTab>()
  private snapshots = new Map<number, SnapshotCache[]>()
  private approved = new Set<number>()
  private tracking = new Map<number, string>()       // 'created' | 'claimed'
  private lastPointer = new Map<number, Point>()
  private marksByTab = new Map<number, MarkedElement[]>()
  private pendingSwitch: { from: number; to: number } | null = null

  // --- snapshots / refs (invariant-critical) ---
  storeSnapshot(tabId: number, id: string, refs: Record<string, RefTarget>): void {
    const list = this.snapshots.get(tabId) ?? []
    list.push({ id, refs, stale: false, createdAt: Date.now() })
    while (list.length > MAX_SNAPSHOTS) list.shift()
    this.snapshots.set(tabId, list)
  }
  resolveRef(tabId: number, ref: string): RefTarget | null {
    const list = this.snapshots.get(tabId)
    if (!list) return null
    // newest-first; stale snapshots are skipped
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].stale) continue
      const t = list[i].refs[ref]
      if (t) return t
    }
    return null
  }
  markStale(tabId: number): void {
    const list = this.snapshots.get(tabId)
    if (list) for (const s of list) s.stale = true
  }

  // --- default tab ---
  setDefault(tab: BrowserTab): void {
    if (this.defaultId !== null && this.defaultId !== tab.tabId) {
      this.pendingSwitch = { from: this.defaultId, to: tab.tabId }
    }
    this.tabs.set(tab.tabId, { ...tab, controlled: true })
    this.defaultId = tab.tabId
  }
  default(): number | null { return this.defaultId }
  clearDefault(tabId: number): void {
    if (this.defaultId === tabId) this.defaultId = null
    this.tabs.delete(tabId)
    this.snapshots.delete(tabId)
    this.approved.delete(tabId)
    this.tracking.delete(tabId)
    this.lastPointer.delete(tabId)
    this.marksByTab.delete(tabId)
  }
  getTab(tabId: number): BrowserTab | undefined { return this.tabs.get(tabId) }
  upsertTab(tab: BrowserTab): void { this.tabs.set(tab.tabId, { ...this.tabs.get(tab.tabId), ...tab }) }

  // --- approval (AI-page gate) ---
  markApproved(tabId: number): void { this.approved.add(tabId) }
  isApproved(tabId: number): boolean { return this.approved.has(tabId) }

  // --- tracking (finalize policy) ---
  markCreated(tabId: number): void { this.tracking.set(tabId, 'created') }
  markClaimed(tabId: number): void { this.tracking.set(tabId, 'claimed') }
  tracked(tabId: number): string | undefined { return this.tracking.get(tabId) }

  // --- pointer / marks ---
  setLastPointer(tabId: number, p: Point): void { this.lastPointer.set(tabId, p) }
  lastPointerOf(tabId: number): Point | null { return this.lastPointer.get(tabId) ?? null }
  setMarks(tabId: number, marks: MarkedElement[]): void { this.marksByTab.set(tabId, marks) }
  marks(tabId: number): MarkedElement[] | null { return this.marksByTab.get(tabId) ?? null }

  // --- pending controlled-tab switch (consumed once) ---
  consumePendingSwitch(): { from: number; to: number } | null {
    const s = this.pendingSwitch; this.pendingSwitch = null; return s
  }
}
