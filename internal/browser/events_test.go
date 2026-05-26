package browser

import (
	"encoding/json"
	"testing"
	"time"
)

func TestEventBusRelaysDialogEventsByTab(t *testing.T) {
	bus := NewEventBus()
	ch := bus.WaitForDialog("call-1", 42, time.Second)
	other := bus.WaitForDialog("call-2", 7, time.Second)
	defer bus.RemoveDialog("call-1")
	defer bus.RemoveDialog("call-2")

	params, _ := json.Marshal(map[string]string{
		"type":    "alert",
		"message": "hello",
		"url":     "https://example.com",
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Page.javascriptDialogOpening",
		TabID:  42,
		Params: params,
	})

	select {
	case event := <-ch:
		if event.Type != "alert" || event.Message != "hello" || event.TabID != 42 {
			t.Fatalf("unexpected dialog event: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("expected matching waiter to receive dialog event")
	}

	select {
	case event := <-other:
		t.Fatalf("non-matching tab waiter received event: %#v", event)
	default:
	}
}
