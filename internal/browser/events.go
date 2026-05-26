package browser

import (
	"encoding/json"
	"sync"
	"time"
)

type DialogEvent struct {
	TabID   int
	Type    string
	Message string
	URL     string
}

type dialogWaiter struct {
	tabID int
	ch    chan DialogEvent
}

type EventBus struct {
	mu      sync.RWMutex
	dialogs map[string]dialogWaiter
}

func NewEventBus() *EventBus {
	return &EventBus{dialogs: make(map[string]dialogWaiter)}
}

func (b *EventBus) HandleEvent(event Event) {
	if b == nil || event.Event != "Page.javascriptDialogOpening" {
		return
	}
	var params struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		URL     string `json:"url"`
	}
	if len(event.Params) > 0 {
		_ = json.Unmarshal(event.Params, &params)
	}
	dialog := DialogEvent{
		TabID:   event.TabID,
		Type:    params.Type,
		Message: params.Message,
		URL:     params.URL,
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, waiter := range b.dialogs {
		if waiter.tabID > 0 && waiter.tabID != event.TabID {
			continue
		}
		select {
		case waiter.ch <- dialog:
		default:
		}
	}
}

func (b *EventBus) WaitForDialog(callID string, tabID int, timeout time.Duration) <-chan DialogEvent {
	ch := make(chan DialogEvent, 1)
	if b == nil {
		close(ch)
		return ch
	}
	b.mu.Lock()
	b.dialogs[callID] = dialogWaiter{tabID: tabID, ch: ch}
	b.mu.Unlock()
	time.AfterFunc(timeout, func() {
		b.RemoveDialog(callID)
	})
	return ch
}

func (b *EventBus) RemoveDialog(callID string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	delete(b.dialogs, callID)
	b.mu.Unlock()
}
