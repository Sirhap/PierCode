package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func TestHandleWSClientMessageDeliversWebAIQueryResult(t *testing.T) {
	callID := "ws-web-ai-result"
	ch, cleanup := tool.PendingWebAIQueries.Register(callID)
	defer cleanup()

	payload, err := json.Marshal(map[string]interface{}{
		"type":     "ai_query_result",
		"query_id": callID,
		"text":     "browser model answer",
		"provider": "Claude",
		"url":      "https://claude.ai/chat/123",
	})
	if err != nil {
		t.Fatal(err)
	}

	var s Server
	s.handleWSClientMessage(payload)

	select {
	case got := <-ch:
		if got.Text != "browser model answer" {
			t.Fatalf("expected answer text, got %q", got.Text)
		}
		if got.Provider != "Claude" {
			t.Fatalf("expected provider Claude, got %q", got.Provider)
		}
		if got.URL != "https://claude.ai/chat/123" {
			t.Fatalf("expected source URL, got %q", got.URL)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for ai query result delivery")
	}
}
