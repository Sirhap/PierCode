package browser

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

type DialogEvent struct {
	TabID   int
	Type    string
	Message string
	URL     string
}

type ConsoleMessage struct {
	TabID     int
	Type      string
	Text      string
	Timestamp float64
}

type NetworkRequest struct {
	TabID      int
	RequestID  string
	Method     string
	URL        string
	Type       string
	StatusCode int
	StatusText string
	Duration   float64
	Timestamp  float64
}

type ConsoleFilter struct {
	Pattern    string
	OnlyErrors bool
	Limit      int
}

type NetworkFilter struct {
	URLPattern string
	Limit      int
}

type dialogWaiter struct {
	tabID int
	ch    chan DialogEvent
}

// navWaiter is notified when a navigation lifecycle event fires for its tab.
// kind identifies which CDP event arrived ("load", "frameNavigated",
// or a lifecycle name like "networkIdle"/"DOMContentLoaded").
type navWaiter struct {
	tabID int
	ch    chan NavEvent
}

// NavEvent carries the navigation lifecycle signal a waiter is interested in.
type NavEvent struct {
	TabID int
	Kind  string
	URL   string
}

const maxConsolePerTab = 1000
const maxNetworkPerTab = 500

type EventBus struct {
	mu             sync.RWMutex
	dialogs        map[string]dialogWaiter
	navs           map[string]navWaiter
	console        map[int][]ConsoleMessage
	network        map[int][]NetworkRequest
	enabledDomains map[int]map[string]bool // tabID → domain → enabled
}

func NewEventBus() *EventBus {
	return &EventBus{
		dialogs:        make(map[string]dialogWaiter),
		navs:           make(map[string]navWaiter),
		console:        make(map[int][]ConsoleMessage),
		network:        make(map[int][]NetworkRequest),
		enabledDomains: make(map[int]map[string]bool),
	}
}

// IsDomainEnabled reports whether the given CDP domain has already been
// enabled for the specified tab, so callers can skip redundant enable calls.
func (b *EventBus) IsDomainEnabled(tabID int, domain string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	dm, ok := b.enabledDomains[tabID]
	return ok && dm[domain]
}

// MarkDomainEnabled records that the given CDP domain is now enabled for
// the specified tab.  Call this after a successful CDP *.enable command.
func (b *EventBus) MarkDomainEnabled(tabID int, domain string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	dm, ok := b.enabledDomains[tabID]
	if !ok {
		dm = make(map[string]bool)
		b.enabledDomains[tabID] = dm
	}
	dm[domain] = true
}

// ClearDomainTracking removes all domain tracking for the given tab.
// Call this when a tab is removed or navigated to a new page.
func (b *EventBus) ClearDomainTracking(tabID int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.enabledDomains, tabID)
}

func (b *EventBus) HandleEvent(event Event) {
	if b == nil {
		return
	}
	switch event.Event {
	case "Page.javascriptDialogOpening":
		b.handleDialogEvent(event)
	case "Page.loadEventFired", "Page.frameNavigated", "Page.lifecycleEvent":
		b.handleNavigationEvent(event)
	case "Runtime.consoleAPICalled":
		b.handleConsoleEvent(event)
	case "Runtime.exceptionThrown":
		b.handleExceptionEvent(event)
	case "Network.requestWillBeSent":
		b.handleRequestWillBeSent(event)
	case "Network.responseReceived":
		b.handleResponseReceived(event)
	case "Network.loadingFailed":
		b.handleLoadingFailed(event)
	}
}

