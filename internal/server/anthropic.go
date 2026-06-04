package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/sirhap/piercode/internal/types"
)

// The "Claude Code → Go → browser AI" bridge.
//
// Claude Code talks to whatever ANTHROPIC_BASE_URL points at, speaking the
// Anthropic Messages API. This handler impersonates that API: it accepts POST
// /v1/messages, flattens the request into a single prompt, forwards it through
// the existing ask_web_ai tool (Go → WebSocket → extension → browser AI page),
// and re-encodes the page's reply as an Anthropic Message — either a plain text
// turn or, when the page emits a tool-call block, a tool_use turn.
//
// Two response transports:
//   - stream:true (Claude Code's default) → Server-Sent Events (anthropic_sse.go)
//   - stream:false → one buffered JSON Message (kept for tests / simple clients)
//
// tool_use translation (anthropic_tooltrans.go): the request's tools[] are
// advertised to the page via a protocol preamble; the page's reply is parsed
// for a ```piercode-call``` block and converted back into tool_use. When no
// tool call is found we fall back to a text turn, so a chatty page never breaks
// the stream.

type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type anthropicMessagesRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    json.RawMessage    `json:"system"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicToolDef `json:"tools"`
	Stream    bool               `json:"stream"`
	Metadata  json.RawMessage    `json:"metadata"`
}

// handleAnthropicMessages impersonates POST /v1/messages.
func (s *Server) handleAnthropicMessages(c *gin.Context) {
	var req anthropicMessagesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, anthropicErrorBody("invalid_request_error", "invalid request body: "+err.Error()))
		return
	}

	prompt, err := flattenAnthropicRequest(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, anthropicErrorBody("invalid_request_error", err.Error()))
		return
	}
	if strings.TrimSpace(prompt) == "" {
		c.JSON(http.StatusBadRequest, anthropicErrorBody("invalid_request_error", "no text content in messages"))
		return
	}

	// Advertise the tools so the page knows it is acting as a tool-using API
	// backend and how to emit a tool call.
	if preamble := buildToolProtocolPreamble(req.Tools); preamble != "" {
		prompt += preamble
	}

	// Reuse the ask_web_ai path. Provider/timeout come from query params so the
	// caller can steer which browser AI answers without touching the Anthropic
	// request body (Claude Code controls the body, not us).
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

	msgID := fmt.Sprintf("msg_anthropic_%d", time.Now().UnixNano())
	execReq := &types.ToolRequest{
		Name:   "ask_web_ai",
		CallID: msgID,
		Args:   args,
	}

	model := req.Model
	if model == "" {
		model = "piercode-web-ai"
	}
	inputTokens := estimateTokens(prompt)

	// Log request shape so a stalled CLI run can be told apart from an oversized
	// prompt that the page never managed to ingest. The browser AI routinely
	// takes longer than Claude Code's ~60s silence tolerance, which is why the
	// streaming path below emits message_start + pings before the answer lands.
	log.Printf("[anthropic] /v1/messages model=%q stream=%v tools=%d prompt_bytes=%d prompt_tokens~=%d preview=%q",
		req.Model, req.Stream, len(req.Tools), len(prompt), inputTokens, previewString(prompt, 200))

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second+30*time.Second)
	defer cancel()

	// Streaming path: open the SSE stream and start the keepalive *before* the
	// browser AI answers, so Claude Code does not abort the connection during
	// the long page round-trip.
	if req.Stream {
		w := newSSEWriter(c)
		w.messageStart(msgID, model, inputTokens)
		w.ping()

		type execResult struct{ resp *types.ToolResponse }
		done := make(chan execResult, 1)
		go func() {
			done <- execResult{resp: s.executor.ExecuteWithStream(ctx, execReq, func(string, string) {})}
		}()

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		var resp *types.ToolResponse
	wait:
		for {
			select {
			case r := <-done:
				resp = r.resp
				break wait
			case <-ticker.C:
				w.ping()
			case <-c.Request.Context().Done():
				// Client (Claude Code) hung up; cancel the in-flight web AI query.
				cancel()
				<-done
				return
			}
		}

		if resp.Status == "error" || resp.Error != "" {
			// Stream already open with headers committed; surface the failure as a
			// text turn so Claude Code closes the turn cleanly instead of hanging.
			msg := resp.Error
			if msg == "" {
				msg = "web AI query failed"
			}
			streamTextBody(w, "[piercode] web AI error: "+msg)
			return
		}
		text := strings.TrimSpace(resp.Output)
		if text == "" {
			streamTextBody(w, "[piercode] web AI returned an empty response")
			return
		}

		calls, leadingText, hasCalls := parseToolCalls(text)
		if hasCalls {
			streamToolUseBody(w, msgID, leadingText, calls)
		} else {
			streamTextBody(w, text)
		}
		return
	}

	// Non-streaming: one buffered JSON Message.
	resp := s.executor.ExecuteWithStream(ctx, execReq, func(string, string) {})
	if resp.Status == "error" || resp.Error != "" {
		msg := resp.Error
		if msg == "" {
			msg = "web AI query failed"
		}
		c.JSON(http.StatusBadGateway, anthropicErrorBody("api_error", msg))
		return
	}

	text := strings.TrimSpace(resp.Output)
	if text == "" {
		c.JSON(http.StatusBadGateway, anthropicErrorBody("api_error", "web AI returned an empty response"))
		return
	}

	calls, leadingText, hasCalls := parseToolCalls(text)
	if hasCalls {
		c.JSON(http.StatusOK, anthropicToolUseResponse(msgID, model, leadingText, calls, inputTokens))
		return
	}
	c.JSON(http.StatusOK, anthropicMessageResponse(msgID, model, prompt, text))
}

// previewString returns at most n runes of s with newlines collapsed, for logs.
func previewString(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// flattenAnthropicRequest collapses the structured Anthropic request — system
// prompt plus a messages array whose content may be a string or an array of
// typed blocks — into one plain-text prompt suitable for a browser AI input
// box. Lossy by design for step 1.
func flattenAnthropicRequest(req anthropicMessagesRequest) (string, error) {
	var b strings.Builder

	// Map tool_use ids → tool names so tool_result blocks (which only carry an
	// id) can be labelled with the tool that produced them.
	toolNames := collectToolUseNames(req.Messages)

	if sys := flattenAnthropicContent(req.System, toolNames); sys != "" {
		b.WriteString("System:\n")
		b.WriteString(sys)
		b.WriteString("\n\n")
	}

	for _, m := range req.Messages {
		text := flattenAnthropicContent(m.Content, toolNames)
		if text == "" {
			continue
		}
		role := strings.TrimSpace(m.Role)
		switch role {
		case "user":
			b.WriteString("User:\n")
		case "assistant":
			b.WriteString("Assistant:\n")
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

// collectToolUseNames scans every assistant message for tool_use blocks and
// records id→name, so a later tool_result (which references only the id) can be
// rendered with the originating tool's name.
func collectToolUseNames(messages []anthropicMessage) map[string]string {
	names := map[string]string{}
	for _, m := range messages {
		var blocks []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(strings.TrimSpace(string(m.Content))), &blocks); err != nil {
			continue
		}
		for _, blk := range blocks {
			var typ string
			if t, ok := blk["type"]; ok {
				_ = json.Unmarshal(t, &typ)
			}
			if typ != "tool_use" {
				continue
			}
			var id, name string
			if v, ok := blk["id"]; ok {
				_ = json.Unmarshal(v, &id)
			}
			if v, ok := blk["name"]; ok {
				_ = json.Unmarshal(v, &name)
			}
			if id != "" && name != "" {
				names[id] = name
			}
		}
	}
	return names
}

// flattenAnthropicContent accepts either a JSON string or a JSON array of
// content blocks and returns the concatenated text. Non-text blocks (images,
// tool_use, tool_result) are summarized rather than dropped silently so the
// browser AI at least sees that something was there. toolNames maps tool_use
// ids to tool names for labelling tool_result blocks.
func flattenAnthropicContent(raw json.RawMessage, toolNames map[string]string) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}

	// Case 1: plain string.
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}

	// Case 2: array of typed blocks.
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil {
		// Unknown shape — return the raw JSON so nothing is lost.
		return strings.TrimSpace(string(raw))
	}

	var parts []string
	for _, blk := range blocks {
		typ := ""
		if t, ok := blk["type"]; ok {
			_ = json.Unmarshal(t, &typ)
		}
		switch typ {
		case "text":
			var s string
			if t, ok := blk["text"]; ok {
				_ = json.Unmarshal(t, &s)
			}
			if s = strings.TrimSpace(s); s != "" {
				parts = append(parts, s)
			}
		case "tool_result":
			if t, ok := blk["content"]; ok {
				if s := flattenAnthropicContent(t, toolNames); s != "" {
					label := "Tool result"
					var useID string
					if v, ok := blk["tool_use_id"]; ok {
						_ = json.Unmarshal(v, &useID)
					}
					if name := toolNames[useID]; name != "" {
						label = "Tool " + name + " result"
					}
					parts = append(parts, label+":\n"+s)
				}
			}
		case "tool_use":
			var name string
			if v, ok := blk["name"]; ok {
				_ = json.Unmarshal(v, &name)
			}
			var input json.RawMessage
			if v, ok := blk["input"]; ok {
				input = v
			}
			summary := "[called tool"
			if name != "" {
				summary += " " + name
			}
			if len(input) > 0 {
				summary += " with " + string(input)
			}
			summary += "]"
			parts = append(parts, summary)
		case "image":
			parts = append(parts, "[image omitted]")
		default:
			parts = append(parts, strings.TrimSpace(string(blk["text"])))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func capitalizeRole(role string) string {
	if role == "" {
		return ""
	}
	r := []rune(role)
	r[0] = []rune(strings.ToUpper(string(r[0])))[0]
	return string(r)
}

func anthropicMessageResponse(id, model, prompt, text string) map[string]interface{} {
	return map[string]interface{}{
		"id":            id,
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"stop_reason":   "end_turn",
		"stop_sequence": nil,
		"content": []map[string]interface{}{
			{"type": "text", "text": text},
		},
		"usage": map[string]interface{}{
			"input_tokens":  estimateTokens(prompt),
			"output_tokens": estimateTokens(text),
		},
	}
}

// anthropicToolUseResponse builds a buffered (non-streaming) Message whose
// content is an optional leading text block followed by one tool_use block per
// parsed call, with stop_reason tool_use.
func anthropicToolUseResponse(id, model, leadingText string, calls []parsedToolCall, inputTokens int) map[string]interface{} {
	content := make([]map[string]interface{}, 0, len(calls)+1)
	outTokens := 0
	if leadingText != "" {
		content = append(content, map[string]interface{}{"type": "text", "text": leadingText})
		outTokens += estimateTokens(leadingText)
	}
	for i, call := range calls {
		input := call.Input
		if input == nil {
			input = map[string]interface{}{}
		}
		content = append(content, map[string]interface{}{
			"type":  "tool_use",
			"id":    toolUseID(id, i),
			"name":  call.Name,
			"input": input,
		})
	}
	if outTokens < 1 {
		outTokens = 1
	}
	return map[string]interface{}{
		"id":            id,
		"type":          "message",
		"role":          "assistant",
		"model":         model,
		"stop_reason":   "tool_use",
		"stop_sequence": nil,
		"content":       content,
		"usage": map[string]interface{}{
			"input_tokens":  inputTokens,
			"output_tokens": outTokens,
		},
	}
}

func anthropicErrorBody(errType, message string) map[string]interface{} {
	return map[string]interface{}{
		"type": "error",
		"error": map[string]interface{}{
			"type":    errType,
			"message": message,
		},
	}
}

// estimateTokens is a rough char-based proxy so usage fields are non-zero.
// Real token counts are irrelevant to the browser AI; Claude Code only reads
// these for display/accounting.
func estimateTokens(s string) int {
	n := utf8.RuneCountInString(s) / 4
	if n < 1 && len(s) > 0 {
		return 1
	}
	return n
}
