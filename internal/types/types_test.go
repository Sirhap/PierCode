package types

import (
	"encoding/json"
	"testing"
)

func TestToolRequestUnmarshalConversationURL(t *testing.T) {
	data := []byte(`{"name":"exec_cmd","call_id":"abc123","args":{"command":"pwd"},"client_id":"client-a","conversation_url":"https://claude.ai/chat/abc"}`)

	var req ToolRequest
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatal(err)
	}
	if req.SourceClientID != "client-a" {
		t.Fatalf("SourceClientID = %q, want client-a", req.SourceClientID)
	}
	if req.ConversationURL != "https://claude.ai/chat/abc" {
		t.Fatalf("ConversationURL = %q", req.ConversationURL)
	}
}
