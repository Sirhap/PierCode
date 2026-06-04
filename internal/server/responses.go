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

// The "Codex / OpenAI Responses client → Go → browser AI" bridge.
//
// Modern Codex (>=0.137) speaks ONLY the OpenAI Responses API; the Chat
// Completions wire_api was removed. This handler impersonates POST /v1/responses:
// it flattens the request (instructions + input[] items) into one prompt,
// forwards it through ask_web_ai to the browser AI page, and re-encodes the
// reply as Responses SSE events — a message turn or, when the page emits a
// piercode-call block, a function_call turn.
//
// Reused from the other impersonation layers: parseToolCalls /
// buildToolProtocolPreamble (provider-agnostic page-facing contract),
// estimateTokens, previewString. Tool defs/results are summarized into the
// prompt the same way the Anthropic/Chat layers do.
//
// Captured contract (real codex 0.137):
//   request : {model, instructions, input:[{type:"message",role,content:[{type:"input_text",text}]}|
//                                          {type:"function_call",name,arguments,call_id}|
//                                          {type:"function_call_output",call_id,output}], tools:[{type:"function",name,...}], stream:true}
//   response: SSE response.created → response.output_item.added →
//             (response.output_text.delta|response.function_call_arguments.delta) →
//             *.done → response.output_item.done → response.completed
//
// Keepalive: like the Anthropic ping path, we open the stream and emit
// response.created before the browser AI answers so codex does not abort during
// the long page round-trip.

type responsesInputItem struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	// function_call
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	CallID    string `json:"call_id"`
	// function_call_output
	Output json.RawMessage `json:"output"`
}

type responsesToolDef struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type responsesRequest struct {
	Model        string             `json:"model"`
	Instructions string             `json:"instructions"`
	Input        json.RawMessage    `json:"input"`
	Tools        []responsesToolDef `json:"tools"`
	Stream       bool               `json:"stream"`
}

// handleOpenAIResponses impersonates POST /v1/responses.
func (s *Server) handleOpenAIResponses(c *gin.Context) {
	var req responsesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", "invalid request body: "+err.Error()))
		return
	}

	prompt, err := flattenResponsesRequest(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", err.Error()))
		return
	}
	if strings.TrimSpace(prompt) == "" {
		c.JSON(http.StatusBadRequest, openAIErrorBody("invalid_request_error", "no text content in input"))
		return
	}

	if preamble := buildToolProtocolPreamble(responsesToolsToShared(req.Tools)); preamble != "" {
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

	respID := fmt.Sprintf("resp_%d", time.Now().UnixNano())
	execReq := &types.ToolRequest{Name: "ask_web_ai", CallID: respID, Args: args}

	model := req.Model
	if model == "" {
		model = "piercode-web-ai"
	}
	promptTokens := estimateTokens(prompt)

	log.Printf("[responses] /v1/responses model=%q stream=%v tools=%d prompt_bytes=%d prompt_tokens~=%d preview=%q",
		req.Model, req.Stream, len(req.Tools), len(prompt), promptTokens, previewString(prompt, 200))

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second+30*time.Second)
	defer cancel()

	// Streaming path (codex default): open SSE + keepalive before the page answers.
	if req.Stream {
		w := newSSEWriter(c)
		w.responsesCreated(respID, model)

		done := make(chan *types.ToolResponse, 1)
		go func() { done <- s.executor.ExecuteWithStream(ctx, execReq, func(string, string) {}) }()

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
				w.responsesPing(respID)
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
			w.responsesMessage(respID, model, "[piercode] web AI error: "+msg, promptTokens)
			return
		}
		text := strings.TrimSpace(resp.Output)
		if text == "" {
			w.responsesMessage(respID, model, "[piercode] web AI returned an empty response", promptTokens)
			return
		}

		calls, leadingText, hasCalls := parseToolCalls(text)
		if hasCalls {
			w.responsesFunctionCalls(respID, model, leadingText, calls, promptTokens)
		} else {
			w.responsesMessage(respID, model, text, promptTokens)
		}
		return
	}

	// Non-streaming: one buffered response object.
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
	if hasCalls {
		c.JSON(http.StatusOK, responsesFunctionCallObject(respID, model, leadingText, calls, promptTokens))
		return
	}
	c.JSON(http.StatusOK, responsesMessageObject(respID, model, text, promptTokens))
}

func responsesToolsToShared(tools []responsesToolDef) []anthropicToolDef {
	if len(tools) == 0 {
		return nil
	}
	out := make([]anthropicToolDef, 0, len(tools))
	for _, t := range tools {
		if strings.TrimSpace(t.Name) == "" {
			continue
		}
		out = append(out, anthropicToolDef{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.Parameters,
		})
	}
	return out
}

