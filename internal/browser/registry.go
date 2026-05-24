package browser

import (
	"fmt"
	"sync"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

type RefTarget struct {
	Ref       string
	NodeID    string
	BackendID int
	Role      string
	Name      string
	Bounds    *Bounds
}

type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type snapshotCache struct {
	id        string
	refs      map[string]RefTarget
	stale     bool
	createdAt time.Time
}

type TabRegistry struct {
	mu        sync.RWMutex
	defaultID *int
	tabs      map[int]tool.BrowserTab
	snapshots map[int][]*snapshotCache
	// [Fixed by mimo-v2.5-pro: track AI page approval state from browser_use_tab]
	approved map[int]bool
}

func NewTabRegistry() *TabRegistry {
	return &TabRegistry{
		tabs:      make(map[int]tool.BrowserTab),
		snapshots: make(map[int][]*snapshotCache),
		approved:  make(map[int]bool),
	}
}

func (r *TabRegistry) SetDefault(tab tool.BrowserTab) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := tab.TabID
	tab.Controlled = true
	r.defaultID = &id
	r.tabs[id] = tab
}

func (r *TabRegistry) ClearDefault(tabID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.defaultID != nil && *r.defaultID == tabID {
		r.defaultID = nil
	}
	delete(r.tabs, tabID)
	delete(r.snapshots, tabID)
	delete(r.approved, tabID)
}

// MarkApproved records that a tab has been explicitly approved for AI automation
// via browser_use_tab. This allows subsequent browser_snapshot/browser_click/etc.
// to operate on AI conversation tabs without re-prompting.
// [Fixed by mimo-v2.5-pro: approval state propagation]
func (r *TabRegistry) MarkApproved(tabID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.approved[tabID] = true
}

// IsApproved checks whether a tab was explicitly approved via browser_use_tab.
func (r *TabRegistry) IsApproved(tabID int) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.approved[tabID]
}

func (r *TabRegistry) DefaultTab() (tool.BrowserTab, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.defaultID == nil {
		return tool.BrowserTab{}, false
	}
	tab, ok := r.tabs[*r.defaultID]
	return tab, ok
}

func (r *TabRegistry) Upsert(tab tool.BrowserTab) tool.BrowserTab {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.defaultID != nil && *r.defaultID == tab.TabID {
		tab.Controlled = true
	}
	r.tabs[tab.TabID] = tab
	return tab
}

func (r *TabRegistry) MarkStale(tabID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, snap := range r.snapshots[tabID] {
		snap.stale = true
	}
}

func (r *TabRegistry) StoreSnapshot(tab tool.BrowserTab, snapshotID string, refs []RefTarget) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tabs[tab.TabID] = tab
	refMap := make(map[string]RefTarget, len(refs))
	for _, ref := range refs {
		refMap[ref.Ref] = ref
	}
	cache := &snapshotCache{id: snapshotID, refs: refMap, createdAt: time.Now()}
	list := append([]*snapshotCache{cache}, r.snapshots[tab.TabID]...)
	if len(list) > 3 {
		list = list[:3]
	}
	r.snapshots[tab.TabID] = list
}

func (r *TabRegistry) ResolveRef(tabID int, snapshotID, ref string) (RefTarget, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, snap := range r.snapshots[tabID] {
		if snap.id != snapshotID {
			continue
		}
		if snap.stale {
			return RefTarget{}, fmt.Errorf("snapshot is stale; call browser_snapshot again")
		}
		target, ok := snap.refs[ref]
		if !ok {
			return RefTarget{}, fmt.Errorf("unknown browser ref %q in snapshot %s", ref, snapshotID)
		}
		return target, nil
	}
	return RefTarget{}, fmt.Errorf("unknown snapshot %s; call browser_snapshot again", snapshotID)
}
