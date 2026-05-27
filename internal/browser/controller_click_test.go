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
	relay = NewRelayManager(func(payload []byte) bool {
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
	if len(commands) != 2 {
		t.Fatalf("expected 2 commands (mousePressed + mouseReleased), got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &pressed); err != nil {
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
	if err := json.Unmarshal(commands[1].Params, &released); err != nil {
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
	relay = NewRelayManager(func(payload []byte) bool {
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
	if len(commands) != 2 {
		t.Fatalf("expected 2 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &pressed); err != nil {
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
	relay = NewRelayManager(func(payload []byte) bool {
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
	if len(commands) != 2 {
		t.Fatalf("expected 2 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &pressed); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if pressed["clickCount"] != float64(3) {
		t.Fatalf("expected clickCount 3, got %v", pressed["clickCount"])
	}
}

func TestDispatchClickMiddleButton(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
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
	if len(commands) != 2 {
		t.Fatalf("expected 2 commands, got %d", len(commands))
	}

	var pressed map[string]interface{}
	if err := json.Unmarshal(commands[0].Params, &pressed); err != nil {
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

func TestNavigateWithBeforeunloadAccept(t *testing.T) {
	tab := tool.BrowserTab{TabID: 50, URL: "https://old.example.com", Title: "Old"}
	var controller *Controller
	var relay *RelayManager
	var dialogHandled map[string]interface{}

	relay = NewRelayManager(func(payload []byte) bool {
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
			dialogHandled = params
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

	// Wait for the goroutine to send the dialog command
	deadline := time.After(2 * time.Second)
	for {
		if dialogHandled != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("expected Page.handleJavaScriptDialog command to be sent")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if dialogHandled["accept"] != true {
		t.Fatalf("expected accept=true, got %#v", dialogHandled["accept"])
	}
}

func TestNavigateWithBeforeunloadDismiss(t *testing.T) {
	tab := tool.BrowserTab{TabID: 51, URL: "https://old.example.com", Title: "Old"}
	var controller *Controller
	var relay *RelayManager
	var dialogHandled map[string]interface{}

	relay = NewRelayManager(func(payload []byte) bool {
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
			dialogHandled = params
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

	deadline := time.After(2 * time.Second)
	for {
		if dialogHandled != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("expected Page.handleJavaScriptDialog command to be sent")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if dialogHandled["accept"] != false {
		t.Fatalf("expected accept=false, got %#v", dialogHandled["accept"])
	}
}

func TestNavigateWithBeforeunloadNone(t *testing.T) {
	tab := tool.BrowserTab{TabID: 52, URL: "https://old.example.com", Title: "Old"}
	var commands []Command
	var relay *RelayManager

	relay = NewRelayManager(func(payload []byte) bool {
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
