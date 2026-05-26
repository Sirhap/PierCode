package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func TestHandleDialogAcceptsRelayedJavaScriptDialog(t *testing.T) {
	tab := tool.BrowserTab{TabID: 77, URL: "https://example.com/dialog", Title: "Dialog"}
	var controller *Controller
	var relay *RelayManager
	handled := make(chan map[string]interface{}, 1)

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go func() {
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
				controller.HandleEvent(dialogEvent(tab.TabID, "prompt", "Name?"))
			}()
		case "Page.handleJavaScriptDialog":
			var params map[string]interface{}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid dialog params: %v", err)
			}
			handled <- params
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

	out, err := controller.HandleDialog(context.Background(), tool.BrowserHandleDialogRequest{
		Action:         "accept",
		PromptText:     "PierCode",
		TimeoutSeconds: 1,
		CallID:         "dialog-test",
	})
	if err != nil {
		t.Fatalf("HandleDialog returned error: %v", err)
	}
	if out == "" {
		t.Fatal("expected non-empty HandleDialog output")
	}

	select {
	case params := <-handled:
		if params["accept"] != true {
			t.Fatalf("expected accept=true, got %#v", params)
		}
		if params["promptText"] != "PierCode" {
			t.Fatalf("expected promptText to be forwarded, got %#v", params)
		}
	case <-time.After(time.Second):
		t.Fatal("expected Page.handleJavaScriptDialog command")
	}
}

func dialogEvent(tabID int, typ, message string) Event {
	params, _ := json.Marshal(map[string]string{
		"type":    typ,
		"message": message,
		"url":     "https://example.com/dialog",
	})
	return Event{
		Type:   "browser_event",
		Event:  "Page.javascriptDialogOpening",
		TabID:  tabID,
		Params: params,
	}
}
