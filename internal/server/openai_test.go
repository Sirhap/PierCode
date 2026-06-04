package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestFlattenOpenAIRequest(t *testing.T) {
	req := openAIChatRequest{
		Messages: []openAIMessage{
			{Role: "system", Content: json.RawMessage(`"be terse"`)},
			{Role: "user", Content: json.RawMessage(`"hello"`)},
			{Role: "assistant", Content: json.RawMessage(`[{"type":"text","text":"hi there"}]`)},
			{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"second"},{"type":"image_url"}]`)},
			{Role: "tool", Name: "Read", Content: json.RawMessage(`"42"`)},
		},
	}
	got, err := flattenOpenAIRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"System:\nbe terse", "User:\nhello", "Assistant:\nhi there", "second", "[image omitted]", "Tool Read result:\n42"} {
		if !strings.Contains(got, want) {
			t.Fatalf("flattened prompt missing %q\n---\n%s", want, got)
		}
	}
}

func TestFlattenOpenAIToolCallsSummary(t *testing.T) {
	req := openAIChatRequest{
		Messages: []openAIMessage{
			{Role: "assistant", ToolCalls: json.RawMessage(`[{"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\"file_path\":\"go.mod\"}"}}]`)},
		},
	}
	got, err := flattenOpenAIRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "[called tool Read with {\"file_path\":\"go.mod\"}]") {
		t.Fatalf("tool_calls summary missing, got %q", got)
	}
}

// stubOpenAIWebAI wires the executor so ask_web_ai resolves to a fake page and
// returns the canned reply.
func stubOpenAIWebAI(s *Server, reply string) {
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

func postChat(t *testing.T, s *Server, body map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)
	return w
}

func TestHandleOpenAIChatCompletionsText(t *testing.T) {
	s := testServer(t)
	stubOpenAIWebAI(s, "browser AI says hi")

	w := postChat(t, s, map[string]interface{}{
		"model": "gpt-test",
		"messages": []map[string]interface{}{
			{"role": "user", "content": "ping"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Object != "chat.completion" {
		t.Fatalf("object = %q", resp.Object)
	}
	if len(resp.Choices) != 1 || resp.Choices[0].Message.Role != "assistant" {
		t.Fatalf("bad choices: %+v", resp.Choices)
	}
	if resp.Choices[0].Message.Content != "browser AI says hi" {
		t.Fatalf("content = %q", resp.Choices[0].Message.Content)
	}
	if resp.Choices[0].FinishReason != "stop" {
		t.Fatalf("finish_reason = %q", resp.Choices[0].FinishReason)
	}
	if resp.Usage.TotalTokens < 1 {
		t.Fatalf("total_tokens should be >=1, got %d", resp.Usage.TotalTokens)
	}
}

func TestHandleOpenAIChatCompletionsToolCalls(t *testing.T) {
	s := testServer(t)
	reply := "I'll read it.\n```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	stubOpenAIWebAI(s, reply)

	w := postChat(t, s, map[string]interface{}{
		"model": "gpt-test",
		"tools": []map[string]interface{}{
			{"type": "function", "function": map[string]interface{}{"name": "Read", "description": "read a file"}},
		},
		"messages": []map[string]interface{}{
			{"role": "user", "content": "read go.mod"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Choices []struct {
			Message struct {
				ToolCalls []struct {
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Choices) != 1 || resp.Choices[0].FinishReason != "tool_calls" {
		t.Fatalf("expected tool_calls finish, got %+v", resp.Choices)
	}
	tc := resp.Choices[0].Message.ToolCalls
	if len(tc) != 1 || tc[0].Type != "function" || tc[0].Function.Name != "Read" {
		t.Fatalf("bad tool_calls: %+v", tc)
	}
	// arguments must be a JSON *string*.
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(tc[0].Function.Arguments), &args); err != nil {
		t.Fatalf("arguments not valid JSON string: %q", tc[0].Function.Arguments)
	}
	if args["file_path"] != "go.mod" {
		t.Fatalf("arguments missing file_path: %v", args)
	}
}

func TestHandleOpenAIChatCompletionsStreamingText(t *testing.T) {
	s := testServer(t)
	stubOpenAIWebAI(s, "just a plain answer, no tools")

	w := postChat(t, s, map[string]interface{}{
		"model":  "gpt-test",
		"stream": true,
		"messages": []map[string]interface{}{
			{"role": "user", "content": "hi"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want SSE", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "chat.completion.chunk") {
		t.Fatalf("stream missing chunk object:\n%s", body)
	}
	if !strings.Contains(body, `"role":"assistant"`) {
		t.Fatalf("stream missing role chunk:\n%s", body)
	}
	if !strings.Contains(body, "plain answer") {
		t.Fatalf("stream missing content delta:\n%s", body)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) {
		t.Fatalf("stream missing stop finish_reason:\n%s", body)
	}
	if !strings.HasSuffix(strings.TrimSpace(body), "data: [DONE]") {
		t.Fatalf("stream must end with [DONE]:\n%s", body)
	}
}

func TestHandleOpenAIChatCompletionsStreamingToolCalls(t *testing.T) {
	s := testServer(t)
	reply := "```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	stubOpenAIWebAI(s, reply)

	w := postChat(t, s, map[string]interface{}{
		"model":  "gpt-test",
		"stream": true,
		"tools": []map[string]interface{}{
			{"type": "function", "function": map[string]interface{}{"name": "Read"}},
		},
		"messages": []map[string]interface{}{
			{"role": "user", "content": "read go.mod"},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"tool_calls"`) || !strings.Contains(body, `"name":"Read"`) {
		t.Fatalf("stream missing tool_calls:\n%s", body)
	}
	if !strings.Contains(body, `"finish_reason":"tool_calls"`) {
		t.Fatalf("stream missing tool_calls finish_reason:\n%s", body)
	}
}

func TestHandleOpenAIChatCompletionsAcceptsBearer(t *testing.T) {
	s := testServer(t)
	stubOpenAIWebAI(s, "ok")
	w := postChat(t, s, map[string]interface{}{
		"messages": []map[string]interface{}{{"role": "user", "content": "hi"}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("bearer auth failed: %d %s", w.Code, w.Body.String())
	}
}

func TestHandleOpenAIChatCompletionsNoBrowserClient(t *testing.T) {
	s := testServer(t)
	w := postChat(t, s, map[string]interface{}{
		"messages": []map[string]interface{}{{"role": "user", "content": "hi"}},
	})
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when no browser AI, got %d: %s", w.Code, w.Body.String())
	}
	var errResp struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &errResp)
	if !strings.Contains(errResp.Error.Message, "no connected browser AI") {
		t.Fatalf("unexpected error body: %s", w.Body.String())
	}
}
