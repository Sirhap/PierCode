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

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go func() {
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
				// Small delay to ensure HandleDialog has called WaitForDialog before event arrives
				time.Sleep(10 * time.Millisecond)
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

func TestHandleDialogDoesNotMissDialogDuringPageEnable(t *testing.T) {
	tab := tool.BrowserTab{TabID: 81, URL: "https://example.com/dialog", Title: "Dialog"}
	var controller *Controller
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.enable":
			go func() {
				controller.HandleEvent(dialogEvent(tab.TabID, "alert", "Already open"))
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
			}()
		case "Page.handleJavaScriptDialog":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})

	controller = newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.HandleDialog(context.Background(), tool.BrowserHandleDialogRequest{
		Action:         "accept",
		TimeoutSeconds: 1,
		CallID:         "dialog-enable-race",
	})
	if err != nil {
		t.Fatalf("HandleDialog returned error: %v", err)
	}
	if !strings.Contains(out, "Already open") {
		t.Fatalf("expected dialog message in output, got %q", out)
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

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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

func TestUploadFallsBackToPageEventsWhenFileInputMissing(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "gemini.jpg")
	if err := os.WriteFile(filePath, []byte("jpg-data"), 0o644); err != nil {
		t.Fatalf("write upload fixture: %v", err)
	}
	tab := tool.BrowserTab{TabID: 82, URL: "https://gemini.google.com/app/test", Title: "Gemini"}
	var controller *Controller
	var relay *RelayManager
	var fallbackExpr string
	resolveAttempts := 0

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			var params struct {
				Expression string `json:"expression"`
			}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid evaluate params: %v", err)
			}
			expr := params.Expression
			if strings.Contains(expr, "findUploadEventTarget") {
				fallbackExpr = expr
				go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"count":1}}}`)})
				return true
			}
			resolveAttempts++
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "Element not found: input[type='file']"})
		case "Runtime.releaseObject":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller = newApprovedController(relay)
	controller.tabs.SetDefault(tab)
	// The default tab here is an AI page (gemini.google.com); ensureTab now
	// enforces the browser_use_tab approval gate on the default-tab path too,
	// so mirror UseTab's SetDefault+MarkApproved pairing.
	controller.tabs.MarkApproved(tab.TabID)

	out, err := controller.Upload(context.Background(), tool.BrowserUploadRequest{
		Selector: "input[type='file']",
		Paths:    []string{filePath},
		CallID:   "upload-page-event-fallback-test",
	})
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if !strings.Contains(out, "page event fallback") {
		t.Fatalf("expected page event fallback in output, got %q", out)
	}
	if resolveAttempts != 2 {
		t.Fatalf("expected CDP and DataTransfer selector attempts before page fallback, got %d", resolveAttempts)
	}
	if !strings.Contains(fallbackExpr, ".xap-uploader-dropzone") || !strings.Contains(fallbackExpr, "ClipboardEvent") || !strings.Contains(fallbackExpr, "DragEvent") {
		t.Fatalf("expected fallback expression to dispatch upload events to Gemini dropzone, got: %s", fallbackExpr)
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

func TestSelectByLabelExpressionContainsValidation(t *testing.T) {
	tab := tool.BrowserTab{TabID: 80, URL: "https://example.com/select", Title: "Select"}
	var capturedExpr string
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			var params struct {
				Expression string `json:"expression"`
			}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid evaluate params: %v", err)
			}
			capturedExpr = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"selected":"opt1","selectedIndex":0}}}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	_, err := controller.Select(context.Background(), tool.BrowserSelectRequest{
		Selector: "#myselect",
		Value:    "Option A",
		By:       "label",
		CallID:   "select-label-test",
	})
	if err != nil {
		t.Fatalf("Select returned error: %v", err)
	}
	if capturedExpr == "" {
		t.Fatal("expected JS expression to be captured")
	}
	if !strings.Contains(capturedExpr, "by === 'label'") {
		t.Fatalf("expected label validation in expression, got: %s", capturedExpr)
	}
	if !strings.Contains(capturedExpr, "No option with label") {
		t.Fatalf("expected label mismatch error message in expression, got: %s", capturedExpr)
	}
}

func TestSelectByIndexExpressionContainsValidation(t *testing.T) {
	tab := tool.BrowserTab{TabID: 81, URL: "https://example.com/select", Title: "Select"}
	var capturedExpr string
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			var params struct {
				Expression string `json:"expression"`
			}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid evaluate params: %v", err)
			}
			capturedExpr = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"selected":"opt2","selectedIndex":1}}}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	_, err := controller.Select(context.Background(), tool.BrowserSelectRequest{
		Selector: "#myselect",
		Value:    "1",
		By:       "index",
		CallID:   "select-index-test",
	})
	if err != nil {
		t.Fatalf("Select returned error: %v", err)
	}
	if capturedExpr == "" {
		t.Fatal("expected JS expression to be captured")
	}
	if !strings.Contains(capturedExpr, "by === 'index'") {
		t.Fatalf("expected index validation in expression, got: %s", capturedExpr)
	}
	if !strings.Contains(capturedExpr, "isNaN") {
		t.Fatalf("expected NaN check in expression, got: %s", capturedExpr)
	}
	if !strings.Contains(capturedExpr, "out of range") {
		t.Fatalf("expected bounds check in expression, got: %s", capturedExpr)
	}
}

func TestSelectByLabelMismatchPropagatesError(t *testing.T) {
	tab := tool.BrowserTab{TabID: 82, URL: "https://example.com/select", Title: "Select"}
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: `No option with label "Nonexistent". Available: Option A, Option B`})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	_, err := controller.Select(context.Background(), tool.BrowserSelectRequest{
		Selector: "#myselect",
		Value:    "Nonexistent",
		By:       "label",
		CallID:   "select-label-err",
	})
	if err == nil {
		t.Fatal("expected error for label mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "Nonexistent") {
		t.Fatalf("expected error to mention the label, got: %v", err)
	}
}

func TestSelectByIndexOutOfBoundsPropagatesError(t *testing.T) {
	tab := tool.BrowserTab{TabID: 83, URL: "https://example.com/select", Title: "Select"}
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "Index 99 out of range (0-2)"})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	_, err := controller.Select(context.Background(), tool.BrowserSelectRequest{
		Selector: "#myselect",
		Value:    "99",
		By:       "index",
		CallID:   "select-index-err",
	})
	if err == nil {
		t.Fatal("expected error for out-of-bounds index, got nil")
	}
	if !strings.Contains(err.Error(), "out of range") {
		t.Fatalf("expected error to mention range, got: %v", err)
	}
}

func TestSelectByDefaultUsesValue(t *testing.T) {
	tab := tool.BrowserTab{TabID: 84, URL: "https://example.com/select", Title: "Select"}
	var capturedExpr string
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			var params struct {
				Expression string `json:"expression"`
			}
			_ = json.Unmarshal(cmd.Params, &params)
			capturedExpr = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"selected":"opt1","selectedIndex":0}}}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	_, err := controller.Select(context.Background(), tool.BrowserSelectRequest{
		Selector: "#myselect",
		Value:    "opt1",
		CallID:   "select-default-test",
	})
	if err != nil {
		t.Fatalf("Select returned error: %v", err)
	}
	// The JS function always contains all branches, but the by parameter should default to "value"
	if !strings.Contains(capturedExpr, `"opt1", "value"`) {
		t.Fatalf("expected default 'value' as by parameter in expression, got: %s", capturedExpr)
	}
}

func TestEvaluateExpressionNoDeadFetchXHRCode(t *testing.T) {
	expr := evaluateExpression("document.title")
	if strings.Contains(expr, "_fetch") {
		t.Fatal("evaluateExpression should not contain _fetch save/restore dead code")
	}
	if strings.Contains(expr, "_open") {
		t.Fatal("evaluateExpression should not contain _open save/restore dead code")
	}
	if strings.Contains(expr, "XMLHttpRequest") {
		t.Fatal("evaluateExpression should not reference XMLHttpRequest")
	}
}

func TestWaitForFunctionExpressionNoDeadFetchXHRCode(t *testing.T) {
	expr := waitForFunctionExpression("document.readyState === 'complete'", 5*time.Second)
	if strings.Contains(expr, "_fetch") {
		t.Fatal("waitForFunctionExpression should not contain _fetch save/restore dead code")
	}
	if strings.Contains(expr, "_open") {
		t.Fatal("waitForFunctionExpression should not contain _open save/restore dead code")
	}
	if strings.Contains(expr, "XMLHttpRequest") {
		t.Fatal("waitForFunctionExpression should not reference XMLHttpRequest")
	}
}

// TestEnsureTabRefusesUnapprovedAIDefault locks the regression: the implicit
// default-tab path must apply the same AI-page approval gate as the explicit
// tabID path, instead of silently driving an AI conversation page.
func TestEnsureTabRefusesUnapprovedAIDefault(t *testing.T) {
	relay := NewRelayManagerFromSend(func(payload []byte) bool { return true })
	controller := newApprovedController(relay)
	tab := tool.BrowserTab{TabID: 91, URL: "https://chat.qwen.ai/c/worker", Title: "Worker"}
	controller.tabs.SetDefault(tab)

	_, err := controller.ensureTab(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "browser_use_tab") {
		t.Fatalf("expected unapproved AI default tab to be refused, got err=%v", err)
	}

	controller.tabs.MarkApproved(tab.TabID)
	got, err := controller.ensureTab(context.Background(), nil)
	if err != nil {
		t.Fatalf("approved AI default tab should be usable: %v", err)
	}
	if got.TabID != tab.TabID {
		t.Fatalf("ensureTab returned tab %d, want %d", got.TabID, tab.TabID)
	}
}

// TestNewTabAIPageDoesNotBecomeDefault locks the spawn_agent side: opening a
// worker tab on an AI host must not hijack the default browser-tool target.
func TestNewTabAIPageDoesNotBecomeDefault(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			return false
		}
		if cmd.Domain == "PierCode" && cmd.Method == "createTab" {
			var params struct {
				URL        string `json:"url"`
				Controlled *bool  `json:"controlled"`
			}
			_ = json.Unmarshal(cmd.Params, &params)
			if params.Controlled == nil || *params.Controlled {
				// AI-page tabs must tell the background not to mark them controlled.
				go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "expected controlled=false for AI page"})
				return true
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"tabId":77,"url":"` + params.URL + `","title":"Worker"}`)})
			return true
		}
		return true
	})
	controller := newApprovedController(relay)
	prev := tool.BrowserTab{TabID: 5, URL: "https://example.com/", Title: "Prev"}
	controller.tabs.SetDefault(prev)

	tab, err := controller.NewTab(context.Background(), "https://chat.qwen.ai/?piercode_agent=agent-x")
	if err != nil {
		t.Fatalf("NewTab returned error: %v", err)
	}
	if tab.Controlled {
		t.Fatalf("AI worker tab must not be marked controlled")
	}
	def, ok := controller.tabs.DefaultTab()
	if !ok || def.TabID != prev.TabID {
		t.Fatalf("default tab changed to %+v, want previous tab %d", def, prev.TabID)
	}
	if controller.tabs.TrackingSource(tab.TabID) != "created" {
		t.Fatalf("worker tab should still be tracked as created for finalize/cleanup")
	}
}
