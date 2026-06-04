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

func TestFlattenAnthropicRequest(t *testing.T) {
	req := anthropicMessagesRequest{
		System: json.RawMessage(`"be terse"`),
		Messages: []anthropicMessage{
			{Role: "user", Content: json.RawMessage(`"hello"`)},
			{Role: "assistant", Content: json.RawMessage(`[{"type":"text","text":"hi there"}]`)},
			{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"second"},{"type":"image"}]`)},
		},
	}
	got, err := flattenAnthropicRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"System:\nbe terse", "User:\nhello", "Assistant:\nhi there", "second", "[image omitted]"} {
		if !strings.Contains(got, want) {
			t.Fatalf("flattened prompt missing %q\n---\n%s", want, got)
		}
	}
}

func TestFlattenAnthropicContentVariants(t *testing.T) {
	if got := flattenAnthropicContent(json.RawMessage(`null`), nil); got != "" {
		t.Fatalf("null content should be empty, got %q", got)
	}
	if got := flattenAnthropicContent(json.RawMessage(`"plain"`), nil); got != "plain" {
		t.Fatalf("string content, got %q", got)
	}
	toolResult := `[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"42"}]}]`
	if got := flattenAnthropicContent(json.RawMessage(toolResult), map[string]string{"toolu_1": "Read"}); !strings.Contains(got, "42") || !strings.Contains(got, "Tool Read result") {
		t.Fatalf("tool_result should survive with tool name label, got %q", got)
	}
}

func TestHandleAnthropicMessagesRoundTrip(t *testing.T) {
	s := testServer(t)

	// Simulate a connected browser AI page: the picker resolves any provider to
	// a fake client, and the broadcaster delivers a canned reply to whatever
	// query_id the ask_web_ai tool registered.
	var pickedProvider string
	s.executor.SetWebAIClientPicker(func(provider string) string {
		pickedProvider = provider
		return "fake-ai-page"
	})
	s.executor.SetClientBroadcaster(func(clientID string, payload []byte) bool {
		var msg struct {
			QueryID string `json:"query_id"`
		}
		_ = json.Unmarshal(payload, &msg)
		go tool.PendingWebAIQueries.Deliver(msg.QueryID, tool.WebAIQueryResult{
			Text:     "browser AI says hi",
			Provider: "Claude",
			URL:      "https://claude.ai/chat/abc",
		})
		return true
	})

	body, _ := json.Marshal(map[string]interface{}{
		"model":      "claude-test",
		"max_tokens": 64,
		"messages": []map[string]interface{}{
			{"role": "user", "content": "ping"},
		},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if pickedProvider != "Browser" {
		t.Fatalf("expected Anthropic bridge to target any browser AI by default, got provider %q", pickedProvider)
	}
	var resp struct {
		Type       string `json:"type"`
		Role       string `json:"role"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Type != "message" || resp.Role != "assistant" {
		t.Fatalf("bad envelope: %+v", resp)
	}
	if resp.StopReason != "end_turn" {
		t.Fatalf("stop_reason = %q", resp.StopReason)
	}
	if len(resp.Content) != 1 || resp.Content[0].Type != "text" {
		t.Fatalf("expected one text block, got %+v", resp.Content)
	}
	if resp.Content[0].Text != "browser AI says hi" {
		t.Fatalf("reply text = %q", resp.Content[0].Text)
	}
	if resp.Usage.OutputTokens < 1 {
		t.Fatalf("output_tokens should be >=1, got %d", resp.Usage.OutputTokens)
	}
}

func TestHandleAnthropicMessagesAcceptsApiKeyHeader(t *testing.T) {
	s := testServer(t)
	s.executor.SetWebAIClientPicker(func(string) string { return "fake" })
	s.executor.SetClientBroadcaster(func(_ string, payload []byte) bool {
		var msg struct {
			QueryID string `json:"query_id"`
		}
		_ = json.Unmarshal(payload, &msg)
		go tool.PendingWebAIQueries.Deliver(msg.QueryID, tool.WebAIQueryResult{Text: "ok"})
		return true
	})

	body, _ := json.Marshal(map[string]interface{}{
		"messages": []map[string]interface{}{{"role": "user", "content": "hi"}},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(body))
	req.Header.Set("x-api-key", "testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("x-api-key auth failed: %d %s", w.Code, w.Body.String())
	}
}

func TestHandleAnthropicMessagesNoBrowserClient(t *testing.T) {
	s := testServer(t)
	// No picker override → FindWebAIClient on an empty WS manager returns "",
	// so ask_web_ai fails fast.
	body, _ := json.Marshal(map[string]interface{}{
		"messages": []map[string]interface{}{{"role": "user", "content": "hi"}},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when no browser AI, got %d: %s", w.Code, w.Body.String())
	}
	var errResp struct {
		Type  string `json:"type"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &errResp)
	if errResp.Type != "error" || !strings.Contains(errResp.Error.Message, "no connected browser AI") {
		t.Fatalf("unexpected error body: %s", w.Body.String())
	}
}
