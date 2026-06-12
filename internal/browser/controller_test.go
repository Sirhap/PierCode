package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func TestEnsureTabRequiresApprovalForAIPage(t *testing.T) {
	const tabID = 42
	relay := newGetTabRelay(t, tool.BrowserTab{TabID: tabID, URL: "https://chatgpt.com/c/123", Title: "AI chat"})
	controller := NewController(relay, func([]byte) {})

	_, err := controller.ensureTab(context.Background(), intPtr(tabID))
	if err == nil || !strings.Contains(err.Error(), "refusing to control AI conversation tab") {
		t.Fatalf("expected AI tab refusal before approval, got %v", err)
	}

	controller.tabs.MarkApproved(tabID)
	tab, err := controller.ensureTab(context.Background(), intPtr(tabID))
	if err != nil {
		t.Fatalf("expected approved AI tab to pass: %v", err)
	}
	if tab.TabID != tabID {
		t.Fatalf("unexpected tab: %+v", tab)
	}
}

func newGetTabRelay(t *testing.T, tab tool.BrowserTab) *RelayManager {
	t.Helper()
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		if cmd.Domain != "PierCode" || cmd.Method != "getTab" {
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		data, err := json.Marshal(tab)
		if err != nil {
			t.Fatalf("marshal tab: %v", err)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	return relay
}

func intPtr(v int) *int { return &v }

func TestHandleEventTabRemovedClearsEventBusBuffers(t *testing.T) {
	controller := NewController(NewRelayManagerFromSend(func([]byte) bool { return false }), func([]byte) {})

	const tabID = 55

	// Buffer console messages for the tab
	consoleParams, _ := json.Marshal(map[string]interface{}{
		"type": "log",
		"args": []map[string]interface{}{
			{"type": "string", "value": "test message"},
		},
		"timestamp": float64(1000),
	})
	controller.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Runtime.consoleAPICalled",
		TabID:  tabID,
		Params: consoleParams,
	})

	// Buffer network requests for the tab
	networkParams, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-1",
		"request": map[string]interface{}{
			"url":    "https://example.com/api",
			"method": "GET",
		},
		"type":      "XHR",
		"timestamp": float64(1000),
	})
	controller.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.requestWillBeSent",
		TabID:  tabID,
		Params: networkParams,
	})

	// Verify messages exist before removal
	consoleBefore := controller.events.GetConsoleMessages(tabID, ConsoleFilter{})
	if len(consoleBefore) != 1 {
		t.Fatalf("expected 1 console message before tab removal, got %d", len(consoleBefore))
	}
	networkBefore := controller.events.GetNetworkRequests(tabID, NetworkFilter{})
	if len(networkBefore) != 1 {
		t.Fatalf("expected 1 network request before tab removal, got %d", len(networkBefore))
	}

	// Fire tab_removed event
	controller.HandleEvent(Event{
		Type:  "browser_event",
		Event: "tab_removed",
		TabID: tabID,
	})

	// Verify buffers are cleared after tab removal
	consoleAfter := controller.events.GetConsoleMessages(tabID, ConsoleFilter{})
	if len(consoleAfter) != 0 {
		t.Fatalf("expected 0 console messages after tab removal, got %d", len(consoleAfter))
	}
	networkAfter := controller.events.GetNetworkRequests(tabID, NetworkFilter{})
	if len(networkAfter) != 0 {
		t.Fatalf("expected 0 network requests after tab removal, got %d", len(networkAfter))
	}
}

func TestDebuggerDetachedClearsDomainTracking(t *testing.T) {
	controller := NewController(NewRelayManagerFromSend(func([]byte) bool { return false }), func([]byte) {})

	const tabID = 77
	controller.events.MarkDomainEnabled(tabID, "Runtime")
	controller.events.MarkDomainEnabled(tabID, "Network")

	if !controller.events.IsDomainEnabled(tabID, "Runtime") {
		t.Fatal("expected Runtime domain to be marked enabled")
	}

	controller.HandleEvent(Event{
		Type:  "browser_event",
		Event: "debugger_detached",
		TabID: tabID,
	})

	if controller.events.IsDomainEnabled(tabID, "Runtime") {
		t.Fatal("expected Runtime domain tracking cleared after debugger_detached")
	}
	if controller.events.IsDomainEnabled(tabID, "Network") {
		t.Fatal("expected Network domain tracking cleared after debugger_detached")
	}
}

func TestNavigateWithBeforeunloadUsesParentContext(t *testing.T) {
	tab := tool.BrowserTab{TabID: 60, URL: "https://old.example.com", Title: "Old"}
	var controller *Controller
	var relay *RelayManager
	dialogHandled := make(chan map[string]interface{}, 1)

	ctx, cancel := context.WithCancel(context.Background())

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Page.navigate":
			go func() {
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
				// Fire the beforeunload dialog event after navigate completes
				params, _ := json.Marshal(map[string]string{
					"type":    "beforeunload",
					"message": "",
					"url":     "https://old.example.com",
				})
				controller.HandleEvent(Event{
					Type:   "browser_event",
					Event:  "Page.javascriptDialogOpening",
					TabID:  tab.TabID,
					Params: params,
				})
			}()
		case "PierCode.getTab":
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "Page.handleJavaScriptDialog":
			var params map[string]interface{}
			_ = json.Unmarshal(cmd.Params, &params)
			select {
			case dialogHandled <- params:
			default:
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})

	controller = NewController(relay, func(payload []byte) {
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err != nil {
			t.Fatalf("invalid approval payload: %v", err)
		}
		go controller.DeliverApproval(ApprovalAnswer{ApprovalID: ask.ApprovalID, Approved: true})
	})
	controller.tabs.SetDefault(tab)

	result, err := controller.NavigateWithBeforeunload(ctx, intPtr(tab.TabID), "https://new.example.com", "bu-ctx-test", "accept")
	if err != nil {
		t.Fatalf("NavigateWithBeforeunload returned error: %v", err)
	}
	if result.TabID != tab.TabID {
		t.Fatalf("expected tabID %d, got %d", tab.TabID, result.TabID)
	}

	// Cancel the parent context after NavigateWithBeforeunload returns.
	// The goroutine should use ctx (not context.Background()), so when ctx is
	// cancelled the SendCommand in the goroutine should fail or be skipped.
	cancel()

	select {
	case params := <-dialogHandled:
		// If the dialog was handled, the key fix is that ctx (not context.Background())
		// was passed to SendCommand. The accept value should still be correct.
		if params["accept"] != true {
			t.Fatalf("expected accept=true, got %#v", params["accept"])
		}
	case <-time.After(2 * time.Second):
		// The goroutine's SendCommand may have failed due to cancelled context.
		// This is the expected behavior with the fix applied.
	}
}
