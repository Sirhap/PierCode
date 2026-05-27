package browser

import (
	"encoding/json"
	"testing"
)

func TestConsoleEventIsBuffered(t *testing.T) {
	bus := NewEventBus()
	params, _ := json.Marshal(map[string]interface{}{
		"type": "log",
		"args": []map[string]interface{}{
			{"type": "string", "value": "hello"},
		},
		"timestamp": float64(1234567890),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Runtime.consoleAPICalled",
		TabID:  1,
		Params: params,
	})

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	msg := msgs[0]
	if msg.Type != "log" {
		t.Fatalf("expected type log, got %s", msg.Type)
	}
	if msg.Text != "hello" {
		t.Fatalf("expected text hello, got %s", msg.Text)
	}
	if msg.Timestamp != float64(1234567890) {
		t.Fatalf("expected timestamp 1234567890, got %f", msg.Timestamp)
	}
	if msg.TabID != 1 {
		t.Fatalf("expected tabID 1, got %d", msg.TabID)
	}
}

func TestConsoleEventMultipleTypes(t *testing.T) {
	bus := NewEventBus()
	types := []string{"log", "error", "warn"}
	for _, typ := range types {
		params, _ := json.Marshal(map[string]interface{}{
			"type": typ,
			"args": []map[string]interface{}{
				{"type": "string", "value": "msg-" + typ},
			},
			"timestamp": float64(1000),
		})
		bus.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Runtime.consoleAPICalled",
			TabID:  1,
			Params: params,
		})
	}

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{})
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	for i, typ := range types {
		if msgs[i].Type != typ {
			t.Fatalf("message %d: expected type %s, got %s", i, typ, msgs[i].Type)
		}
		if msgs[i].Text != "msg-"+typ {
			t.Fatalf("message %d: expected text msg-%s, got %s", i, typ, msgs[i].Text)
		}
	}
}

func TestConsoleFilterOnlyErrors(t *testing.T) {
	bus := NewEventBus()
	for _, typ := range []string{"log", "error", "log", "error"} {
		params, _ := json.Marshal(map[string]interface{}{
			"type": typ,
			"args": []map[string]interface{}{
				{"type": "string", "value": "test"},
			},
			"timestamp": float64(1000),
		})
		bus.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Runtime.consoleAPICalled",
			TabID:  1,
			Params: params,
		})
	}

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{OnlyErrors: true})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 error messages, got %d", len(msgs))
	}
	for _, msg := range msgs {
		if msg.Type != "error" {
			t.Fatalf("expected error type, got %s", msg.Type)
		}
	}
}

func TestConsoleFilterPattern(t *testing.T) {
	bus := NewEventBus()
	texts := []string{"normal log", "error occurred", "debug info", "another error here"}
	for _, text := range texts {
		params, _ := json.Marshal(map[string]interface{}{
			"type": "log",
			"args": []map[string]interface{}{
				{"type": "string", "value": text},
			},
			"timestamp": float64(1000),
		})
		bus.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Runtime.consoleAPICalled",
			TabID:  1,
			Params: params,
		})
	}

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{Pattern: "error"})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 matching messages, got %d", len(msgs))
	}
	for _, msg := range msgs {
		if msg.Text != "error occurred" && msg.Text != "another error here" {
			t.Fatalf("unexpected message: %s", msg.Text)
		}
	}
}

func TestConsoleFilterLimit(t *testing.T) {
	bus := NewEventBus()
	for i := 0; i < 10; i++ {
		params, _ := json.Marshal(map[string]interface{}{
			"type": "log",
			"args": []map[string]interface{}{
				{"type": "string", "value": "msg"},
			},
			"timestamp": float64(i),
		})
		bus.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Runtime.consoleAPICalled",
			TabID:  1,
			Params: params,
		})
	}

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{Limit: 3})
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	// Should be the last 3 (timestamps 7, 8, 9)
	if msgs[0].Timestamp != 7 {
		t.Fatalf("expected first message timestamp 7, got %f", msgs[0].Timestamp)
	}
	if msgs[2].Timestamp != 9 {
		t.Fatalf("expected last message timestamp 9, got %f", msgs[2].Timestamp)
	}
}

func TestConsoleClear(t *testing.T) {
	bus := NewEventBus()
	params, _ := json.Marshal(map[string]interface{}{
		"type": "log",
		"args": []map[string]interface{}{
			{"type": "string", "value": "test"},
		},
		"timestamp": float64(1000),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Runtime.consoleAPICalled",
		TabID:  1,
		Params: params,
	})

	bus.ClearConsole(1)
	msgs := bus.GetConsoleMessages(1, ConsoleFilter{})
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages after clear, got %d", len(msgs))
	}
}

