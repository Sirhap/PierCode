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

const maxConsolePerTab = 1000
const maxNetworkPerTab = 500

type EventBus struct {
	mu             sync.RWMutex
	dialogs        map[string]dialogWaiter
	console        map[int][]ConsoleMessage
	network        map[int][]NetworkRequest
	enabledDomains map[int]map[string]bool // tabID → domain → enabled
}

func NewEventBus() *EventBus {
	return &EventBus{
		dialogs:        make(map[string]dialogWaiter),
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
	case "Runtime.consoleAPICalled":
		b.handleConsoleEvent(event)
	case "Runtime.exceptionThrown":
		b.handleExceptionEvent(event)
	case "Network.requestWillBeSent":
		b.handleRequestWillBeSent(event)
	case "Network.responseReceived":
		b.handleResponseReceived(event)
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

func (b *EventBus) handleConsoleEvent(event Event) {
	var params struct {
		Type      string `json:"type"`
		Args      []struct {
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

func (b *EventBus) GetConsoleMessages(tabID int, filter ConsoleFilter) []ConsoleMessage {
	b.mu.RLock()
	messages := b.console[tabID]
	b.mu.RUnlock()

	var result []ConsoleMessage
	var re *regexp.Regexp
	if filter.Pattern != "" {
		re, _ = regexp.Compile(filter.Pattern)
	}

	for _, msg := range messages {
		if filter.OnlyErrors && msg.Type != "error" && msg.Type != "exception" {
			continue
		}
		if re != nil && !re.MatchString(msg.Text) {
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
	requests := b.network[tabID]
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
