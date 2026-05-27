package tool

import "sync"

type AttachmentUploadResult struct {
	OK    bool
	Error string
}

type pendingAttachmentUploadRegistry struct {
	mu sync.Mutex
	ch map[string]chan AttachmentUploadResult
}

var PendingAttachmentUploads = &pendingAttachmentUploadRegistry{ch: map[string]chan AttachmentUploadResult{}}

func (r *pendingAttachmentUploadRegistry) Register(callID string) (<-chan AttachmentUploadResult, func()) {
	ch := make(chan AttachmentUploadResult, 1)
	r.mu.Lock()
	r.ch[callID] = ch
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.ch, callID)
		r.mu.Unlock()
	}
}

func (r *pendingAttachmentUploadRegistry) Deliver(callID string, result AttachmentUploadResult) bool {
	r.mu.Lock()
	ch, ok := r.ch[callID]
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
