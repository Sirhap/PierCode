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
	pending map[string]chan ApprovalAnswer
	seq     atomic.Uint64
}

func NewApprovalManager(broadcast func([]byte)) *ApprovalManager {
	return &ApprovalManager{
		broadcast: broadcast,
		pending:   make(map[string]chan ApprovalAnswer),
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
	m.pending[ask.ApprovalID] = ch
	m.mu.Unlock()
	defer m.deletePending(ask.ApprovalID)

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
	ch, ok := m.pending[answer.ApprovalID]
	m.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- answer:
	default:
	}
	return true
}

func (m *ApprovalManager) deletePending(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}