// flattenResponsesRequest collapses instructions + input[] into one prompt.
func flattenResponsesRequest(req responsesRequest) (string, error) {
	var b strings.Builder
	if instr := strings.TrimSpace(req.Instructions); instr != "" {
		b.WriteString("System:\n")
		b.WriteString(instr)
		b.WriteString("\n\n")
	}

	if len(req.Input) > 0 {
		var items []responsesInputItem
		if err := json.Unmarshal(req.Input, &items); err != nil {
			// Input can also be a bare string in the Responses API.
			var asString string
			if err2 := json.Unmarshal(req.Input, &asString); err2 == nil {
				if s := strings.TrimSpace(asString); s != "" {
					b.WriteString("User:\n")
					b.WriteString(s)
					b.WriteString("\n\n")
				}
				return strings.TrimSpace(b.String()), nil
			}
			return "", fmt.Errorf("invalid input: %v", err)
		}
		for _, it := range items {
			switch it.Type {
			case "message", "":
				text := flattenResponsesContent(it.Content)
				if text == "" {
					continue
				}
				switch strings.TrimSpace(it.Role) {
				case "system", "developer":
					b.WriteString("System:\n")
				case "assistant":
					b.WriteString("Assistant:\n")
				case "user":
					b.WriteString("User:\n")
				default:
					b.WriteString("User:\n")
				}
				b.WriteString(text)
				b.WriteString("\n\n")
			case "function_call":
				summary := "[called tool"
				if it.Name != "" {
					summary += " " + it.Name
				}
				if args := strings.TrimSpace(it.Arguments); args != "" {
					summary += " with " + args
				}
				summary += "]"
				b.WriteString("Assistant:\n")
				b.WriteString(summary)
				b.WriteString("\n\n")
			case "function_call_output":
				out := flattenResponsesOutput(it.Output)
				if out == "" {
					continue
				}
				b.WriteString("Tool result:\n")
				b.WriteString(out)
				b.WriteString("\n\n")
			}
		}
	}
	return strings.TrimSpace(b.String()), nil
}

// flattenResponsesContent handles input/output_text content parts (or a bare
// string).
func flattenResponsesContent(raw json.RawMessage) string {
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
		case "input_text", "output_text", "text":
			var s string
			if t, ok := p["text"]; ok {
				_ = json.Unmarshal(t, &s)
			}
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		case "input_image", "image":
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

// flattenResponsesOutput renders a function_call_output's output, which may be a
// plain string or structured content.
func flattenResponsesOutput(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	return flattenResponsesContent(raw)
}

// --- buffered (non-streaming) response objects ---

func responsesMessageObject(id, model, text string, promptTokens int) map[string]interface{} {
	return map[string]interface{}{
		"id":     id,
		"object": "response",
		"model":  model,
		"status": "completed",
		"output": []map[string]interface{}{
			{
				"type":    "message",
				"id":      responsesItemID(id, 0),
				"role":    "assistant",
				"status":  "completed",
				"content": []map[string]interface{}{{"type": "output_text", "text": text}},
			},
		},
		"usage": responsesUsage(promptTokens, estimateTokens(text)),
	}
}

func responsesFunctionCallObject(id, model, leadingText string, calls []parsedToolCall, promptTokens int) map[string]interface{} {
	output := make([]map[string]interface{}, 0, len(calls)+1)
	outTokens := 0
	if leadingText != "" {
		output = append(output, map[string]interface{}{
			"type":    "message",
			"id":      responsesItemID(id, 0),
			"role":    "assistant",
			"status":  "completed",
			"content": []map[string]interface{}{{"type": "output_text", "text": leadingText}},
		})
		outTokens += estimateTokens(leadingText)
	}
	for i, call := range calls {
		args := responsesArgsString(call)
		output = append(output, map[string]interface{}{
			"type":      "function_call",
			"id":        responsesItemID(id, i+1),
			"call_id":   responsesCallID(id, i),
			"name":      call.Name,
			"arguments": args,
			"status":    "completed",
		})
		outTokens += estimateTokens(args)
	}
	if outTokens < 1 {
		outTokens = 1
	}
	return map[string]interface{}{
		"id":     id,
		"object": "response",
		"model":  model,
		"status": "completed",
		"output": output,
		"usage":  responsesUsage(promptTokens, outTokens),
	}
}

// responsesArgsString marshals a parsed tool call's input to a JSON string
// (Responses function_call arguments are a JSON string, like Chat).
func responsesArgsString(call parsedToolCall) string {
	input := call.Input
	if input == nil {
		input = map[string]interface{}{}
	}
	b, err := json.Marshal(input)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func responsesItemID(id string, index int) string {
	return fmt.Sprintf("item_%s_%d", strings.TrimPrefix(id, "resp_"), index)
}

func responsesCallID(id string, index int) string {
	return fmt.Sprintf("call_%s_%d", strings.TrimPrefix(id, "resp_"), index)
}

func responsesUsage(inputTokens, outputTokens int) map[string]interface{} {
	return map[string]interface{}{
		"input_tokens":  inputTokens,
		"output_tokens": outputTokens,
		"total_tokens":  inputTokens + outputTokens,
	}
}
