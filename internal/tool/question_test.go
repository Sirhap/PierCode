package tool

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestQuestionToolRoutesAskToSourceClient(t *testing.T) {
	qt := NewQuestionTool()
	var broadcasted bool
	var gotClientID string
	var ask struct {
		Type     string `json:"type"`
		CallID   string `json:"call_id"`
		ClientID string `json:"client_id"`
		Question string `json:"question"`
	}

	result := qt.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":     "question-route-test",
			"question":    "Continue?",
			"timeout_sec": 1,
		},
		Client: ClientIO{
			SourceClientID: "client-a",
			Broadcast: func([]byte) {
				broadcasted = true
			},
			BroadcastToClient: func(clientID string, payload []byte) bool {
				gotClientID = clientID
				if err := json.Unmarshal(payload, &ask); err != nil {
					t.Fatalf("unmarshal ask payload: %v", err)
				}
				PendingQuestions.Deliver("question-route-test", "yes")
				return true
			},
		},
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got status=%q error=%q", result.Status, result.Error)
	}
	if broadcasted {
		t.Fatal("expected source client routing, got global broadcast")
	}
	if gotClientID != "client-a" {
		t.Fatalf("expected client-a route, got %q", gotClientID)
	}
	if ask.Type != "question_ask" || ask.CallID != "question-route-test" || ask.ClientID != "client-a" || ask.Question != "Continue?" {
		t.Fatalf("unexpected ask payload: %#v", ask)
	}
	if !strings.Contains(result.Output, "A: yes") {
		t.Fatalf("expected answer in output, got %q", result.Output)
	}
}
