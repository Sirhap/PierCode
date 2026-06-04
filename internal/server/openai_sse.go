package server

import (
	"encoding/json"
)

// OpenAI Chat Completions streaming (SSE) for the impersonation handler.
//
// Unlike Anthropic's named events, OpenAI streams unnamed `data:` lines, each
// carrying a chat.completion.chunk, and ends with a literal `data: [DONE]`.
// Event shape:
//
//   chunk 1: choices[0].delta = {"role":"assistant"}            (role announce)
//   chunk N: choices[0].delta = {"content":"..."}               (text)
//        or: choices[0].delta = {"tool_calls":[...]}            (tool call)
//   final:   choices[0].delta = {}, finish_reason = stop|tool_calls
//   data: [DONE]
//
// The browser AI returns its whole answer at once, so we replay it as a small
// number of chunks. Keepalive chunks (empty delta) flow before the answer lands
// so an OpenAI client's silence timeout does not abort the long page round-trip
// — the same fix applied to the Anthropic path's ping events.

// raw writes a verbatim SSE data line. OpenAI streams have no `event:` field.
func (w *sseWriter) raw(data string) {
	if w.failed {
		return
	}
	if _, err := w.c.Writer.WriteString("data: " + data + "\n\n"); err != nil {
		w.failed = true
		return
	}
	if w.flusher != nil {
		w.flusher.Flush()
	}
}

func (w *sseWriter) openAIChunk(chunk map[string]interface{}) {
	if w.failed {
		return
	}
	payload, err := json.Marshal(chunk)
	if err != nil {
		w.failed = true
		return
	}
	w.raw(string(payload))
}

func openAIChunkBase(id, model string, created int64) map[string]interface{} {
	return map[string]interface{}{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
	}
}

// openAIRoleChunk emits the opening chunk announcing the assistant role. Sent
// before the browser AI answers so bytes are on the wire immediately.
func (w *sseWriter) openAIRoleChunk(id, model string, created int64) {
	base := openAIChunkBase(id, model, created)
	base["choices"] = []map[string]interface{}{
		{
			"index":         0,
			"delta":         map[string]interface{}{"role": "assistant"},
			"finish_reason": nil,
		},
	}
	w.openAIChunk(base)
}

// openAIKeepalive emits an empty-delta chunk to keep the connection warm while
// the browser AI is still thinking.
func (w *sseWriter) openAIKeepalive() {
	base := openAIChunkBase("keepalive", "", 0)
	base["choices"] = []map[string]interface{}{
		{"index": 0, "delta": map[string]interface{}{}, "finish_reason": nil},
	}
	w.openAIChunk(base)
}

// openAITextDelta emits one content delta chunk.
func (w *sseWriter) openAITextDelta(id, model string, created int64, text string) {
	base := openAIChunkBase(id, model, created)
	base["choices"] = []map[string]interface{}{
		{
			"index":         0,
			"delta":         map[string]interface{}{"content": text},
			"finish_reason": nil,
		},
	}
	w.openAIChunk(base)
}

// openAIToolCallsDelta emits the tool_calls in a single delta chunk. Each entry
// carries its index, id, and function.{name,arguments} with arguments as a JSON
// string per the OpenAI contract.
func (w *sseWriter) openAIToolCallsDelta(id, model string, created int64, callIDSeed string, calls []parsedToolCall) {
	toolCalls := make([]map[string]interface{}, 0, len(calls))
	for i, call := range calls {
		obj := openAIToolCallObject(callIDSeed, i, call)
		obj["index"] = i
		toolCalls = append(toolCalls, obj)
	}
	base := openAIChunkBase(id, model, created)
	base["choices"] = []map[string]interface{}{
		{
			"index":         0,
			"delta":         map[string]interface{}{"tool_calls": toolCalls},
			"finish_reason": nil,
		},
	}
	w.openAIChunk(base)
}

// openAIFinish emits the terminal chunk (empty delta + finish_reason) followed
// by the literal [DONE] sentinel.
func (w *sseWriter) openAIFinish(id, model string, created int64, finishReason string) {
	base := openAIChunkBase(id, model, created)
	base["choices"] = []map[string]interface{}{
		{
			"index":         0,
			"delta":         map[string]interface{}{},
			"finish_reason": finishReason,
		},
	}
	w.openAIChunk(base)
	w.raw("[DONE]")
}
