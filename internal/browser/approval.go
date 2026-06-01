package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type ApprovalManager struct {
	broadcast func([]byte)

	mu      sync.Mutex
	pending map[string]pendingApproval
	seq     atomic.Uint64
}

type pendingApproval struct {
	callID string
	ch     chan ApprovalAnswer
}

type approvalDone struct {
	Type       string `json:"type"`
	ApprovalID string `json:"approval_id"`
	CallID     string `json:"call_id,omitempty"`
}

func NewApprovalManager(broadcast func([]byte)) *ApprovalManager {
	return &ApprovalManager{
		broadcast: broadcast,
		pending:   make(map[string]pendingApproval),
	}
}

func (m *ApprovalManager) Ask(ctx context.Context, ask ApprovalAsk) error {
	if m == nil || m.broadcast == nil {
		return fmt.Errorf("browser action requires user approval, but no approval UI is connected")
	}
	if ask.ApprovalID == "" {
		ask.ApprovalID = fmt.Sprintf("browser_approval_%d_%d", time.Now().UnixNano(), m.seq.Add(1))
	}
	ask.Type = "browser_approval_ask"
	if len(ask.Options) == 0 {
		ask.Options = []string{"允许", "拒绝"}
	}

	ch := make(chan ApprovalAnswer, 1)
	m.mu.Lock()
	m.pending[ask.ApprovalID] = pendingApproval{callID: ask.CallID, ch: ch}
	m.mu.Unlock()
	defer func() {
		m.deletePending(ask.ApprovalID)
		m.broadcastDone(ask.ApprovalID, ask.CallID)
	}()

	payload, err := json.Marshal(ask)
	if err != nil {
		return err
	}
	m.broadcast(payload)

	timer := time.NewTimer(5 * time.Minute)
	defer timer.Stop()
	select {
	case answer := <-ch:
		if !answer.Approved {
			if answer.Reason == "" {
				answer.Reason = "user rejected browser action"
			}
			return errors.New(answer.Reason)
		}
		return nil
	case <-timer.C:
		return fmt.Errorf("browser action approval timed out")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *ApprovalManager) Deliver(answer ApprovalAnswer) bool {
	if m == nil || answer.ApprovalID == "" {
		return false
	}
	m.mu.Lock()
	pending, ok := m.pending[answer.ApprovalID]
	m.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case pending.ch <- answer:
	default:
	}
	return true
}

func (m *ApprovalManager) deletePending(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}

func (m *ApprovalManager) broadcastDone(approvalID, callID string) {
	if m == nil || m.broadcast == nil || approvalID == "" {
		return
	}
	payload, err := json.Marshal(approvalDone{
		Type:       "browser_approval_done",
		ApprovalID: approvalID,
		CallID:     callID,
	})
	if err != nil {
		return
	}
	m.broadcast(payload)
}
