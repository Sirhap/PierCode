package tool

import (
	"sync"
)

const pendingQuestionCancelPrefix = "\x00piercode-cancel:"

// PendingQuestions tracks question tool invocations waiting for a user reply.
// The question tool registers a channel keyed by call_id, broadcasts the
// question over WS, and blocks on the channel. The HTTP server (or TUI) calls
// Deliver with the matching call_id when an answer arrives.
type pendingQuestionRegistry struct {
	mu sync.Mutex
	ch map[string]chan string
}

// PendingQuestions is the shared registry used by the question tool and the
// server's question_answer dispatcher.
var PendingQuestions = &pendingQuestionRegistry{ch: map[string]chan string{}}

// Register reserves a one-shot channel for the given call_id. Returns the
// channel and a cancel func; the caller must invoke cancel() to clean up the
// map entry whether or not an answer arrived.
func (r *pendingQuestionRegistry) Register(callID string) (<-chan string, func()) {
	ch := make(chan string, 1)
	r.mu.Lock()
	r.ch[callID] = ch
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.ch, callID)
		r.mu.Unlock()
	}
}

// Deliver routes an answer to a registered question. Returns true if a
// waiting question accepted it, false if no one is waiting on call_id.
func (r *pendingQuestionRegistry) Deliver(callID, answer string) bool {
	return r.send(callID, answer)
}

// Cancel routes a cancellation notice to a registered question. Returns true
// if a waiting question accepted it, false if no one is waiting on call_id.
func (r *pendingQuestionRegistry) Cancel(callID, reason string) bool {
	return r.send(callID, pendingQuestionCancelPrefix+reason)
}

func (r *pendingQuestionRegistry) send(callID, value string) bool {
	r.mu.Lock()
	ch, ok := r.ch[callID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- value:
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