func TestNetworkRequestIsBuffered(t *testing.T) {
	bus := NewEventBus()
	params, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-1",
		"request": map[string]interface{}{
			"url":    "https://example.com/api",
			"method": "GET",
		},
		"type":      "XHR",
		"timestamp": float64(1234567890),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.requestWillBeSent",
		TabID:  1,
		Params: params,
	})

	reqs := bus.GetNetworkRequests(1, NetworkFilter{})
	if len(reqs) != 1 {
		t.Fatalf("expected 1 request, got %d", len(reqs))
	}
	req := reqs[0]
	if req.RequestID != "req-1" {
		t.Fatalf("expected requestID req-1, got %s", req.RequestID)
	}
	if req.URL != "https://example.com/api" {
		t.Fatalf("expected URL https://example.com/api, got %s", req.URL)
	}
	if req.Method != "GET" {
		t.Fatalf("expected method GET, got %s", req.Method)
	}
	if req.Type != "XHR" {
		t.Fatalf("expected type XHR, got %s", req.Type)
	}
	if req.Timestamp != float64(1234567890) {
		t.Fatalf("expected timestamp 1234567890, got %f", req.Timestamp)
	}
}

func TestNetworkResponseUpdatesStatusCode(t *testing.T) {
	bus := NewEventBus()
	// Send request
	reqParams, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-1",
		"request": map[string]interface{}{
			"url":    "https://example.com/api",
			"method": "GET",
		},
		"type":      "XHR",
		"timestamp": float64(1000),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.requestWillBeSent",
		TabID:  1,
		Params: reqParams,
	})

	// Send response
	respParams, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-1",
		"response": map[string]interface{}{
			"status":   200,
			"mimeType": "application/json",
		},
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.responseReceived",
		TabID:  1,
		Params: respParams,
	})

	reqs := bus.GetNetworkRequests(1, NetworkFilter{})
	if len(reqs) != 1 {
		t.Fatalf("expected 1 request, got %d", len(reqs))
	}
	if reqs[0].StatusCode != 200 {
		t.Fatalf("expected statusCode 200, got %d", reqs[0].StatusCode)
	}
}

func TestNetworkFilterURLPattern(t *testing.T) {
	bus := NewEventBus()
	urls := []string{
		"https://example.com/api/users",
		"https://example.com/static/app.js",
		"https://example.com/api/posts",
		"https://example.com/style.css",
	}
	for i, url := range urls {
		params, _ := json.Marshal(map[string]interface{}{
			"requestId": "req-" + string(rune('a'+i)),
			"request": map[string]interface{}{
				"url":    url,
				"method": "GET",
			},
			"type":      "Document",
			"timestamp": float64(1000),
		})
		bus.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Network.requestWillBeSent",
			TabID:  1,
			Params: params,
		})
	}

	reqs := bus.GetNetworkRequests(1, NetworkFilter{URLPattern: "/api/"})
	if len(reqs) != 2 {
		t.Fatalf("expected 2 matching requests, got %d", len(reqs))
	}
	for _, req := range reqs {
		if req.URL != "https://example.com/api/users" && req.URL != "https://example.com/api/posts" {
			t.Fatalf("unexpected URL: %s", req.URL)
		}
	}
}

func TestNetworkClear(t *testing.T) {
	bus := NewEventBus()
	params, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-1",
		"request": map[string]interface{}{
			"url":    "https://example.com",
			"method": "GET",
		},
		"type":      "Document",
		"timestamp": float64(1000),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.requestWillBeSent",
		TabID:  1,
		Params: params,
	})

	bus.ClearNetwork(1)
	reqs := bus.GetNetworkRequests(1, NetworkFilter{})
	if len(reqs) != 0 {
		t.Fatalf("expected 0 requests after clear, got %d", len(reqs))
	}
}

func TestExceptionEventBufferedAsConsole(t *testing.T) {
	bus := NewEventBus()
	params, _ := json.Marshal(map[string]interface{}{
		"exceptionDetails": map[string]interface{}{
			"text": "Uncaught TypeError: undefined is not a function",
			"exception": map[string]interface{}{
				"description": "TypeError: undefined is not a function",
			},
		},
		"timestamp": float64(1234567890),
	})
	bus.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Runtime.exceptionThrown",
		TabID:  1,
		Params: params,
	})

	msgs := bus.GetConsoleMessages(1, ConsoleFilter{})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	msg := msgs[0]
	if msg.Type != "exception" {
		t.Fatalf("expected type exception, got %s", msg.Type)
	}
	if msg.Text != "TypeError: undefined is not a function" {
		t.Fatalf("expected text from exception description, got %s", msg.Text)
	}
	if msg.Timestamp != float64(1234567890) {
		t.Fatalf("expected timestamp 1234567890, got %f", msg.Timestamp)
	}
}
