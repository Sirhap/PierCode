package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func TestDispatchClickRightButton(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := NewController(relay, func([]byte) {})

	if err := controller.dispatchClick(context.Background(), 1, 100, 200, "right", 1); err != nil {
		t.Fatalf("dispatchClick returned error: %v", err)
	}
	if len(commands) != 3 {
		t.Fatalf("expected 3 commands (mouseMoved + mousePressed + mouseReleased), got %d", len(commands))
	}

	var moved map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &moved); err != nil {
		t.Fatalf("unmarshal mouseMoved params: %v", err)
	}
	if moved["type"] != "mouseMoved" || moved["button"] != "none" {
		t.Fatalf("expected leading mouseMoved, got %#v", moved)
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[1].Params, &pressed); err != nil {
		t.Fatalf("unmarshal mousePressed params: %v", err)
	}
	if pressed["button"] != "right" {
		t.Fatalf("expected button right, got %v", pressed["button"])
	}
	if pressed["buttons"] != float64(2) {
		t.Fatalf("expected buttons 2, got %v", pressed["buttons"])
	}
	if pressed["clickCount"] != float64(1) {
		t.Fatalf("expected clickCount 1, got %v", pressed["clickCount"])
	}

	var released map[string]interface{}
	if err := json.Unmarshal(commands[2].Params, &released); err != nil {
		t.Fatalf("unmarshal mouseReleased params: %v", err)
	}
	if released["button"] != "right" {
		t.Fatalf("expected button right, got %v", released["button"])
	}
	if released["buttons"] != float64(0) {
		t.Fatalf("expected buttons 0 on release, got %v", released["buttons"])
	}
}

func TestDispatchClickDoubleClick(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := NewController(relay, func([]byte) {})

	if err := controller.dispatchClick(context.Background(), 1, 100, 200, "left", 2); err != nil {
		t.Fatalf("dispatchClick returned error: %v", err)
	}
	if len(commands) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[1].Params, &pressed); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if pressed["clickCount"] != float64(2) {
		t.Fatalf("expected clickCount 2, got %v", pressed["clickCount"])
	}
	if pressed["button"] != "left" {
		t.Fatalf("expected button left, got %v", pressed["button"])
	}
	if pressed["buttons"] != float64(1) {
		t.Fatalf("expected buttons 1, got %v", pressed["buttons"])
	}
}

func TestDispatchClickTripleClick(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := NewController(relay, func([]byte) {})

	if err := controller.dispatchClick(context.Background(), 1, 100, 200, "left", 3); err != nil {
		t.Fatalf("dispatchClick returned error: %v", err)
	}
	if len(commands) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[1].Params, &pressed); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if pressed["clickCount"] != float64(3) {
		t.Fatalf("expected clickCount 3, got %v", pressed["clickCount"])
	}
}

func TestDispatchClickMiddleButton(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := NewController(relay, func([]byte) {})

	if err := controller.dispatchClick(context.Background(), 1, 100, 200, "middle", 1); err != nil {
		t.Fatalf("dispatchClick returned error: %v", err)
	}
	if len(commands) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[1].Params, &pressed); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if pressed["button"] != "middle" {
		t.Fatalf("expected button middle, got %v", pressed["button"])
	}
	if pressed["buttons"] != float64(4) {
		t.Fatalf("expected buttons 4, got %v", pressed["buttons"])
	}
	if pressed["clickCount"] != float64(1) {
		t.Fatalf("expected clickCount 1, got %v", pressed["clickCount"])
	}
}

func TestDispatchDragUsesMinimalMouseSequence(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := NewController(relay, func([]byte) {})

	if err := controller.dispatchDrag(context.Background(), 1, Point{X: 10, Y: 20}, Point{X: 100, Y: 120}); err != nil {
		t.Fatalf("dispatchDrag returned error: %v", err)
	}
	if len(commands) != 5 {
		t.Fatalf("expected 5 drag commands, got %d", len(commands))
	}
	var first, last map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &first); err != nil {
		t.Fatalf("unmarshal first drag params: %v", err)
	}
	if err := json.Unmarshal(commands[4].Params, &last); err != nil {
		t.Fatalf("unmarshal last drag params: %v", err)
	}
	if first["type"] != "mouseMoved" || first["button"] != "none" {
		t.Fatalf("unexpected first drag event: %#v", first)
	}
	if last["type"] != "mouseReleased" || last["buttons"] != float64(0) {
		t.Fatalf("unexpected last drag event: %#v", last)
	}
}

func TestBrowserTypeVerifiesTextLanded(t *testing.T) {
	tab := tool.BrowserTab{TabID: 61, URL: "https://example.com/orders", Title: "Orders", Controlled: true}
	var sawInsert bool
	var sawVerify bool
	var controller *Controller
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "PierCode.getTab":
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "PierCode.resolveSelectorRect":
			data, _ := json.Marshal(Bounds{X: 10, Y: 20, Width: 100, Height: 30})
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "Input.dispatchMouseEvent", "Input.dispatchKeyEvent":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Input.insertText":
			sawInsert = true
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Runtime.evaluate":
			if !sawInsert {
				t.Fatal("verification ran before Input.insertText")
			}
			sawVerify = true
			data := json.RawMessage(`{"result":{"type":"object","value":{"ok":true,"changed":true,"before":"","after":"Grace Hopper","type":"input"}}}`)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
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

	out, err := controller.Type(context.Background(), tool.BrowserTypeRequest{
		TabID:    intPtr(tab.TabID),
		Selector: "#search",
		Text:     "Grace Hopper",
		Clear:    true,
		CallID:   "type-verify",
	})
	if err != nil {
		t.Fatalf("Type returned error: %v", err)
	}
	if !sawVerify {
		t.Fatal("expected Type to verify the target value after insertText")
	}
	if out == "" {
		t.Fatal("expected non-empty output")
	}
}

