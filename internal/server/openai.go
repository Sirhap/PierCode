package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirhap/piercode/internal/types"
)

// The "Codex / OpenAI client → Go → browser AI" bridge.
//
// Mirrors the Anthropic impersonation (anthropic.go) but speaks the OpenAI Chat
// Completions API. A client (e.g. Codex with OPENAI_BASE_URL pointed here, or
// any OpenAI SDK) POSTs /v1/chat/completions; we flatten the request into one
// prompt, forward it through ask_web_ai to the browser AI page, and re-encode
// the reply as an OpenAI completion — either a plain assistant message or, when
// the page emits a piercode-call block, a tool_calls turn.
//
// Reused from the Anthropic layer: parseToolCalls / buildToolProtocolPreamble
// (the page-facing tool contract is provider-agnostic), estimateTokens,
// previewString.
//
// Two transports, matching anthropic.go:
//   - stream:true → SSE chat.completion.chunk events, with keepalive chunks
//     emitted before the browser AI answers so a client's silence timeout does
//     not abort the long page round-trip.
//   - stream:false → one buffered chat.completion JSON object.

type openAIMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Name    string          `json:"name"`
	// tool_calls / tool_call_id appear on assistant/tool messages in a
	// continuation turn; we summarize them when flattening so the page sees the
	// prior tool round-trip.
	ToolCalls  json.RawMessage `json:"tool_calls"`
	ToolCallID string          `json:"tool_call_id"`
}

type openAIToolDef struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type openAIChatRequest struct {
	Model    string          `json:"model"`
	Messages []openAIMessage `json:"messages"`
	Tools    []openAIToolDef `json:"tools"`
	Stream   bool            `json:"stream"`
}

// handleOpenAIChatCompletions impersonates POST /v1/chat/completions.
func (s *Server) handleOpenAIChatCompletions(c *gin.Context) {
	var req openAIChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", "invalid request body: "+err.Error()))
		return
	}

	prompt, err := flattenOpenAIRequest(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", err.Error()))
		return
	}
	if strings.TrimSpace(prompt) == "" {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", "no text content in messages"))
		return
	}

	// Reuse the Anthropic tool contract: translate OpenAI tool defs to the shared
	// shape and append the same page-facing preamble.
	if preamble := buildToolProtocolPreamble(openAIToolsToShared(req.Tools)); preamble != "" {
		prompt += preamble
	}

	provider := strings.TrimSpace(c.Query("provider"))
	timeoutSec := 300.0
	args := map[string]interface{}{
		"prompt":      prompt,
		"provider":    "Browser",
		"timeout_sec": timeoutSec,
		"raw_output":  true,
	}
	if provider != "" {
		args["provider"] = provider
	}
	if clientID := strings.TrimSpace(c.Query("client_id")); clientID != "" {
		args["client_id"] = clientID
	}

	cmplID := fmt.Sprintf("chatcmpl_%d", time.Now().UnixNano())
	execReq := &types.ToolRequest{
		Name:   "ask_web_ai",
		CallID: cmplID,
		Args:   args,
	}

	model := req.Model
	if model == "" {
		model = "piercode-web-ai"
	}
	created := time.Now().Unix()
	promptTokens := estimateTokens(prompt)

	log.Printf("[openai] /v1/chat/completions model=%q stream=%v tools=%d prompt_bytes=%d prompt_tokens~=%d preview=%q",
		req.Model, req.Stream, len(req.Tools), len(prompt), promptTokens, previewString(prompt, 200))

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second+30*time.Second)
	defer cancel()

	// Streaming path: open SSE + keepalive before the browser AI answers.
	if req.Stream {
		w := newSSEWriter(c)
		w.openAIRoleChunk(cmplID, model, created)

		done := make(chan *types.ToolResponse, 1)
		go func() {
			done <- s.executor.ExecuteWithStream(ctx, execReq, func(string, string) {})
		}()

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		var resp *types.ToolResponse
	wait:
		for {
			select {
			case r := <-done:
				resp = r
				break wait
			case <-ticker.C:
				w.openAIKeepalive()
			case <-c.Request.Context().Done():
				cancel()
				<-done
				return
			}
		}

		if resp.Status == "error" || resp.Error != "" {
			msg := resp.Error
			if msg == "" {
				msg = "web AI query failed"
			}
			w.openAITextDelta(cmplID, model, created, "[piercode] web AI error: "+msg)
			w.openAIFinish(cmplID, model, created, "stop")
			return
		}
		text := strings.TrimSpace(resp.Output)
		if text == "" {
			w.openAITextDelta(cmplID, model, created, "[piercode] web AI returned an empty response")
			w.openAIFinish(cmplID, model, created, "stop")
			return
		}

		calls, leadingText, hasCalls := parseToolCalls(text)
		if hasCalls {
			if leadingText != "" {
				w.openAITextDelta(cmplID, model, created, leadingText)
			}
			w.openAIToolCallsDelta(cmplID, model, created, cmplID, calls)
			w.openAIFinish(cmplID, model, created, "tool_calls")
		} else {
			w.openAITextDelta(cmplID, model, created, text)
			w.openAIFinish(cmplID, model, created, "stop")
		}
		return
	}

	// Non-streaming: one buffered chat.completion object.
	resp := s.executor.ExecuteWithStream(ctx, execReq, func(string, string) {})
	if resp.Status == "error" || resp.Error != "" {
		msg := resp.Error
		if msg == "" {
			msg = "web AI query failed"
		}
		c.JSON(http.StatusBadGateway, openAIErrorBody("api_error", msg))
		return
	}
	text := strings.TrimSpace(resp.Output)
	if text == "" {
		c.JSON(http.StatusBadGateway, openAIErrorBody("api_error", "web AI returned an empty response"))
		return
	}

	calls, leadingText, hasCalls := parseToolCalls(text)
	completionTokens := estimateTokens(text)
	if hasCalls {
		c.JSON(http.StatusOK, openAIToolCallsResponse(cmplID, model, created, leadingText, calls, promptTokens, completionTokens))
		return
	}
	c.JSON(http.StatusOK, openAIMessageResponse(cmplID, model, created, text, promptTokens, completionTokens))
}

