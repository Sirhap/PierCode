package types

import (
	"encoding/json"
	"sync"
)

type ToolRequest struct {
	Name            string                 `json:"name"`
	CallID          string                 `json:"call_id,omitempty"`
	Args            map[string]interface{} `json:"args"`
	Reason          string                 `json:"reason,omitempty"`
	Profile         string                 `json:"profile,omitempty"`
	SourceClientID  string                 `json:"client_id,omitempty"`
	ConversationURL string                 `json:"conversation_url,omitempty"`
	// WithGuidance gates whether the executor appends prompt guidance to this
	// call's output. The extension sets it false on every tool in an
	// auto-executed batch except the last, so a multi-tool turn carries the
	// reminder once instead of N times. nil (field absent) means "yes" — older
	// clients and direct /exec callers keep the previous behavior.
	WithGuidance *bool `json:"with_guidance,omitempty"`
}

// GuidanceEnabled reports whether prompt guidance should be appended. Absent
// (nil) defaults to true for backward compatibility.
func (r *ToolRequest) GuidanceEnabled() bool {
	return r.WithGuidance == nil || *r.WithGuidance
}

func (r *ToolRequest) UnmarshalJSON(data []byte) error {
	type raw struct {
		Name            string                 `json:"name"`
		CallID          string                 `json:"call_id"`
		CallIDAlt       string                 `json:"callId"`
		Args            map[string]interface{} `json:"args"`
		Arguments       map[string]interface{} `json:"arguments"`
		Reason          string                 `json:"reason,omitempty"`
		Profile         string                 `json:"profile,omitempty"`
		Adapter         string                 `json:"adapter,omitempty"`
		ClientID        string                 `json:"client_id,omitempty"`
		ConversationURL string                 `json:"conversation_url,omitempty"`
		WithGuidance    *bool                  `json:"with_guidance,omitempty"`
	}
	var v raw
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	r.WithGuidance = v.WithGuidance
	r.Name = v.Name
	if v.CallID != "" {
		r.CallID = v.CallID
	} else {
		r.CallID = v.CallIDAlt
	}
	r.Reason = v.Reason
	if v.Profile != "" {
		r.Profile = v.Profile
	} else {
		r.Profile = v.Adapter
	}
	r.SourceClientID = v.ClientID
	r.ConversationURL = v.ConversationURL
	if v.Args != nil {
		r.Args = v.Args
	} else {
		r.Args = v.Arguments
	}
	return nil
}

type ToolResponse struct {
	Name       string `json:"name,omitempty"`
	CallID     string `json:"call_id,omitempty"`
	Status     string `json:"status"`
	Output     string `json:"output"`
	Error      string `json:"error,omitempty"`
	StopStream bool   `json:"stopStream,omitempty"`
}

type Config struct {
	mu             sync.RWMutex
	RootDir        string
	InitialRootDir string
	Port           int
	Timeout        int
	Token          string
	DefaultPrompt  []byte
	// AllowShell gates the exec_cmd tool. The current server default is true for
	// compatibility; operators can disable it with --no-shell. The in-process
	// command blacklist is a best-effort filter, not a real sandbox.
	AllowShell bool
	// AdditionalAllowedDirs extends the file-operation sandbox beyond RootDir.
	// Paths are still resolved through real-path checks before access.
	AdditionalAllowedDirs []string
	// PermissionMode controls file-operation path access: default, auto, unrestricted.
	PermissionMode string
	// AllowedOrigins is the explicit set of HTTP/WebSocket Origin values
	// permitted to reach the server. Empty = only same-origin and the
	// default chrome-extension scheme.
	AllowedOrigins []string
	// AllowedSensitiveHosts lists registrable domains the user has marked as NOT
	// payment/financial-sensitive, overriding the keyword heuristic so browser
	// actions are not refused on developer-docs / e-commerce-test pages.
	AllowedSensitiveHosts []string
}

func (c *Config) GetRootDir() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.RootDir
}

func (c *Config) SetRootDir(rootDir string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.RootDir = rootDir
}

func (c *Config) GetAdditionalAllowedDirs() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]string(nil), c.AdditionalAllowedDirs...)
}

func NormalizePermissionMode(mode string) string {
	switch mode {
	case "default", "auto", "unrestricted":
		return mode
	default:
		return "default"
	}
}

func (c *Config) GetPermissionMode() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return NormalizePermissionMode(c.PermissionMode)
}

func (c *Config) SetPermissionMode(mode string) string {
	mode = NormalizePermissionMode(mode)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.PermissionMode = mode
	return mode
}