func (b *EventBus) handleDialogEvent(event Event) {
	var params struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		URL     string `json:"url"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	dialog := DialogEvent{
		TabID:   event.TabID,
		Type:    params.Type,
		Message: params.Message,
		URL:     params.URL,
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, waiter := range b.dialogs {
		if waiter.tabID > 0 && waiter.tabID != event.TabID {
			continue
		}
		select {
		case waiter.ch <- dialog:
		default:
		}
	}
}

// handleNavigationEvent fans a Page navigation lifecycle event out to any
// registered nav waiters for the tab. Survives JS-context destruction because
// it is driven by CDP events rather than in-page polling.
func (b *EventBus) handleNavigationEvent(event Event) {
	nav := NavEvent{TabID: event.TabID}
	switch event.Event {
	case "Page.loadEventFired":
		nav.Kind = "load"
	case "Page.frameNavigated":
		var p struct {
			Frame struct {
				URL          string `json:"url"`
				ParentID     string `json:"parentId"`
			} `json:"frame"`
		}
		if len(event.Params) > 0 {
			_ = json.Unmarshal(event.Params, &p)
		}
		if p.Frame.ParentID != "" {
			return // only the main frame's navigation counts
		}
		nav.Kind = "frameNavigated"
		nav.URL = p.Frame.URL
	case "Page.lifecycleEvent":
		var p struct {
			Name string `json:"name"`
		}
		if len(event.Params) > 0 {
			_ = json.Unmarshal(event.Params, &p)
		}
		nav.Kind = p.Name // e.g. "DOMContentLoaded", "load", "networkIdle"
	}
	if nav.Kind == "" {
		return
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, waiter := range b.navs {
		if waiter.tabID > 0 && waiter.tabID != event.TabID {
			continue
		}
		select {
		case waiter.ch <- nav:
		default:
		}
	}
}

func (b *EventBus) handleConsoleEvent(event Event) {
	var params struct {
		Type string `json:"type"`
		Args []struct {
			Type        string      `json:"type"`
			Value       interface{} `json:"value"`
			Description string      `json:"description"`
		} `json:"args"`
		Timestamp float64 `json:"timestamp"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	var textParts []string
	for _, arg := range params.Args {
		if arg.Type == "string" {
			textParts = append(textParts, fmt.Sprintf("%v", arg.Value))
		} else if arg.Description != "" {
			textParts = append(textParts, arg.Description)
		} else {
			textParts = append(textParts, fmt.Sprintf("[%s]", arg.Type))
		}
	}
	msg := ConsoleMessage{
		TabID:     event.TabID,
		Type:      params.Type,
		Text:      strings.Join(textParts, " "),
		Timestamp: params.Timestamp,
	}

	b.mu.Lock()
	b.console[event.TabID] = append(b.console[event.TabID], msg)
	if len(b.console[event.TabID]) > maxConsolePerTab {
		b.console[event.TabID] = b.console[event.TabID][len(b.console[event.TabID])-maxConsolePerTab:]
	}
	b.mu.Unlock()
}

