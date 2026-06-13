package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func float64Ptr(v float64) *float64 { return &v }

func TestFindReturnsScoredResults(t *testing.T) {
	tab := tool.BrowserTab{TabID: 101, URL: "https://example.com", Title: "Find Page"}
	findResultsJSON := `[{"ref":"button.submit","role":"button","text":"Submit","score":5},{"ref":"a.submit-link","role":"a","text":"Submit Order","score":3}]`
	valueJSON, _ := json.Marshal(findResultsJSON)

	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"result":{"type":"string","value":%s}}`, valueJSON))})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	results, err := controller.Find(context.Background(), tool.BrowserFindRequest{
		Query:      "submit",
		MaxResults: 5,
	})
	if err != nil {
		t.Fatalf("Find returned error: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Ref != "button.submit" {
		t.Fatalf("expected first result ref 'button.submit', got %q", results[0].Ref)
	}
	if results[0].Role != "button" {
		t.Fatalf("expected first result role 'button', got %q", results[0].Role)
	}
	if results[0].Text != "Submit" {
		t.Fatalf("expected first result text 'Submit', got %q", results[0].Text)
	}
	if results[0].Score != 5 {
		t.Fatalf("expected first result score 5, got %d", results[0].Score)
	}
	if results[1].Ref != "a.submit-link" {
		t.Fatalf("expected second result ref 'a.submit-link', got %q", results[1].Ref)
	}
	if results[1].Score != 3 {
		t.Fatalf("expected second result score 3, got %d", results[1].Score)
	}
}

func TestFindEmptyQueryReturnsEmpty(t *testing.T) {
	tab := tool.BrowserTab{TabID: 102, URL: "https://example.com", Title: "Find Empty"}

	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"[]"}}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	results, err := controller.Find(context.Background(), tool.BrowserFindRequest{
		Query: "",
	})
	if err != nil {
		t.Fatalf("Find returned error: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 results for empty query, got %d", len(results))
	}
}

func TestResizeSendsWindowBounds(t *testing.T) {
	tab := tool.BrowserTab{TabID: 103, URL: "https://example.com", Title: "Resize Page"}
	var relay *RelayManager
	var capturedParams map[string]interface{}

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "PierCode.resizeWindow":
			if err := json.Unmarshal(cmd.Params, &capturedParams); err != nil {
				t.Fatalf("invalid resizeWindow params: %v", err)
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Resize(context.Background(), tool.BrowserResizeRequest{
		Width:  1280,
		Height: 720,
	})
	if err != nil {
		t.Fatalf("Resize returned error: %v", err)
	}
	if !strings.Contains(out, "1280") || !strings.Contains(out, "720") {
		t.Fatalf("expected dimensions in output, got %q", out)
	}
	if capturedParams == nil {
		t.Fatal("expected PierCode.resizeWindow to be called")
	}
	if tabID, ok := capturedParams["tabId"].(float64); !ok || int(tabID) != tab.TabID {
		t.Fatalf("expected tabId %d, got %#v", tab.TabID, capturedParams["tabId"])
	}
	if capturedParams["width"].(float64) != 1280 {
		t.Fatalf("expected width 1280, got %v", capturedParams["width"])
	}
	if capturedParams["height"].(float64) != 720 {
		t.Fatalf("expected height 720, got %v", capturedParams["height"])
	}
}

func TestFormInputCheckbox(t *testing.T) {
	tab := tool.BrowserTab{TabID: 104, URL: "https://example.com/form", Title: "Form"}
	var relay *RelayManager
	var capturedExpression string

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
			capturedExpression = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"type":"checkbox","checked":true}}}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.FormInput(context.Background(), tool.BrowserFormInputRequest{
		Selector: "#cb",
		Value:    true,
		CallID:   "form-checkbox",
	})
	if err != nil {
		t.Fatalf("FormInput returned error: %v", err)
	}
	if !strings.Contains(out, "#cb") {
		t.Fatalf("expected selector in output, got %q", out)
	}
	if capturedExpression == "" {
		t.Fatal("expected Runtime.evaluate to be called")
	}
	if !strings.Contains(capturedExpression, "#cb") {
		t.Fatalf("expected expression to contain selector '#cb', got %q", capturedExpression)
	}
	if !strings.Contains(capturedExpression, "checkbox") {
		t.Fatalf("expected expression to contain checkbox logic, got %q", capturedExpression)
	}
}

func TestFormInputCheckboxPreservesBooleanFalse(t *testing.T) {
	tab := tool.BrowserTab{TabID: 116, URL: "https://example.com/form", Title: "Form"}
	var relay *RelayManager
	var capturedExpression string

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
			capturedExpression = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"type":"checkbox","checked":false}}}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	if _, err := controller.FormInput(context.Background(), tool.BrowserFormInputRequest{
		Selector: "#cb",
		Value:    false,
		CallID:   "form-checkbox-false",
	}); err != nil {
		t.Fatalf("FormInput returned error: %v", err)
	}
	if !strings.Contains(capturedExpression, ".call(el, false)") {
		t.Fatalf("expected boolean false literal in expression, got %q", capturedExpression)
	}
	if strings.Contains(capturedExpression, ".call(el, \"false\")") {
		t.Fatalf("expected false not to be stringified, got %q", capturedExpression)
	}
}

func TestFormInputContentEditable(t *testing.T) {
	tab := tool.BrowserTab{TabID: 105, URL: "https://example.com/editor", Title: "Editor"}
	var relay *RelayManager
	var capturedExpression string

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
			capturedExpression = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"type":"contenteditable","text":"hello world"}}}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.FormInput(context.Background(), tool.BrowserFormInputRequest{
		Selector: "#editor",
		Value:    "hello world",
		CallID:   "form-contenteditable",
	})
	if err != nil {
		t.Fatalf("FormInput returned error: %v", err)
	}
	if !strings.Contains(out, "#editor") {
		t.Fatalf("expected selector in output, got %q", out)
	}
	if capturedExpression == "" {
		t.Fatal("expected Runtime.evaluate to be called")
	}
	if !strings.Contains(capturedExpression, "isContentEditable") {
		t.Fatalf("expected expression to contain isContentEditable check, got %q", capturedExpression)
	}
	if !strings.Contains(capturedExpression, "insertText") {
		t.Fatalf("expected expression to contain insertText command, got %q", capturedExpression)
	}
}

func TestZoomCapturesRegion(t *testing.T) {
	tab := tool.BrowserTab{TabID: 106, URL: "https://example.com", Title: "Zoom Page"}
	var relay *RelayManager
	var screenshotParams struct {
		Clip struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
			Scale  float64 `json:"scale"`
		} `json:"clip"`
	}
	screenshotCalled := false

	// Provide a small valid JPEG for the screenshot
	imgBytes := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01}
	imgBase64 := base64.StdEncoding.EncodeToString(imgBytes)

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			// Return element bounds for #target
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"x":10,"y":20,"width":200,"height":100}}}`)})
		case "Page.captureScreenshot":
			screenshotCalled = true
			if err := json.Unmarshal(cmd.Params, &screenshotParams); err != nil {
				t.Fatalf("invalid screenshot params: %v", err)
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"data":"%s"}`, imgBase64))})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	w := float64(400)
	h := float64(300)
	resp, err := controller.Zoom(context.Background(), tool.BrowserZoomRequest{
		Selector: "#target",
		Width:    &w,
		Height:   &h,
		CallID:   "zoom-test",
	})
	if err != nil {
		t.Fatalf("Zoom returned error: %v", err)
	}
	if !screenshotCalled {
		t.Fatal("expected Page.captureScreenshot to be called")
	}
	if resp.FilePath == "" {
		t.Fatal("expected non-empty file path in response")
	}
	if resp.Bytes != len(imgBytes) {
		t.Fatalf("expected %d bytes, got %d", len(imgBytes), resp.Bytes)
	}
	// Width/Height from request should override element bounds
	if screenshotParams.Clip.Width != 400 {
		t.Fatalf("expected clip width 400, got %f", screenshotParams.Clip.Width)
	}
	if screenshotParams.Clip.Height != 300 {
		t.Fatalf("expected clip height 300, got %f", screenshotParams.Clip.Height)
	}
	// X/Y should come from element bounds (10, 20)
	if screenshotParams.Clip.X != 10 {
		t.Fatalf("expected clip x 10, got %f", screenshotParams.Clip.X)
	}
	if screenshotParams.Clip.Y != 20 {
		t.Fatalf("expected clip y 20, got %f", screenshotParams.Clip.Y)
	}
}

func TestZoomCapturesRefRegion(t *testing.T) {
	tab := tool.BrowserTab{TabID: 110, URL: "https://example.com", Title: "Zoom Ref Page"}
	var relay *RelayManager
	var screenshotParams struct {
		Clip struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
		} `json:"clip"`
	}

	imgBytes := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01}
	imgBase64 := base64.StdEncoding.EncodeToString(imgBytes)

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Page.captureScreenshot":
			if err := json.Unmarshal(cmd.Params, &screenshotParams); err != nil {
				t.Fatalf("invalid screenshot params: %v", err)
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"data":"%s"}`, imgBase64))})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)
	controller.tabs.StoreSnapshot(tab, "snap_zoom", []RefTarget{{
		Ref:    "e0",
		Role:   "button",
		Name:   "Target",
		Bounds: &Bounds{X: 33, Y: 44, Width: 111, Height: 222},
	}})

	w := float64(50)
	h := float64(60)
	resp, err := controller.Zoom(context.Background(), tool.BrowserZoomRequest{
		Ref:        "e0",
		SnapshotID: "snap_zoom",
		Width:      &w,
		Height:     &h,
		CallID:     "zoom-ref-test",
	})
	if err != nil {
		t.Fatalf("Zoom returned error: %v", err)
	}
	if resp.FilePath == "" {
		t.Fatal("expected non-empty file path in response")
	}
	if screenshotParams.Clip.X != 33 || screenshotParams.Clip.Y != 44 {
		t.Fatalf("expected clip origin 33,44, got %f,%f", screenshotParams.Clip.X, screenshotParams.Clip.Y)
	}
	if screenshotParams.Clip.Width != 50 || screenshotParams.Clip.Height != 60 {
		t.Fatalf("expected clip size 50x60, got %fx%f", screenshotParams.Clip.Width, screenshotParams.Clip.Height)
	}
}

