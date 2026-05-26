package types

import (
	"encoding/json"
	"sync"
)

type ToolRequest struct {
	Name    string                 `json:"name"`
	CallID  string                 `json:"call_id,omitempty"`
	Args    map[string]interface{} `json:"args"`
	Reason  string                 `json:"reason,omitempty"`
	Profile string                 `json:"profile,omitempty"`
}

func (r *ToolRequest) UnmarshalJSON(data []byte) error {
	type raw struct {
		Name      string                 `json:"name"`
		CallID    string                 `json:"call_id"`
		CallIDAlt string                 `json:"callId"`
		Args      map[string]interface{} `json:"args"`
		Arguments map[string]interface{} `json:"arguments"`
		Reason    string                 `json:"reason,omitempty"`
		Profile   string                 `json:"profile,omitempty"`
		Adapter   string                 `json:"adapter,omitempty"`
	}
	var v raw
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
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
	// AllowShell gates the exec_cmd tool. Defaults to false because exec_cmd
	// gives the AI a full sub-shell and the in-process command blacklist is a
	// best-effort filter, not a real sandbox. Operators must opt in via
	// `--allow-shell` after acknowledging the risk.
	AllowShell bool
	// AllowedOrigins is the explicit set of HTTP/WebSocket Origin values
	// permitted to reach the server. Empty = only same-origin and the
	// default chrome-extension scheme.
	AllowedOrigins []string
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