func TestBrowserTypeFailsWhenTextDoesNotLand(t *testing.T) {
	tab := tool.BrowserTab{TabID: 62, URL: "https://example.com/orders", Title: "Orders", Controlled: true}
	var controller *Controller
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "PierCode.getTab":
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "PierCode.resolveSelectorRect":
			data, _ := json.Marshal(Bounds{X: 10, Y: 20, Width: 100, Height: 30})
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Runtime.evaluate":
			data := json.RawMessage(`{"result":{"type":"object","value":{"ok":false,"changed":true,"before":"","after":"","type":"input"}}}`)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
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

	_, err := controller.Type(context.Background(), tool.BrowserTypeRequest{
		TabID:    intPtr(tab.TabID),
		Selector: "#search",
		Text:     "Grace Hopper",
		Clear:    true,
		CallID:   "type-fail",
	})
	if err == nil {
		t.Fatal("expected Type to fail when verification reports the text is absent")
	}
}

func TestNavigateWithBeforeunloadAccept(t *testing.T) {
	tab := tool.BrowserTab{TabID: 50, URL: "https://old.example.com", Title: "Old"}
	var controller *Controller
	var relay *RelayManager
	dialogHandled := make(chan map[string]interface{}, 1)

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Page.navigate":
			// Fire the beforeunload dialog event after navigate is sent,
			// so the waiter is definitely set up by now.
			go func() {
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
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
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid dialog params: %v", err)
			}
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

	result, err := controller.NavigateWithBeforeunload(context.Background(), intPtr(tab.TabID), "https://new.example.com", "bu-test", "accept")
	if err != nil {
		t.Fatalf("NavigateWithBeforeunload returned error: %v", err)
	}
	if result.TabID != tab.TabID {
		t.Fatalf("expected tabID %d, got %d", tab.TabID, result.TabID)
	}

	var params map[string]interface{}
	select {
	case params = <-dialogHandled:
	case <-time.After(2 * time.Second):
		t.Fatal("expected Page.handleJavaScriptDialog command to be sent")
	}
	if params["accept"] != true {
		t.Fatalf("expected accept=true, got %#v", params["accept"])
	}
}

func TestNavigateWithBeforeunloadDismiss(t *testing.T) {
	tab := tool.BrowserTab{TabID: 51, URL: "https://old.example.com", Title: "Old"}
	var controller *Controller
	var relay *RelayManager
	dialogHandled := make(chan map[string]interface{}, 1)

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
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid dialog params: %v", err)
			}
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

	result, err := controller.NavigateWithBeforeunload(context.Background(), intPtr(tab.TabID), "https://new.example.com", "bu-test", "dismiss")
	if err != nil {
		t.Fatalf("NavigateWithBeforeunload returned error: %v", err)
	}
	if result.TabID != tab.TabID {
		t.Fatalf("expected tabID %d, got %d", tab.TabID, result.TabID)
	}

	var params map[string]interface{}
	select {
	case params = <-dialogHandled:
	case <-time.After(2 * time.Second):
		t.Fatal("expected Page.handleJavaScriptDialog command to be sent")
	}
	if params["accept"] != false {
		t.Fatalf("expected accept=false, got %#v", params["accept"])
	}
}

func TestNavigateWithBeforeunloadNone(t *testing.T) {
	tab := tool.BrowserTab{TabID: 52, URL: "https://old.example.com", Title: "Old"}
	var commands []Command
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		commands = append(commands, cmd)
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Page.navigate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "PierCode.getTab":
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})

	var controller *Controller
	controller = NewController(relay, func(payload []byte) {
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err != nil {
			t.Fatalf("invalid approval payload: %v", err)
		}
		go controller.DeliverApproval(ApprovalAnswer{ApprovalID: ask.ApprovalID, Approved: true})
	})
	controller.tabs.SetDefault(tab)

	result, err := controller.NavigateWithBeforeunload(context.Background(), intPtr(tab.TabID), "https://new.example.com", "bu-test", "none")
	if err != nil {
		t.Fatalf("NavigateWithBeforeunload returned error: %v", err)
	}
	if result.TabID != tab.TabID {
		t.Fatalf("expected tabID %d, got %d", tab.TabID, result.TabID)
	}

	// With "none" policy, no dialog handler should be set up.
	// Wait briefly to ensure no Page.handleJavaScriptDialog is sent.
	time.Sleep(100 * time.Millisecond)

	for _, cmd := range commands {
		if cmd.Domain == "Page" && cmd.Method == "handleJavaScriptDialog" {
			t.Fatal("expected no Page.handleJavaScriptDialog command for 'none' policy")
		}
	}
}
