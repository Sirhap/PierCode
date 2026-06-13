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
	// SessionID is the OOPIF child-frame CDP session this node lives in. Empty =
	// the main (page) session. Set for nodes inside cross-origin iframes so a
	// later click/type resolves the node on the correct session.
	SessionID string
	// FrameOffset is the iframe's viewport-absolute top-left, added to a
	// frame-relative box to get the real click point (headed-mode coordinate
	// compensation). Nil for main-frame nodes.
	FrameOffset *Bounds
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
	tracking map[int]string
	// lastPointer 记录每个 tab 最后一次合成的指针视口坐标,供 moveTo 做插值起点
	// 与扩展端幻影光标动画对齐(沿途触发 mouseover/mouseenter)。
	lastPointer map[int]Point
	// pendingSwitch records an unreported automatic default-tab change (e.g. a
	// click opened a new tab that became the controlled tab). A tool consumes it
	// once to tell the model the controlled tab moved, instead of letting the AI
	// silently act on a different tab than it thinks.
	pendingSwitch *tabSwitch
}

type tabSwitch struct {
	from int
	to   int
}

func NewTabRegistry() *TabRegistry {
	return &TabRegistry{
		tabs:        make(map[int]tool.BrowserTab),
		snapshots:   make(map[int][]*snapshotCache),
		approved:    make(map[int]bool),
		tracking:    make(map[int]string),
		lastPointer: make(map[int]Point),
	}
}

// SetLastPointer 记录某个 tab 最近一次合成指针落点,供下次 moveTo 作为插值起点。
func (r *TabRegistry) SetLastPointer(tabID int, p Point) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lastPointer == nil {
		r.lastPointer = map[int]Point{}
	}
	r.lastPointer[tabID] = p
}

// LastPointer 返回某个 tab 最近一次合成指针落点;ok=false 表示尚未记录(首次移动)。
func (r *TabRegistry) LastPointer(tabID int) (Point, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.lastPointer[tabID]
	return p, ok
}

func (r *TabRegistry) SetDefault(tab tool.BrowserTab) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := tab.TabID
	// Record an automatic switch so a tool can surface it: the controlled tab
	// moving out from under the AI (e.g. a click that opened a new tab) is the
	// kind of state change it must be told about.
	if r.defaultID != nil && *r.defaultID != id {
		r.pendingSwitch = &tabSwitch{from: *r.defaultID, to: id}
	}
	tab.Controlled = true
	tab = r.enrichLocked(tab)
	r.defaultID = &id
	r.tabs[id] = tab
}

// ConsumeDefaultSwitch returns and clears any pending automatic default-tab
// change. A tool calls it after acting to append a "controlled tab switched"
// note to its result. Returns ok=false when there was no switch.
func (r *TabRegistry) ConsumeDefaultSwitch() (from, to int, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingSwitch == nil {
		return 0, 0, false
	}
	s := r.pendingSwitch
	r.pendingSwitch = nil
	return s.from, s.to, true
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
	delete(r.tracking, tabID)
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
	tab = r.enrichLocked(tab)
	return tab, ok
}

func (r *TabRegistry) Upsert(tab tool.BrowserTab) tool.BrowserTab {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.defaultID != nil && *r.defaultID == tab.TabID {
		tab.Controlled = true
	}
	tab = r.enrichLocked(tab)
	r.tabs[tab.TabID] = tab
	return tab
}

func (r *TabRegistry) MarkCreated(tabID int) {
	r.markTracked(tabID, "created")
}

func (r *TabRegistry) MarkClaimed(tabID int) {
	r.markTracked(tabID, "claimed")
}

func (r *TabRegistry) markTracked(tabID int, source string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tracking[tabID] = source
	if tab, ok := r.tabs[tabID]; ok {
		tab.Tracked = true
		tab.TrackSource = source
		r.tabs[tabID] = tab
	}
}

func (r *TabRegistry) TrackingSource(tabID int) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tracking[tabID]
}

func (r *TabRegistry) Release(tabID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.defaultID != nil && *r.defaultID == tabID {
		r.defaultID = nil
	}
	delete(r.tracking, tabID)
	delete(r.approved, tabID)
	if tab, ok := r.tabs[tabID]; ok {
		tab.Controlled = false
		tab.Tracked = false
		tab.TrackSource = ""
		r.tabs[tabID] = tab
	}
}

func (r *TabRegistry) enrichLocked(tab tool.BrowserTab) tool.BrowserTab {
	if source := r.tracking[tab.TabID]; source != "" {
		tab.Tracked = true
		tab.TrackSource = source
	}
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
