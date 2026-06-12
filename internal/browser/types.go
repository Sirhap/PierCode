package browser

import (
	"encoding/json"
	"time"
)

type Command struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	TabID     *int            `json:"tabId,omitempty"`
	Domain    string          `json:"domain"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params,omitempty"`
	TimeoutMS int             `json:"timeoutMs"`
}

type Result struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type Event struct {
	Type   string          `json:"type"`
	Event  string          `json:"event"`
	TabID  int             `json:"tabId,omitempty"`
	Reason string          `json:"reason,omitempty"`
	URL    string          `json:"url,omitempty"`
	Title  string          `json:"title,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

type ApprovalAsk struct {
	Type       string      `json:"type"`
	ApprovalID string      `json:"approval_id"`
	CallID     string      `json:"call_id,omitempty"`
	ClientID   string      `json:"client_id,omitempty"`
	Action     string      `json:"action"`
	Tab        interface{} `json:"tab,omitempty"`
	Target     string      `json:"target"`
	Risk       string      `json:"risk"`
	Options    []string    `json:"options"`
}

type ApprovalAnswer struct {
	Type       string `json:"type"`
	ApprovalID string `json:"approval_id"`
	Approved   bool   `json:"approved"`
	Reason     string `json:"reason,omitempty"`
}

// RelayTransport is how the relay reaches browser-relay WS clients. The server
// supplies the WSManager-backed impl. Routing by tabId lets multiple connected
// browsers coexist: a tabId-bearing command goes only to the browser that owns
// that tab (falling back to broadcast when the owner is unknown).
type RelayTransport interface {
	// SendBrowserCommand routes one command payload. Returns (sent, targeted):
	// targeted=true means it went to a single owning browser, false means it
	// was broadcast to all browser-relays.
	SendBrowserCommand(tabID *int, payload []byte) (sent bool, targeted bool)
	// BrowserRelayIDs lists every connected browser-relay client id (for
	// per-client fan-out, e.g. aggregating listTabs across browsers).
	BrowserRelayIDs() []string
	// SendToID delivers a payload to one specific client id.
	SendToID(id string, payload []byte) bool
}

// broadcastTransport adapts a single broadcast send func into a RelayTransport
// with one virtual client. Used by tests and any single-channel caller — no
// tab routing, every command broadcasts and there is exactly one fan-out lane.
type broadcastTransport struct {
	send func([]byte) bool
}

func (b broadcastTransport) SendBrowserCommand(_ *int, payload []byte) (bool, bool) {
	return b.send(payload), false
}
func (b broadcastTransport) BrowserRelayIDs() []string { return []string{"broadcast"} }
func (b broadcastTransport) SendToID(_ string, payload []byte) bool {
	return b.send(payload)
}

const (
	defaultReadTimeout       = 10 * time.Second
	defaultNavigateTimeout   = 60 * time.Second // [Fixed by mimo-v2.5-pro: increased from 30s for redirect-heavy sites]
	defaultScreenshotTimeout = 15 * time.Second
	defaultActionTimeout     = 10 * time.Second
)
