package tool

import "sync"

const pendingWebAICancelPrefix = "\x00piercode-web-ai-cancel:"

type WebAIQueryResult struct {
	Text     string
	Provider string
	URL      string
	Error    string
}

type pendingWebAIQueryRegistry struct {
	mu sync.Mutex
	ch map[string]chan WebAIQueryResult
}

var PendingWebAIQueries = &pendingWebAIQueryRegistry{ch: map[string]chan WebAIQueryResult{}}

func (r *pendingWebAIQueryRegistry) Register(queryID string) (<-chan WebAIQueryResult, func()) {
	ch := make(chan WebAIQueryResult, 1)
	r.mu.Lock()
	r.ch[queryID] = ch
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.ch, queryID)
		r.mu.Unlock()
	}
}

func (r *pendingWebAIQueryRegistry) Deliver(queryID string, result WebAIQueryResult) bool {
	return r.send(queryID, result)
}

func (r *pendingWebAIQueryRegistry) Cancel(queryID, reason string) bool {
	return r.send(queryID, WebAIQueryResult{Error: pendingWebAICancelPrefix + reason})
}

func (r *pendingWebAIQueryRegistry) send(queryID string, result WebAIQueryResult) bool {
	r.mu.Lock()
	ch, ok := r.ch[queryID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- result:
		return true
	default:
		return false
	}
}

func parsePendingWebAICancel(value string) (string, bool) {
	if len(value) < len(pendingWebAICancelPrefix) || value[:len(pendingWebAICancelPrefix)] != pendingWebAICancelPrefix {
		return "", false
	}
	return value[len(pendingWebAICancelPrefix):], true
}
