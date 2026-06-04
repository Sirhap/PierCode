package server

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Anthropic Messages API streaming (SSE) for the impersonation handler.
//
// The browser AI returns its whole answer at once, but Claude Code defaults to
// stream:true and expects the Anthropic event sequence. We therefore replay the
// buffered answer as a well-formed SSE stream. Event order mirrors the real
// API:
//
//   text turn:
//     message_start
//     content_block_start (text)
//     content_block_delta (text_delta) ...
//     content_block_stop
//     message_delta (stop_reason=end_turn)
//     message_stop
//
//   tool_use turn (optionally preceded by a text block):
//     message_start
//     [content_block_start/delta/stop for a leading text block]
//     content_block_start (tool_use) / content_block_delta (input_json_delta) / content_block_stop  (per call)
//     message_delta (stop_reason=tool_use)
//     message_stop

type sseWriter struct {
	c       *gin.Context
	flusher http.Flusher
	failed  bool
}

func newSSEWriter(c *gin.Context) *sseWriter {
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.WriteHeader(http.StatusOK)
	fl, _ := c.Writer.(http.Flusher)
	w := &sseWriter{c: c, flusher: fl}
	if fl != nil {
		fl.Flush()
	}
	return w
}

func (w *sseWriter) event(name string, data interface{}) {
	if w.failed {
		return
	}
	payload, err := json.Marshal(data)
	if err != nil {
		w.failed = true
		return
	}
	if _, err := w.c.Writer.WriteString("event: " + name + "\ndata: "); err != nil {
		w.failed = true
		return
	}
	if _, err := w.c.Writer.Write(payload); err != nil {
		w.failed = true
		return
	}
	if _, err := w.c.Writer.WriteString("\n\n"); err != nil {
		w.failed = true
		return
	}
	if w.flusher != nil {
		w.flusher.Flush()
	}
}

// ping emits a comment-style keepalive. The real Anthropic API sends periodic
// `ping` events while a turn is in flight; Claude Code tolerates silence only
// for ~60s, but the browser AI routinely takes longer, so we must keep bytes
// flowing on the wire until the page answers.
func (w *sseWriter) ping() {
	w.event("ping", map[string]interface{}{"type": "ping"})
}

func (w *sseWriter) messageStart(id, model string, inputTokens int) {
	w.event("message_start", map[string]interface{}{
		"type": "message_start",
		"message": map[string]interface{}{
			"id":            id,
			"type":          "message",
			"role":          "assistant",
			"model":         model,
			"content":       []interface{}{},
			"stop_reason":   nil,
			"stop_sequence": nil,
			"usage": map[string]interface{}{
				"input_tokens":  inputTokens,
				"output_tokens": 0,
			},
		},
	})
}

func (w *sseWriter) messageStop(stopReason string, outputTokens int) {
	w.event("message_delta", map[string]interface{}{
		"type": "message_delta",
		"delta": map[string]interface{}{
			"stop_reason":   stopReason,
			"stop_sequence": nil,
		},
		"usage": map[string]interface{}{"output_tokens": outputTokens},
	})
	w.event("message_stop", map[string]interface{}{"type": "message_stop"})
}

// textBlock emits one content block of type text at the given index.
func (w *sseWriter) textBlock(index int, text string) {
	w.event("content_block_start", map[string]interface{}{
		"type":          "content_block_start",
		"index":         index,
		"content_block": map[string]interface{}{"type": "text", "text": ""},
	})
	// One delta is enough for correctness. Chunking would only affect cosmetics.
	w.event("content_block_delta", map[string]interface{}{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]interface{}{"type": "text_delta", "text": text},
	})
	w.event("content_block_stop", map[string]interface{}{
		"type":  "content_block_stop",
		"index": index,
	})
}

// toolUseBlock emits one content block of type tool_use at the given index.
func (w *sseWriter) toolUseBlock(index int, id, name string, input map[string]interface{}) {
	w.event("content_block_start", map[string]interface{}{
		"type":  "content_block_start",
		"index": index,
		"content_block": map[string]interface{}{
			"type":  "tool_use",
			"id":    id,
			"name":  name,
			"input": map[string]interface{}{},
		},
	})
	partial, err := json.Marshal(input)
	if err != nil {
		partial = []byte("{}")
	}
	w.event("content_block_delta", map[string]interface{}{
		"type":  "content_block_delta",
		"index": index,
		"delta": map[string]interface{}{"type": "input_json_delta", "partial_json": string(partial)},
	})
	w.event("content_block_stop", map[string]interface{}{
		"type":  "content_block_stop",
		"index": index,
	})
}

// streamTextBody replays a plain text answer as SSE content blocks. The caller
// must have already emitted message_start (so keepalive pings can flow before
// the browser AI answers).
func streamTextBody(w *sseWriter, text string) {
	w.textBlock(0, text)
	w.messageStop("end_turn", estimateTokens(text))
}

// streamToolUseBody replays a tool-calling answer as SSE content blocks, with an
// optional leading text block for any prose the page emitted before the calls.
// The caller must have already emitted message_start.
func streamToolUseBody(w *sseWriter, id string, leadingText string, calls []parsedToolCall) {
	index := 0
	outTokens := 0
	if leadingText != "" {
		w.textBlock(index, leadingText)
		outTokens += estimateTokens(leadingText)
		index++
	}
	for i, call := range calls {
		w.toolUseBlock(index, toolUseID(id, i), call.Name, call.Input)
		index++
	}
	if outTokens < 1 {
		outTokens = 1
	}
	w.messageStop("tool_use", outTokens)
}
