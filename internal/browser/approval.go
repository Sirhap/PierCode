package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

type ApprovalManager struct {
	broadcast func([]byte)

	mu      sync.Mutex
	pending map[string]pendingApproval
	seq     atomic.Uint64

	// grants records session-scoped approvals keyed by "host\x00actionClass".
	// A present key means the user chose "always for this site + action class",
	// so future matching calls skip the prompt for the rest of the process.
	grantsMu sync.RWMutex
	grants   map[string]bool
}

type pendingApproval struct {
	callID   string
	clientID string
	ch       chan ApprovalAnswer
}

type approvalDone struct {
	Type       string `json:"type"`
	ApprovalID string `json:"approval_id"`
	CallID     string `json:"call_id,omitempty"`
	ClientID   string `json:"client_id,omitempty"`
}

func NewApprovalManager(broadcast func([]byte)) *ApprovalManager {
	return &ApprovalManager{
		broadcast: broadcast,
		pending:   make(map[string]pendingApproval),
		grants:    make(map[string]bool),
	}
}

func grantKey(host, actionClass string) string {
	return host + "\x00" + actionClass
}

// hasGrant reports whether a session grant covers this host + action class.
func (m *ApprovalManager) hasGrant(host, actionClass string) bool {
	if m == nil || host == "" || actionClass == "" {
		return false
	}
	m.grantsMu.RLock()
	defer m.grantsMu.RUnlock()
	return m.grants[grantKey(host, actionClass)]
}

func (m *ApprovalManager) recordGrant(host, actionClass string) {
	if m == nil || host == "" || actionClass == "" {
		return
	}
	m.grantsMu.Lock()
	m.grants[grantKey(host, actionClass)] = true
	m.grantsMu.Unlock()
}

func (m *ApprovalManager) Ask(ctx context.Context, ask ApprovalAsk) error {
	if m == nil || m.broadcast == nil {
		return fmt.Errorf("browser action requires user approval, but no approval UI is connected")
	}
	// A prior "always for this site + action class" grant skips the prompt.
	if m.hasGrant(ask.Host, ask.ActionClass) {
		return nil
	}
	if ask.ApprovalID == "" {
		ask.ApprovalID = fmt.Sprintf("browser_approval_%d_%d", time.Now().UnixNano(), m.seq.Add(1))
	}
	if ask.ClientID == "" {
		ask.ClientID = tool.SourceClientIDFromContext(ctx)
	}
	ask.Type = "browser_approval_ask"
	if len(ask.Options) == 0 {
		// Offer a session-scoped option so the user can stop re-approving the
		// same site + action class. The UI maps the third option to scope=session.
		ask.Options = []string{"允许", "本站点始终允许", "拒绝"}
	}

	ch := make(chan ApprovalAnswer, 1)
	m.mu.Lock()
	m.pending[ask.ApprovalID] = pendingApproval{callID: ask.CallID, clientID: ask.ClientID, ch: ch}
	m.mu.Unlock()
	defer func() {
		m.deletePending(ask.ApprovalID)
		m.broadcastDone(ask.ApprovalID, ask.CallID, ask.ClientID)
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
		// "always for this site" → remember the grant for the rest of the session.
		if answer.Scope == "session" || answer.Scope == "always" {
			m.recordGrant(ask.Host, ask.ActionClass)
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

func (m *ApprovalManager) broadcastDone(approvalID, callID, clientID string) {
	if m == nil || m.broadcast == nil || approvalID == "" {
		return
	}
	payload, err := json.Marshal(approvalDone{
		Type:       "browser_approval_done",
		ApprovalID: approvalID,
		CallID:     callID,
		ClientID:   clientID,
	})
	if err != nil {
		return
	}
	m.broadcast(payload)
}