func TestReadConsoleReturnsBufferedMessages(t *testing.T) {
	tab := tool.BrowserTab{TabID: 107, URL: "https://example.com", Title: "Console Page"}
	var relay *RelayManager
	runtimeEnabled := false

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.enable":
			runtimeEnabled = true
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	// Pre-buffer console messages via HandleEvent
	consoleEvent := func(msgType, text string, timestamp float64) {
		params, _ := json.Marshal(map[string]interface{}{
			"type": msgType,
			"args": []map[string]interface{}{
				{"type": "string", "value": text},
			},
			"timestamp": timestamp,
		})
		controller.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Runtime.consoleAPICalled",
			TabID:  tab.TabID,
			Params: params,
		})
	}
	consoleEvent("log", "page loaded", 1000)
	consoleEvent("error", "something failed", 2000)
	consoleEvent("warn", "deprecation warning", 3000)

	out, err := controller.ReadConsole(context.Background(), tool.BrowserConsoleRequest{
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ReadConsole returned error: %v", err)
	}
	if !runtimeEnabled {
		t.Fatal("expected Runtime.enable to be called")
	}
	if !strings.Contains(out, "page loaded") {
		t.Fatalf("expected 'page loaded' in output, got %q", out)
	}
	if !strings.Contains(out, "something failed") {
		t.Fatalf("expected 'something failed' in output, got %q", out)
	}
	if !strings.Contains(out, "deprecation warning") {
		t.Fatalf("expected 'deprecation warning' in output, got %q", out)
	}
	if !strings.Contains(out, "3") {
		t.Fatalf("expected message count 3 in output, got %q", out)
	}
}

