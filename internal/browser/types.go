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
	Type   string `json:"type"`
	Event  string `json:"event"`
	TabID  int    `json:"tabId,omitempty"`
	Reason string `json:"reason,omitempty"`
	URL    string `json:"url,omitempty"`
	Title  string `json:"title,omitempty"`
}

type ApprovalAsk struct {
	Type       string      `json:"type"`
	ApprovalID string      `json:"approval_id"`
	CallID     string      `json:"call_id,omitempty"`
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

type clientSender func([]byte) bool

const (
	defaultReadTimeout       = 10 * time.Second
	defaultNavigateTimeout   = 60 * time.Second // [Fixed by mimo-v2.5-pro: increased from 30s for redirect-heavy sites]
	defaultScreenshotTimeout = 15 * time.Second
	defaultActionTimeout     = 10 * time.Second
)
