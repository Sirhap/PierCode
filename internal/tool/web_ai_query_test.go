package tool

import (
	"encoding/json"
	"testing"
)

func TestPendingWebAIQueriesDeliverOnce(t *testing.T) {
	callID := "web-ai-deliver-once"
	ch, cleanup := PendingWebAIQueries.Register(callID)
	defer cleanup()

	if !PendingWebAIQueries.Deliver(callID, WebAIQueryResult{Text: "answer", Provider: "Claude"}) {
		t.Fatalf("expected first delivery to be accepted")
	}
	if PendingWebAIQueries.Deliver(callID, WebAIQueryResult{Text: "duplicate"}) {
		t.Fatalf("expected duplicate delivery to be rejected")
	}

	got := <-ch
	if got.Text != "answer" {
		t.Fatalf("expected delivered answer, got %q", got.Text)
	}
	if got.Provider != "Claude" {
		t.Fatalf("expected provider to be preserved, got %q", got.Provider)
	}
}

func TestAskWebAIToolBroadcastsQueryAndWaitsForResult(t *testing.T) {
	broadcasts := make(chan []byte, 2)
	tool := NewAskWebAITool()

	go func() {
		payload := <-broadcasts
		var msg map[string]interface{}
		if err := json.Unmarshal(payload, &msg); err != nil {
			t.Errorf("broadcast payload was not JSON: %v", err)
			return
		}
		if msg["type"] != "ai_query" {
			t.Errorf("expected ai_query broadcast, got %v", msg["type"])
		}
		if msg["query_id"] != "call-web-ai" {
			t.Errorf("expected query_id from call_id, got %v", msg["query_id"])
		}
		if msg["provider"] != "Qwen" {
			t.Errorf("expected provider Qwen, got %v", msg["provider"])
		}
		if msg["text"] != "review this design" {
			t.Errorf("expected prompt text, got %v", msg["text"])
		}
		PendingWebAIQueries.Deliver("call-web-ai", WebAIQueryResult{
			Text:     "second model says OK",
			Provider: "Qwen",
			URL:      "https://qwen.ai/chat/abc",
		})
	}()

	res := tool.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":     "call-web-ai",
			"prompt":      "review this design",
			"provider":    "Qwen",
			"timeout_sec": float64(2),
		},
		Broadcast: func(payload []byte) {
			broadcasts <- payload
		},
	})

	if res.Status != "success" {
		t.Fatalf("expected success, got status=%s error=%s output=%s", res.Status, res.Error, res.Output)
	}
	if res.Output == "" || !containsAll(res.Output, "Qwen", "second model says OK", "https://qwen.ai/chat/abc") {
		t.Fatalf("expected provider, url, and answer in output, got %q", res.Output)
	}
}

func TestAskWebAIToolCancelsPendingQueryOnTimeout(t *testing.T) {
	broadcasts := make(chan []byte, 2)
	tool := NewAskWebAITool()

	res := tool.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":     "call-web-ai-timeout",
			"prompt":      "slow question",
			"provider":    "Claude",
			"timeout_sec": float64(0.01),
		},
		Broadcast: func(payload []byte) {
			broadcasts <- payload
		},
	})

	if res.Status != "error" {
		t.Fatalf("expected timeout error, got status=%s output=%s", res.Status, res.Output)
	}

	first := decodeBroadcast(t, <-broadcasts)
	if first["type"] != "ai_query" {
		t.Fatalf("expected first broadcast to be ai_query, got %v", first["type"])
	}
	second := decodeBroadcast(t, <-broadcasts)
	if second["type"] != "ai_query_cancel" {
		t.Fatalf("expected timeout to broadcast ai_query_cancel, got %v", second["type"])
	}
	if second["query_id"] != "call-web-ai-timeout" {
		t.Fatalf("expected cancel for call-web-ai-timeout, got %v", second["query_id"])
	}
}

func TestAskWebAIToolFailsFastWhenNoClientForProvider(t *testing.T) {
	tool := NewAskWebAITool()
	res := tool.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":  "no-client",
			"prompt":   "second opinion?",
			"provider": "Claude",
		},
		Broadcast:       func([]byte) { t.Errorf("must not broadcast when no client is resolved") },
		PickWebAIClient: func(string) string { return "" },
	})
	if res.Status != "error" {
		t.Fatalf("expected error when no AI page is connected, got status=%s", res.Status)
	}
	if !contains(res.Error, "no connected browser AI page") {
		t.Fatalf("expected fail-fast message, got %q", res.Error)
	}
}

func TestAskWebAIToolTargetsResolvedClient(t *testing.T) {
	tool := NewAskWebAITool()
	var gotClient string
	var gotPayloadClient string
	res := tool.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":     "target-1",
			"prompt":      "review",
			"provider":    "Claude",
			"timeout_sec": float64(2),
		},
		PickWebAIClient: func(string) string { return "claude-tab" },
		Broadcast:       func([]byte) { t.Errorf("must use single-client send, not broadcast") },
		BroadcastToClient: func(clientID string, payload []byte) bool {
			gotClient = clientID
			msg := decodeBroadcast(t, payload)
			gotPayloadClient, _ = msg["client_id"].(string)
			go PendingWebAIQueries.Deliver("target-1", WebAIQueryResult{Text: "looks good", Provider: "Claude"})
			return true
		},
	})
	if gotClient != "claude-tab" {
		t.Fatalf("expected query sent to resolved client, got %q", gotClient)
	}
	if gotPayloadClient != "claude-tab" {
		t.Fatalf("expected payload client_id to target resolved client, got %q", gotPayloadClient)
	}
	if res.Status != "success" || !contains(res.Output, "looks good") {
		t.Fatalf("expected success with delivered answer, got status=%s output=%q", res.Status, res.Output)
	}
}

func decodeBroadcast(t *testing.T, payload []byte) map[string]interface{} {
	t.Helper()
	var msg map[string]interface{}
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("broadcast payload was not JSON: %v", err)
	}
	return msg
}

func containsAll(text string, parts ...string) bool {
	for _, part := range parts {
		if !contains(text, part) {
			return false
		}
	}
	return true
}

func contains(text, part string) bool {
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return true
		}
	}
	return part == ""
}
