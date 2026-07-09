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

// A huge timeout_sec must be clamped, not overflow time.Duration to a negative
// value that fires an immediate spurious timeout. With the clamp the tool waits
// for the delivered answer and succeeds; without it, it would return an instant
// "no answer received within -…s" error before the answer arrives.
func TestQuestionToolClampsHugeTimeout(t *testing.T) {
	qt := NewQuestionTool()
	result := qt.Execute(&Context{
		Args: map[string]interface{}{
			"call_id":     "question-huge-timeout",
			"question":    "Continue?",
			"timeout_sec": float64(1e18), // overflows Duration(ns) if unclamped
		},
		Client: ClientIO{
			SourceClientID: "client-a",
			BroadcastToClient: func(string, []byte) bool {
				PendingQuestions.Deliver("question-huge-timeout", "yes")
				return true
			},
		},
	})
	if result.Status != "success" {
		t.Fatalf("huge timeout_sec should clamp and wait for the answer, got status=%q error=%q", result.Status, result.Error)
	}
}

func TestQuestionToolValidate(t *testing.T) {
	qt := NewQuestionTool()
	cases := []struct {
		name    string
		args    map[string]interface{}
		wantErr bool
	}{
		{"valid", map[string]interface{}{"question": "Continue?"}, false},
		{"missing", map[string]interface{}{}, true},
		{"empty", map[string]interface{}{"question": ""}, true},
		{"whitespace-only", map[string]interface{}{"question": "  \n\t "}, true},
		{"wrong-type", map[string]interface{}{"question": 42}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := qt.Validate(c.args)
			if (err != nil) != c.wantErr {
				t.Fatalf("Validate(%#v) err=%v, wantErr=%v", c.args, err, c.wantErr)
			}
		})
	}
}
