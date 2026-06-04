package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	defaultWebAIProvider = "Claude"
	defaultWebAITimeout  = 5 * time.Minute
	maxWebAITimeout      = 30 * time.Minute
)

type AskWebAITool struct{}

func NewAskWebAITool() *AskWebAITool { return &AskWebAITool{} }

func (t *AskWebAITool) Name() string { return "ask_web_ai" }

func (t *AskWebAITool) Description() string {
	return "Ask a browser-based AI page for a second opinion and wait for its response. Use this from Claude Code via MCP when the user explicitly wants a web AI surface consulted. The prompt is forwarded through PierCode's local Go server to the browser extension, injected into the selected AI page, and the page's answer is returned as untrusted external advice that must be verified before acting on code."
}

func (t *AskWebAITool) Parameters() interface{} {
	return map[string]string{
		"prompt":      "string (required) - the exact question or context to send to the browser AI page",
		"provider":    "string (optional, default Claude) - target AI page provider, e.g. Claude, Qwen, ChatGPT, Gemini, Kimi, Z.ai, AI Studio, MiMo",
		"client_id":   "string (optional) - exact PierCode WebSocket client id to target; overrides provider fanout when set",
		"timeout_sec": "number (optional, default 300, max 1800) - how long to wait for the browser AI response",
	}
}

func (t *AskWebAITool) Validate(args map[string]interface{}) error {
	if strings.TrimSpace(stringArg(args, "prompt")) == "" {
		return fmt.Errorf("prompt is required")
	}
	if v, ok := args["provider"]; ok && v != nil {
		if _, ok := v.(string); !ok {
			return fmt.Errorf("provider must be a string")
		}
	}
	if v, ok := args["client_id"]; ok && v != nil {
		if _, ok := v.(string); !ok {
			return fmt.Errorf("client_id must be a string")
		}
	}
	if _, err := webAITimeoutFromArgs(args); err != nil {
		return err
	}
	return nil
}

func (t *AskWebAITool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	if ctx == nil {
		result.Status = "error"
		result.Error = "tool context is required"
		return result
	}
	if ctx.Broadcast == nil && ctx.BroadcastToClient == nil {
		result.Status = "error"
		result.Error = "web AI bridge is not configured"
		return result
	}

	prompt := strings.TrimSpace(stringArg(ctx.Args, "prompt"))
	if prompt == "" {
		result.Status = "error"
		result.Error = "prompt is required"
		return result
	}
	provider := normalizeWebAIProvider(stringArg(ctx.Args, "provider"))
	clientID := strings.TrimSpace(stringArg(ctx.Args, "client_id"))
	queryID := strings.TrimSpace(stringArg(ctx.Args, "call_id"))
	if queryID == "" {
		queryID = fmt.Sprintf("web_ai_%d", time.Now().UnixNano())
	}
	timeout, err := webAITimeoutFromArgs(ctx.Args)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	answerCh, cleanup := PendingWebAIQueries.Register(queryID)
	defer cleanup()

	// Resolve a single target tab. An explicit client_id wins; otherwise ask the
	// server to pick one connected AI page for the provider. Targeting one tab
	// avoids injecting+submitting the prompt into every matching page (only the
	// first reply is ever used) and lets us fail fast when no page is connected.
	if clientID == "" && ctx.PickWebAIClient != nil {
		clientID = ctx.PickWebAIClient(provider)
		if clientID == "" {
			result.Status = "error"
			result.Error = "no connected browser AI page for provider: " + provider
			return result
		}
	}

	payload := map[string]interface{}{
		"type":       "ai_query",
		"query_id":   queryID,
		"call_id":    queryID,
		"text":       prompt,
		"provider":   provider,
		"client_id":  clientID,
		"timeout_ms": int(timeout / time.Millisecond),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		result.Status = "error"
		result.Error = "failed to encode web AI query: " + err.Error()
		return result
	}

	if clientID != "" && ctx.BroadcastToClient != nil {
		if !ctx.BroadcastToClient(clientID, data) {
			result.Status = "error"
			result.Error = "target browser AI client is not connected: " + clientID
			return result
		}
	} else {
		ctx.Broadcast(data)
	}

	parent := ctx.Context
	if parent == nil {
		parent = context.Background()
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case answer := <-answerCh:
		if reason, canceled := parsePendingWebAICancel(answer.Error); canceled {
			result.Status = "error"
			result.Error = "web AI query canceled: " + reason
			return result
		}
		if strings.TrimSpace(answer.Error) != "" {
			result.Status = "error"
			result.Error = answer.Error
			return result
		}
		text := strings.TrimSpace(answer.Text)
		if text == "" {
			result.Status = "error"
			result.Error = "web AI returned an empty response"
			return result
		}
		result.Status = "success"
		if boolArg(ctx.Args, "raw_output") {
			// Anthropic-API impersonation wants only the model's words, with no
			// "Provider:/URL:" preamble leaking into the assistant turn.
			result.Output = strings.TrimSpace(answer.Text)
		} else {
			result.Output = formatWebAIResult(answer, provider)
		}
		return result
	case <-timer.C:
		t.broadcastCancel(ctx, queryID, "timeout")
		result.Status = "error"
		result.Error = fmt.Sprintf("no web AI response received within %s", timeout)
		return result
	case <-parent.Done():
		t.broadcastCancel(ctx, queryID, "canceled")
		result.Status = "error"
		result.Error = parent.Err().Error()
		return result
	}
}

func (t *AskWebAITool) broadcastCancel(ctx *Context, queryID, reason string) {
	if ctx == nil || ctx.Broadcast == nil {
		return
	}
	payload := map[string]interface{}{
		"type":     "ai_query_cancel",
		"query_id": queryID,
		"reason":   reason,
	}
	if data, err := json.Marshal(payload); err == nil {
		ctx.Broadcast(data)
	}
}

func normalizeWebAIProvider(provider string) string {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return defaultWebAIProvider
	}
	return provider
}

func webAITimeoutFromArgs(args map[string]interface{}) (time.Duration, error) {
	timeout := defaultWebAITimeout
	switch v := args["timeout_sec"].(type) {
	case nil:
	case float64:
		if v <= 0 {
			return 0, fmt.Errorf("timeout_sec must be greater than 0")
		}
		timeout = time.Duration(v * float64(time.Second))
	case int:
		if v <= 0 {
			return 0, fmt.Errorf("timeout_sec must be greater than 0")
		}
		timeout = time.Duration(v) * time.Second
	case int64:
		if v <= 0 {
			return 0, fmt.Errorf("timeout_sec must be greater than 0")
		}
		timeout = time.Duration(v) * time.Second
	default:
		return 0, fmt.Errorf("timeout_sec must be a number")
	}
	if timeout > maxWebAITimeout {
		return 0, fmt.Errorf("timeout_sec must be <= %.0f", maxWebAITimeout.Seconds())
	}
	return timeout, nil
}

func formatWebAIResult(answer WebAIQueryResult, fallbackProvider string) string {
	provider := strings.TrimSpace(answer.Provider)
	if provider == "" {
		provider = fallbackProvider
	}
	var b strings.Builder
	if provider != "" {
		b.WriteString("Provider: ")
		b.WriteString(provider)
		b.WriteByte('\n')
	}
	if url := strings.TrimSpace(answer.URL); url != "" {
		b.WriteString("URL: ")
		b.WriteString(url)
		b.WriteByte('\n')
	}
	if b.Len() > 0 {
		b.WriteByte('\n')
	}
	b.WriteString(strings.TrimSpace(answer.Text))
	return strings.TrimSpace(b.String())
}
