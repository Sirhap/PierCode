package tool

import (
	"sync"
)

const pendingQuestionCancelPrefix = "\x00piercode-cancel:"

// PendingQuestions tracks question tool invocations waiting for a user reply.
// The question tool registers a channel keyed by call_id, broadcasts the
// question over WS, and blocks on the channel. The HTTP server (or TUI) calls
// Deliver with the matching call_id when an answer arrives.
type pendingQuestion struct {
	ch    chan string
	owner string // WS client id that registered the question; "" = any (TUI/CLI)
}

type pendingQuestionRegistry struct {
	mu sync.Mutex
	ch map[string]*pendingQuestion
}

// PendingQuestions is the shared registry used by the question tool and the
// server's question_answer dispatcher.
var PendingQuestions = &pendingQuestionRegistry{ch: map[string]*pendingQuestion{}}

// Register reserves a one-shot channel for the given call_id with no owner
// binding (answers accepted from any client). Used by the TUI/CLI path.
func (r *pendingQuestionRegistry) Register(callID string) (<-chan string, func()) {
	return r.RegisterOwned(callID, "")
}

// RegisterOwned reserves a one-shot channel bound to owner — the WS client id of
// the page that asked. Only that client may answer/cancel (#1); a different page
// sharing the token is rejected. An empty owner means unbound (any client may
// answer), preserving the TUI/CLI behavior.
func (r *pendingQuestionRegistry) RegisterOwned(callID, owner string) (<-chan string, func()) {
	ch := make(chan string, 1)
	r.mu.Lock()
	r.ch[callID] = &pendingQuestion{ch: ch, owner: owner}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.ch, callID)
		r.mu.Unlock()
	}
}

// Deliver routes an answer with no owner check (TUI/CLI / internal callers).
func (r *pendingQuestionRegistry) Deliver(callID, answer string) bool {
	return r.send(callID, answer, "", false)
}

// DeliverFrom routes an answer that arrived from WS client `from`. It is dropped
// unless `from` matches the question's owner (or the question is unbound).
func (r *pendingQuestionRegistry) DeliverFrom(callID, answer, from string) bool {
	return r.send(callID, answer, from, true)
}

// Cancel routes a cancellation notice with no owner check.
func (r *pendingQuestionRegistry) Cancel(callID, reason string) bool {
	return r.send(callID, pendingQuestionCancelPrefix+reason, "", false)
}

// CancelFrom routes a cancellation that arrived from WS client `from`, subject
// to the same owner check as DeliverFrom.
func (r *pendingQuestionRegistry) CancelFrom(callID, reason, from string) bool {
	return r.send(callID, pendingQuestionCancelPrefix+reason, from, true)
}

func (r *pendingQuestionRegistry) send(callID, value, from string, checkOwner bool) bool {
	r.mu.Lock()
	pq, ok := r.ch[callID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	if checkOwner && pq.owner != "" && pq.owner != from {
		// A page other than the one that asked tried to answer — reject (#1).
		return false
	}
	select {
	case pq.ch <- value:
		return true
	default:
		// Already delivered (someone double-answered) — drop silently.
		return false
	}
}

func parsePendingQuestionCancel(value string) (string, bool) {
	if len(value) < len(pendingQuestionCancelPrefix) || value[:len(pendingQuestionCancelPrefix)] != pendingQuestionCancelPrefix {
		return "", false
	}
	return value[len(pendingQuestionCancelPrefix):], true
}

// Pending returns the set of call_ids currently awaiting answers. Used by the
// TUI to render a list of open questions.
func (r *pendingQuestionRegistry) Pending() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.ch))
	for id := range r.ch {
		out = append(out, id)
	}
	return out
}
