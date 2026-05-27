package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(fmt.Sprintf(`{"result":{"type":"string","value":%s}}`, valueJSON))})
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
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"[]"}}`)})
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
	var capturedBounds map[string]interface{}

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Browser.getWindowForTarget":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"windowId":42}`)})
		case "Browser.setWindowBounds":
			if err := json.Unmarshal(cmd.Params, &capturedBounds); err != nil {
				t.Fatalf("invalid setWindowBounds params: %v", err)
			}
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
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
	if capturedBounds == nil {
		t.Fatal("expected Browser.setWindowBounds to be called")
	}
	windowID, ok := capturedBounds["windowId"].(float64)
	if !ok || windowID != 42 {
		t.Fatalf("expected windowId 42, got %#v", capturedBounds["windowId"])
	}
	bounds, ok := capturedBounds["bounds"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected bounds map, got %#v", capturedBounds["bounds"])
	}
	if bounds["width"].(float64) != 1280 {
		t.Fatalf("expected width 1280, got %v", bounds["width"])
	}
	if bounds["height"].(float64) != 720 {
		t.Fatalf("expected height 720, got %v", bounds["height"])
	}
}

func TestFormInputCheckbox(t *testing.T) {
	tab := tool.BrowserTab{TabID: 104, URL: "https://example.com/form", Title: "Form"}
	var relay *RelayManager
	var capturedExpression string

	relay = NewRelayManager(func(payload []byte) bool {
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

func TestFormInputContentEditable(t *testing.T) {
	tab := tool.BrowserTab{TabID: 105, URL: "https://example.com/editor", Title: "Editor"}
	var relay *RelayManager
	var capturedExpression string

	relay = NewRelayManager(func(payload []byte) bool {
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

	relay = NewRelayManager(func(payload []byte) bool {
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

func TestReadConsoleReturnsBufferedMessages(t *testing.T) {
	tab := tool.BrowserTab{TabID: 107, URL: "https://example.com", Title: "Console Page"}
	var relay *RelayManager
	runtimeEnabled := false

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Runtime.enable":
			runtimeEnabled = true
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
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

	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "Network.enable":
			networkEnabled = true
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
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