func TestReadNetworkReturnsBufferedRequests(t *testing.T) {
	tab := tool.BrowserTab{TabID: 108, URL: "https://example.com", Title: "Network Page"}
	var relay *RelayManager
	networkEnabled := false

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Network.enable":
			networkEnabled = true
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	// Pre-buffer network requests via HandleEvent
	networkEvent := func(requestID, method, url, reqType string, timestamp float64) {
		params, _ := json.Marshal(map[string]interface{}{
			"requestId": requestID,
			"request": map[string]interface{}{
				"url":    url,
				"method": method,
			},
			"type":      reqType,
			"timestamp": timestamp,
		})
		controller.HandleEvent(Event{
			Type:   "browser_event",
			Event:  "Network.requestWillBeSent",
			TabID:  tab.TabID,
			Params: params,
		})
	}
	networkEvent("req-1", "GET", "https://example.com/api/data", "XHR", 1000)
	networkEvent("req-2", "POST", "https://example.com/api/submit", "Fetch", 2000)
	networkEvent("req-3", "GET", "https://cdn.example.com/style.css", "Stylesheet", 3000)

	out, err := controller.ReadNetwork(context.Background(), tool.BrowserNetworkLogRequest{
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ReadNetwork returned error: %v", err)
	}
	if !networkEnabled {
		t.Fatal("expected Network.enable to be called")
	}
	if !strings.Contains(out, "GET") {
		t.Fatalf("expected 'GET' in output, got %q", out)
	}
	if !strings.Contains(out, "POST") {
		t.Fatalf("expected 'POST' in output, got %q", out)
	}
	if !strings.Contains(out, "example.com/api/data") {
		t.Fatalf("expected 'example.com/api/data' in output, got %q", out)
	}
	if !strings.Contains(out, "XHR") {
		t.Fatalf("expected 'XHR' in output, got %q", out)
	}
	if !strings.Contains(out, "3") {
		t.Fatalf("expected request count 3 in output, got %q", out)
	}
}

func TestReadNetworkFormatsStatusTextAndDuration(t *testing.T) {
	tab := tool.BrowserTab{TabID: 115, URL: "https://example.com", Title: "Network Format"}
	var relay *RelayManager

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Network.enable":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	// Buffer a request
	reqParams, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-fmt",
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
		TabID:  tab.TabID,
		Params: reqParams,
	})

	// Buffer the response with statusText and timestamp for duration calculation
	respParams, _ := json.Marshal(map[string]interface{}{
		"requestId": "req-fmt",
		"timestamp": float64(1000.25),
		"response": map[string]interface{}{
			"status":     200,
			"statusText": "OK",
			"mimeType":   "application/json",
		},
	})
	controller.HandleEvent(Event{
		Type:   "browser_event",
		Event:  "Network.responseReceived",
		TabID:  tab.TabID,
		Params: respParams,
	})

	out, err := controller.ReadNetwork(context.Background(), tool.BrowserNetworkLogRequest{Limit: 10})
	if err != nil {
		t.Fatalf("ReadNetwork returned error: %v", err)
	}
	if !strings.Contains(out, "OK") {
		t.Fatalf("expected statusText 'OK' in output, got %q", out)
	}
	if !strings.Contains(out, "200") {
		t.Fatalf("expected status code 200 in output, got %q", out)
	}
	if !strings.Contains(out, "ms") {
		t.Fatalf("expected duration 'ms' in output, got %q", out)
	}
}