// openAIToolsToShared maps OpenAI function tool defs onto the shared
// anthropicToolDef shape so buildToolProtocolPreamble can list them. Only the
// name is used by the preamble; schema/description ride along in the flattened
// prompt body the same way Anthropic's do.
func openAIToolsToShared(tools []openAIToolDef) []anthropicToolDef {
	if len(tools) == 0 {
		return nil
	}
	out := make([]anthropicToolDef, 0, len(tools))
	for _, t := range tools {
		out = append(out, anthropicToolDef{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: t.Function.Parameters,
		})
	}
	return out
}

// flattenOpenAIRequest collapses the OpenAI messages array into one plain-text
// prompt. system/user/assistant/tool roles are labelled; tool_calls and
// tool-result messages are summarized so the page sees prior tool round-trips.
func flattenOpenAIRequest(req openAIChatRequest) (string, error) {
	var b strings.Builder
	for _, m := range req.Messages {
		role := strings.TrimSpace(m.Role)
		text := flattenOpenAIContent(m.Content)

		// Assistant turns may carry tool_calls instead of (or alongside) text.
		if summary := summarizeOpenAIToolCalls(m.ToolCalls); summary != "" {
			if text != "" {
				text += "\n\n"
			}
			text += summary
		}
		if text == "" {
			continue
		}

		switch role {
		case "system":
			b.WriteString("System:\n")
		case "user":
			b.WriteString("User:\n")
		case "assistant":
			b.WriteString("Assistant:\n")
		case "tool":
			label := "Tool result"
			if m.Name != "" {
				label = "Tool " + m.Name + " result"
			}
			b.WriteString(label + ":\n")
		default:
			if role == "" {
				role = "user"
			}
			b.WriteString(capitalizeRole(role))
			b.WriteString(":\n")
		}
		b.WriteString(text)
		b.WriteString("\n\n")
	}
	return strings.TrimSpace(b.String()), nil
}

