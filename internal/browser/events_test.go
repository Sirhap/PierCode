package browser

import (
	"encoding/json"
	"sync"
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

func TestEventBusConcurrentConsoleReadWrite(t *testing.T) {
	bus := NewEventBus()
	const iterations = 200

	var wg sync.WaitGroup
	start := make(chan struct{})
	wg.Add(2)

	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < iterations; i++ {
			params, _ := json.Marshal(map[string]interface{}{
				"type": "log",
				"args": []map[string]interface{}{
					{"type": "string", "value": "message"},
				},
				"timestamp": float64(i),
			})
			bus.HandleEvent(Event{
				Type:   "browser_event",
				Event:  "Runtime.consoleAPICalled",
				TabID:  42,
				Params: params,
			})
		}
	}()

	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < iterations; i++ {
			_ = bus.GetConsoleMessages(42, ConsoleFilter{Limit: 50})
		}
	}()

	close(start)
	wg.Wait()
}

func TestHasDialogWaiterGatesAutoDismiss(t *testing.T) {
	b := NewEventBus()
	// No waiter → auto-dismiss should fire (HasDialogWaiter false).
	if b.HasDialogWaiter(5) {
		t.Fatal("expected no waiter on fresh bus")
	}
	// Explicit browser_handle_dialog active for tab 5 → auto-dismiss suppressed.
	_ = b.WaitForDialog("call-1", 5, 0)
	if !b.HasDialogWaiter(5) {
		t.Fatal("waiter for tab 5 should be seen")
	}
	if b.HasDialogWaiter(9) {
		t.Fatal("tab-5 waiter must not match tab 9")
	}
	b.RemoveDialog("call-1")
	if b.HasDialogWaiter(5) {
		t.Fatal("removed waiter must not match")
	}
	// Any-tab waiter (tabID<=0) matches every tab.
	_ = b.WaitForDialog("call-any", 0, 0)
	if !b.HasDialogWaiter(123) {
		t.Fatal("any-tab waiter should match tab 123")
	}
}
