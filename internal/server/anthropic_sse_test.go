package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/sirhap/piercode/internal/tool"
)

// parseSSE splits a raw SSE body into (eventName, dataJSON) pairs in order.
func parseSSE(t *testing.T, body string) [][2]string {
	t.Helper()
	var out [][2]string
	for _, block := range strings.Split(strings.TrimSpace(body), "\n\n") {
		var name, data string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "event: ") {
				name = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		if name != "" {
			out = append(out, [2]string{name, data})
		}
	}
	return out
}

func eventNames(events [][2]string) []string {
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e[0]
	}
	return names
}

func TestStreamTextResponseSequence(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	sw := newSSEWriter(c)
	sw.messageStart("msg_1", "m", 5)
	streamTextBody(sw, "hello world")

	events := parseSSE(t, w.Body.String())
	want := []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}
	got := eventNames(events)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", got, want)
	}
	// message_delta must carry stop_reason end_turn.
	for _, e := range events {
		if e[0] == "message_delta" {
			if !strings.Contains(e[1], `"stop_reason":"end_turn"`) {
				t.Fatalf("message_delta missing end_turn: %s", e[1])
			}
		}
		if e[0] == "content_block_delta" && !strings.Contains(e[1], "hello world") {
			t.Fatalf("text delta missing payload: %s", e[1])
		}
	}
}

func TestStreamToolUseResponseSequence(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	sw := newSSEWriter(c)
	calls := []parsedToolCall{{Name: "Read", Input: map[string]interface{}{"file_path": "go.mod"}}}
	sw.messageStart("msg_1", "m", 9)
	streamToolUseBody(sw, "msg_1", "let me read it", calls)

	events := parseSSE(t, w.Body.String())
	got := eventNames(events)
	// message_start, [text block x3], [tool_use block x3], message_delta, message_stop
	want := []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_stop", // leading text
		"content_block_start", "content_block_delta", "content_block_stop", // tool_use
		"message_delta", "message_stop",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("event order = %v, want %v", got, want)
	}
	var sawToolUse, sawInputDelta, sawStopReason bool
	for _, e := range events {
		if strings.Contains(e[1], `"type":"tool_use"`) && strings.Contains(e[1], `"name":"Read"`) {
			sawToolUse = true
		}
		if strings.Contains(e[1], "input_json_delta") && strings.Contains(e[1], "go.mod") {
			sawInputDelta = true
		}
		if e[0] == "message_delta" && strings.Contains(e[1], `"stop_reason":"tool_use"`) {
			sawStopReason = true
		}
	}
	if !sawToolUse || !sawInputDelta || !sawStopReason {
		t.Fatalf("tool_use stream incomplete: toolUse=%v inputDelta=%v stopReason=%v", sawToolUse, sawInputDelta, sawStopReason)
	}
}

// stubWebAI wires the executor so ask_web_ai resolves and returns the canned
// reply, simulating a connected browser AI page.
func stubWebAI(s *Server, reply string) {
	s.executor.SetWebAIClientPicker(func(string) string { return "stub" })
	s.executor.SetClientBroadcaster(func(_ string, payload []byte) bool {
		var msg struct {
			QueryID string `json:"query_id"`
		}
		_ = json.Unmarshal(payload, &msg)
		go tool.PendingWebAIQueries.Deliver(msg.QueryID, tool.WebAIQueryResult{Text: reply})
		return true
	})
}

func postMessages(t *testing.T, s *Server, body map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)
	return w
}

func TestHandleAnthropicMessagesStreamingToolUse(t *testing.T) {
	s := testServer(t)
	reply := "I'll read it.\n```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	stubWebAI(s, reply)

	w := postMessages(t, s, map[string]interface{}{
		"model":  "claude-test",
		"stream": true,
		"tools":  []map[string]interface{}{{"name": "Read", "description": "read a file"}},
		"messages": []map[string]interface{}{
			{"role": "user", "content": "read go.mod"},
		},
	})

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want SSE", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, `"type":"tool_use"`) || !strings.Contains(body, `"name":"Read"`) {
		t.Fatalf("stream missing tool_use block:\n%s", body)
	}
	if !strings.Contains(body, `"stop_reason":"tool_use"`) {
		t.Fatalf("stream missing tool_use stop_reason:\n%s", body)
	}
}

func TestHandleAnthropicMessagesStreamingText(t *testing.T) {
	s := testServer(t)
	stubWebAI(s, "just a plain answer, no tools")

	w := postMessages(t, s, map[string]interface{}{
		"model":  "claude-test",
		"stream": true,
		"messages": []map[string]interface{}{
			{"role": "user", "content": "hi"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "text_delta") || !strings.Contains(body, "plain answer") {
		t.Fatalf("stream missing text block:\n%s", body)
	}
	if !strings.Contains(body, `"stop_reason":"end_turn"`) {
		t.Fatalf("stream missing end_turn:\n%s", body)
	}
}