func (b *EventBus) handleExceptionEvent(event Event) {
	var params struct {
		ExceptionDetails struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
		Timestamp float64 `json:"timestamp"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	text := params.ExceptionDetails.Exception.Description
	if text == "" {
		text = params.ExceptionDetails.Text
	}
	if text == "" {
		text = "Unknown exception"
	}
	msg := ConsoleMessage{
		TabID:     event.TabID,
		Type:      "exception",
		Text:      text,
		Timestamp: params.Timestamp,
	}

	b.mu.Lock()
	b.console[event.TabID] = append(b.console[event.TabID], msg)
	if len(b.console[event.TabID]) > maxConsolePerTab {
		b.console[event.TabID] = b.console[event.TabID][len(b.console[event.TabID])-maxConsolePerTab:]
	}
	b.mu.Unlock()
}

func (b *EventBus) handleRequestWillBeSent(event Event) {
	var params struct {
		RequestID string `json:"requestId"`
		Request   struct {
			URL    string `json:"url"`
			Method string `json:"method"`
		} `json:"request"`
		Type      string  `json:"type"`
		Timestamp float64 `json:"timestamp"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	req := NetworkRequest{
		TabID:     event.TabID,
		RequestID: params.RequestID,
		Method:    params.Request.Method,
		URL:       params.Request.URL,
		Type:      params.Type,
		Timestamp: params.Timestamp,
	}

	b.mu.Lock()
	b.network[event.TabID] = append(b.network[event.TabID], req)
	if len(b.network[event.TabID]) > maxNetworkPerTab {
		b.network[event.TabID] = b.network[event.TabID][len(b.network[event.TabID])-maxNetworkPerTab:]
	}
	b.mu.Unlock()
}

func (b *EventBus) handleResponseReceived(event Event) {
	var params struct {
		RequestID string  `json:"requestId"`
		Timestamp float64 `json:"timestamp"`
		Response  struct {
			Status     int    `json:"status"`
			StatusText string `json:"statusText"`
			MimeType   string `json:"mimeType"`
		} `json:"response"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}

	b.mu.Lock()
	requests := b.network[event.TabID]
	for i := len(requests) - 1; i >= 0; i-- {
		if requests[i].RequestID == params.RequestID && requests[i].StatusCode == 0 {
			requests[i].StatusCode = params.Response.Status
			requests[i].StatusText = params.Response.StatusText
			if params.Timestamp > 0 && requests[i].Timestamp > 0 {
				requests[i].Duration = (params.Timestamp - requests[i].Timestamp) * 1000
			}
			break
		}
	}
	b.mu.Unlock()
}

// handleLoadingFailed marks a request that errored (blocked, aborted, DNS/TLS
// failure, etc.) so browser_network surfaces failures, not just completed
// responses. The error text is stored in StatusText with StatusCode -1.
func (b *EventBus) handleLoadingFailed(event Event) {
	var params struct {
		RequestID string `json:"requestId"`
		ErrorText string `json:"errorText"`
		Canceled  bool   `json:"canceled"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	b.mu.Lock()
	requests := b.network[event.TabID]
	for i := len(requests) - 1; i >= 0; i-- {
		if requests[i].RequestID == params.RequestID && requests[i].StatusCode == 0 {
			requests[i].StatusCode = -1
			msg := params.ErrorText
			if msg == "" && params.Canceled {
				msg = "canceled"
			}
			requests[i].StatusText = "failed: " + msg
			break
		}
	}
	b.mu.Unlock()
}

func (b *EventBus) GetConsoleMessages(tabID int, filter ConsoleFilter) []ConsoleMessage {
	b.mu.RLock()
	messages := append([]ConsoleMessage(nil), b.console[tabID]...)
	b.mu.RUnlock()

	var result []ConsoleMessage
	var re *regexp.Regexp
	literal := ""
	if filter.Pattern != "" {
		var err error
		re, err = regexp.Compile(filter.Pattern)
		if err != nil {
			// Invalid regex: fall back to a literal substring match instead of
			// silently returning nil. An empty return is indistinguishable from
			// "no console messages", so the model would wrongly conclude the page
			// logged nothing when its pattern merely failed to compile.
			re, literal = nil, filter.Pattern
		}
	}

	for _, msg := range messages {
		if filter.OnlyErrors && msg.Type != "error" && msg.Type != "exception" {
			continue
		}
		if re != nil && !re.MatchString(msg.Text) {
			continue
		}
		if literal != "" && !strings.Contains(msg.Text, literal) {
			continue
		}
		result = append(result, msg)
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	if len(result) > limit {
		result = result[len(result)-limit:]
	}
	return result
}

func (b *EventBus) ClearConsole(tabID int) {
	b.mu.Lock()
	delete(b.console, tabID)
	b.mu.Unlock()
}

func (b *EventBus) GetNetworkRequests(tabID int, filter NetworkFilter) []NetworkRequest {
	b.mu.RLock()
	requests := append([]NetworkRequest(nil), b.network[tabID]...)
	b.mu.RUnlock()

	var result []NetworkRequest
	for _, req := range requests {
		if filter.URLPattern != "" && !strings.Contains(req.URL, filter.URLPattern) {
			continue
		}
		result = append(result, req)
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	if len(result) > limit {
		result = result[len(result)-limit:]
	}
	return result
}

func (b *EventBus) ClearNetwork(tabID int) {
	b.mu.Lock()
	delete(b.network, tabID)
	b.mu.Unlock()
}

func (b *EventBus) WaitForDialog(callID string, tabID int, timeout time.Duration) <-chan DialogEvent {
	ch := make(chan DialogEvent, 1)
	if b == nil {
		close(ch)
		return ch
	}
	b.mu.Lock()
	b.dialogs[callID] = dialogWaiter{tabID: tabID, ch: ch}
	b.mu.Unlock()
	time.AfterFunc(timeout, func() {
		b.RemoveDialog(callID)
	})
	return ch
}

func (b *EventBus) RemoveDialog(callID string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	delete(b.dialogs, callID)
	b.mu.Unlock()
}

// HasDialogWaiter reports whether an explicit browser_handle_dialog call is
// currently waiting for a dialog on the given tab (or for any tab). When this
// is false and a dialog opens, the Controller auto-dismisses it so a blocking
// alert/confirm/prompt cannot wedge the tab.
func (b *EventBus) HasDialogWaiter(tabID int) bool {
	if b == nil {
		return false
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, w := range b.dialogs {
		if w.tabID <= 0 || w.tabID == tabID {
			return true
		}
	}
	return false
}

// WaitForNavigationEvent registers a waiter for navigation lifecycle events on a
// tab. The returned channel receives every NavEvent for the tab until RemoveNav
// (or the timeout) clears it. Because it is driven by CDP Page events, it
// survives the JS-context destruction that breaks in-page polling.
func (b *EventBus) WaitForNavigationEvent(callID string, tabID int, timeout time.Duration) <-chan NavEvent {
	ch := make(chan NavEvent, 8)
	if b == nil {
		close(ch)
		return ch
	}
	b.mu.Lock()
	b.navs[callID] = navWaiter{tabID: tabID, ch: ch}
	b.mu.Unlock()
	time.AfterFunc(timeout, func() { b.RemoveNav(callID) })
	return ch
}

func (b *EventBus) RemoveNav(callID string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	delete(b.navs, callID)
	b.mu.Unlock()
}