func TestCookiesRequiresApprovalBeforeRelayCommand(t *testing.T) {
	var commandSent bool
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		commandSent = true
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"cookies":[],"count":0,"total":0,"includeValue":true}`)})
		return true
	})

	var controller *Controller
	var askSeen ApprovalAsk
	controller = NewController(relay, func(payload []byte) {
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err != nil {
			t.Fatalf("invalid approval payload: %v", err)
		}
		if ask.Type != "browser_approval_ask" {
			return
		}
		askSeen = ask
		go controller.DeliverApproval(ApprovalAnswer{ApprovalID: ask.ApprovalID, Approved: false, Reason: "no cookies"})
	})

	_, err := controller.Cookies(context.Background(), tool.BrowserCookiesRequest{
		URL:          "https://example.com",
		IncludeValue: true,
	})
	if err == nil || !strings.Contains(err.Error(), "no cookies") {
		t.Fatalf("expected approval rejection, got %v", err)
	}
	if commandSent {
		t.Fatal("cookies command should not be sent before approval")
	}
	if askSeen.Action != "read browser cookies" {
		t.Fatalf("unexpected approval action: %q", askSeen.Action)
	}
	if !strings.Contains(askSeen.Target, "https://example.com") {
		t.Fatalf("approval target should include requested scope, got %q", askSeen.Target)
	}
	if !strings.Contains(askSeen.Risk, "values") {
		t.Fatalf("approval risk should mention cookie values, got %q", askSeen.Risk)
	}
}

func TestZoomRespectsOutputDir(t *testing.T) {
	tab := tool.BrowserTab{TabID: 109, URL: "https://example.com", Title: "Zoom OutputDir"}
	var relay *RelayManager

	imgBytes := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01}
	imgBase64 := base64.StdEncoding.EncodeToString(imgBytes)

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"object","value":{"x":0,"y":0,"width":100,"height":100}}}`)})
		case "Page.captureScreenshot":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"data":"%s"}`, imgBase64))})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	outputDir := filepath.Join(t.TempDir(), "zoom-output")
	defer os.RemoveAll(outputDir)

	w := float64(100)
	h := float64(100)
	resp, err := controller.Zoom(context.Background(), tool.BrowserZoomRequest{
		Selector:  "#target",
		Width:     &w,
		Height:    &h,
		CallID:    "zoom-outputdir",
		OutputDir: outputDir,
	})
	if err != nil {
		t.Fatalf("Zoom returned error: %v", err)
	}
	if resp.FilePath == "" {
		t.Fatal("expected non-empty file path in response")
	}
	// Verify the file was written to the custom output directory
	if !strings.HasPrefix(resp.FilePath, outputDir) {
		t.Fatalf("expected file path to start with %q, got %q", outputDir, resp.FilePath)
	}
	// Verify the file exists
	if _, err := os.Stat(resp.FilePath); os.IsNotExist(err) {
		t.Fatalf("expected screenshot file to exist at %s", resp.FilePath)
	}
}

func TestFindCarriesIframeCoordinates(t *testing.T) {
	tab := tool.BrowserTab{TabID: 102, URL: "https://example.com", Title: "Frames"}
	// Simulate what the in-page heuristic returns for a same-origin iframe match:
	// a result with absolute x/y + frame URL (no usable top-level selector).
	findResultsJSON := `[{"ref":"input[name=\"card\"]","role":"textbox","text":"Card number","score":7,"x":420,"y":260,"frame":"https://example.com/embed"}]`
	valueJSON, _ := json.Marshal(findResultsJSON)

	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		if cmd.Domain+"."+cmd.Method == "Runtime.evaluate" {
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"result":{"type":"string","value":%s}}`, valueJSON))})
		} else if cmd.Domain+"."+cmd.Method == "PierCode.listFrameSessions" {
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[]}`)})
		} else {
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	results, err := controller.Find(context.Background(), tool.BrowserFindRequest{Query: "card", MaxResults: 5})
	if err != nil {
		t.Fatalf("Find error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	r := results[0]
	if r.X == nil || r.Y == nil {
		t.Fatal("iframe match must carry absolute x/y")
	}
	if *r.X != 420 || *r.Y != 260 {
		t.Fatalf("expected x=420 y=260, got x=%v y=%v", *r.X, *r.Y)
	}
	if r.Frame != "https://example.com/embed" {
		t.Fatalf("expected frame URL, got %q", r.Frame)
	}
}

func TestFindTraversesOOPIFFrames(t *testing.T) {
	tab := tool.BrowserTab{TabID: 90, URL: "https://app.example.com", Title: "App", Controlled: true}
	// Main-frame find returns one match; the OOPIF session returns another.
	mainResults := `[{"ref":"#pay","role":"button","text":"Pay main","score":7}]`
	frameResults := `[{"ref":"input.card","role":"textbox","text":"Card number","score":7}]`
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			// Main session (no sessionId) vs frame session.
			val := mainResults
			if cmd.SessionID == "FRAME-1" {
				val = frameResults
			}
			b, _ := json.Marshal(val)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"result":{"type":"string","value":%s}}`, string(b)))})
		case "PierCode.listFrameSessions":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"sessions":[{"sessionId":"FRAME-1","url":"https://js.stripe.com/v3/"}]}`)})
		case "Accessibility.getFullAXTree":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"nodes":[]}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	results, err := controller.Find(context.Background(), tool.BrowserFindRequest{Query: "card", MaxResults: 20})
	if err != nil {
		t.Fatalf("Find error: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected main + frame match (2), got %d: %+v", len(results), results)
	}
	// The frame match must be tagged and have its frame-scoped selector cleared.
	var frameMatch *tool.BrowserFindResult
	for i := range results {
		if strings.Contains(results[i].Text, "in iframe") {
			frameMatch = &results[i]
		}
	}
	if frameMatch == nil {
		t.Fatalf("no iframe-tagged match found: %+v", results)
	}
	if frameMatch.Ref != "" {
		t.Fatalf("frame-scoped selector must be cleared, got %q", frameMatch.Ref)
	}
	if !strings.Contains(frameMatch.Text, "stripe.com") {
		t.Fatalf("frame match should name its frame url, got %q", frameMatch.Text)
	}
}
