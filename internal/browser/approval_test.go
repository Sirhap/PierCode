package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestApprovalManagerRejectsAndBroadcastsDone(t *testing.T) {
	var payloads [][]byte
	var manager *ApprovalManager
	manager = NewApprovalManager(func(payload []byte) {
		payloads = append(payloads, append([]byte(nil), payload...))
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err == nil && ask.Type == "browser_approval_ask" {
			go manager.Deliver(ApprovalAnswer{
				ApprovalID: ask.ApprovalID,
				Approved:   false,
				Reason:     "operator rejected test action",
			})
		}
	})

	err := manager.Ask(context.Background(), ApprovalAsk{
		CallID: "reject-call",
		Action: "Reject browser action",
	})
	if err == nil || !strings.Contains(err.Error(), "operator rejected test action") {
		t.Fatalf("expected rejection reason, got %v", err)
	}
	if len(payloads) != 2 {
		t.Fatalf("expected ask and done payloads, got %d", len(payloads))
	}
	var done struct {
		Type   string `json:"type"`
		CallID string `json:"call_id"`
	}
	if err := json.Unmarshal(payloads[1], &done); err != nil {
		t.Fatalf("unmarshal done payload: %v", err)
	}
	if done.Type != "browser_approval_done" || done.CallID != "reject-call" {
		t.Fatalf("unexpected done payload: %#v", done)
	}
}

func TestApprovalManagerContextCancelBroadcastsDone(t *testing.T) {
	var payloads [][]byte
	manager := NewApprovalManager(func(payload []byte) {
		payloads = append(payloads, append([]byte(nil), payload...))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := manager.Ask(ctx, ApprovalAsk{CallID: "cancel-call"})
	if err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("expected context deadline, got %v", err)
	}
	if len(payloads) != 2 {
		t.Fatalf("expected ask and done payloads after cancellation, got %d", len(payloads))
	}
	var done struct {
		Type   string `json:"type"`
		CallID string `json:"call_id"`
	}
	if err := json.Unmarshal(payloads[1], &done); err != nil {
		t.Fatalf("unmarshal done payload: %v", err)
	}
	if done.Type != "browser_approval_done" || done.CallID != "cancel-call" {
		t.Fatalf("unexpected done payload: %#v", done)
	}
}