// flattenOpenAIContent handles the two legal content shapes: a plain string, or
// an array of typed parts (text / image_url). Non-text parts are summarized.
func flattenOpenAIContent(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}

	var parts []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parts); err != nil {
		return strings.TrimSpace(string(raw))
	}

	var out []string
	for _, p := range parts {
		typ := ""
		if t, ok := p["type"]; ok {
			_ = json.Unmarshal(t, &typ)
		}
		switch typ {
		case "text":
			var s string
			if t, ok := p["text"]; ok {
				_ = json.Unmarshal(t, &s)
			}
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		case "image_url":
			out = append(out, "[image omitted]")
		default:
			if t, ok := p["text"]; ok {
				var s string
				_ = json.Unmarshal(t, &s)
				if s = strings.TrimSpace(s); s != "" {
					out = append(out, s)
				}
			}
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n\n"))
}

// summarizeOpenAIToolCalls renders an assistant message's tool_calls array as
// readable text so the browser AI sees what tools were invoked previously.
func summarizeOpenAIToolCalls(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var calls []struct {
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	if err := json.Unmarshal(raw, &calls); err != nil {
		return ""
	}
	var parts []string
	for _, call := range calls {
		summary := "[called tool"
		if call.Function.Name != "" {
			summary += " " + call.Function.Name
		}
		if args := strings.TrimSpace(call.Function.Arguments); args != "" {
			summary += " with " + args
		}
		summary += "]"
		parts = append(parts, summary)
	}
	return strings.Join(parts, "\n")
}

// --- buffered (non-streaming) response builders ---

func openAIMessageResponse(id, model string, created int64, text string, promptTokens, completionTokens int) map[string]interface{} {
	return map[string]interface{}{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []map[string]interface{}{
			{
				"index":         0,
				"message":       map[string]interface{}{"role": "assistant", "content": text},
				"finish_reason": "stop",
			},
		},
		"usage": openAIUsage(promptTokens, completionTokens),
	}
}

func openAIToolCallsResponse(id, model string, created int64, leadingText string, calls []parsedToolCall, promptTokens, completionTokens int) map[string]interface{} {
	toolCalls := make([]map[string]interface{}, 0, len(calls))
	for i, call := range calls {
		toolCalls = append(toolCalls, openAIToolCallObject(id, i, call))
	}
	message := map[string]interface{}{
		"role":       "assistant",
		"tool_calls": toolCalls,
	}
	// OpenAI uses content:null when only tool_calls are present.
	if leadingText != "" {
		message["content"] = leadingText
	} else {
		message["content"] = nil
	}
	return map[string]interface{}{
		"id":      id,
		"object":  "chat.completion",
		"created": created,
		"model":   model,
		"choices": []map[string]interface{}{
			{
				"index":         0,
				"message":       message,
				"finish_reason": "tool_calls",
			},
		},
		"usage": openAIUsage(promptTokens, completionTokens),
	}
}

// openAIToolCallObject builds one tool_calls entry. arguments is a JSON *string*
// per the OpenAI function-calling contract.
func openAIToolCallObject(id string, index int, call parsedToolCall) map[string]interface{} {
	input := call.Input
	if input == nil {
		input = map[string]interface{}{}
	}
	argBytes, err := json.Marshal(input)
	if err != nil {
		argBytes = []byte("{}")
	}
	return map[string]interface{}{
		"id":   openAIToolCallID(id, index),
		"type": "function",
		"function": map[string]interface{}{
			"name":      call.Name,
			"arguments": string(argBytes),
		},
	}
}

func openAIToolCallID(id string, index int) string {
	return fmt.Sprintf("call_%s_%d", strings.TrimPrefix(id, "chatcmpl_"), index)
}

func openAIUsage(promptTokens, completionTokens int) map[string]interface{} {
	return map[string]interface{}{
		"prompt_tokens":     promptTokens,
		"completion_tokens": completionTokens,
		"total_tokens":      promptTokens + completionTokens,
	}
}

func openAIErrorBody(errType, message string) map[string]interface{} {
	return map[string]interface{}{
		"error": map[string]interface{}{
			"type":    errType,
			"message": message,
			"code":    nil,
			"param":   nil,
		},
	}
}
