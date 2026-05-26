package browser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestUploadUsesCDPSetFileInputFiles(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "upload.txt")
	if err := os.WriteFile(filePath, []byte("upload-data"), 0o644); err != nil {
		t.Fatalf("write upload fixture: %v", err)
	}
	tab := tool.BrowserTab{TabID: 78, URL: "https://example.com/upload", Title: "Upload"}
	var controller *Controller
	var relay *RelayManager
	var uploaded []string

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","objectId":"file-input"}}`)})
		case "DOM.setFileInputFiles":
			var params struct {
				Files []string `json:"files"`
			}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid upload params: %v", err)
			}
			uploaded = params.Files
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "Runtime.callFunctionOn", "Runtime.releaseObject":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"ok":true}}}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller = newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Upload(context.Background(), tool.BrowserUploadRequest{
		Selector: "#file",
		Paths:    []string{filePath},
		CallID:   "upload-test",
	})
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if !strings.Contains(out, "DOM.setFileInputFiles") {
		t.Fatalf("expected CDP upload path in output, got %q", out)
	}
	if len(uploaded) != 1 || uploaded[0] != filePath {
		t.Fatalf("unexpected uploaded files: %#v", uploaded)
	}
}

func TestUploadFallsBackToDataTransferWhenCDPSetFilesFails(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "fallback.txt")
	if err := os.WriteFile(filePath, []byte("fallback-data"), 0o644); err != nil {
		t.Fatalf("write upload fixture: %v", err)
	}
	tab := tool.BrowserTab{TabID: 79, URL: "https://example.com/upload", Title: "Upload"}
	var controller *Controller
	var relay *RelayManager
	var fallbackCalled bool

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","objectId":"file-input"}}`)})
		case "DOM.setFileInputFiles":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "setFileInputFiles blocked"})
		case "Runtime.callFunctionOn":
			if strings.Contains(string(cmd.Params), "DataTransfer") {
				fallbackCalled = true
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"ok":true}}}`)})
		case "Runtime.releaseObject":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller = newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Upload(context.Background(), tool.BrowserUploadRequest{
		Selector: "#file",
		Paths:    []string{filePath},
		CallID:   "upload-fallback-test",
	})
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if !strings.Contains(out, "DataTransfer fallback") {
		t.Fatalf("expected fallback upload path in output, got %q", out)
	}
	if !fallbackCalled {
		t.Fatal("expected fallback Runtime.callFunctionOn to use DataTransfer")
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

func newApprovedController(relay *RelayManager) *Controller {
	var controller *Controller
	controller = NewController(relay, func(payload []byte) {
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err == nil {
			go controller.DeliverApproval(ApprovalAnswer{ApprovalID: ask.ApprovalID, Approved: true})
		}
	})
	return controller
}
