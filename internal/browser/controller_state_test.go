package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestStorageSetBuildsExpression(t *testing.T) {
	tab := tool.BrowserTab{TabID: 201, URL: "https://example.com", Title: "Storage"}
	var capturedExpr string
	var relay *RelayManager
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
			_ = json.Unmarshal(cmd.Params, &params)
			capturedExpr = params.Expression
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"ok"}}`)})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Storage(context.Background(), tool.BrowserStorageRequest{
		Action:  "set",
		Storage: "local",
		Key:     "token",
		Value:   "abc",
	})
	if err != nil {
		t.Fatalf("Storage returned error: %v", err)
	}
	if !strings.Contains(capturedExpr, "localStorage.setItem") {
		t.Fatalf("expected localStorage.setItem in expression, got %q", capturedExpr)
	}
	if !strings.Contains(capturedExpr, "token") || !strings.Contains(capturedExpr, "abc") {
		t.Fatalf("expected key/value in expression, got %q", capturedExpr)
	}
	if !strings.Contains(out, "localStorage") || !strings.Contains(out, "set") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestStorageSessionGet(t *testing.T) {
	tab := tool.BrowserTab{TabID: 202, URL: "https://example.com", Title: "Storage"}
	var capturedExpr string
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var params struct {
			Expression string `json:"expression"`
		}
		_ = json.Unmarshal(cmd.Params, &params)
		capturedExpr = params.Expression
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"v1"}}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	if _, err := controller.Storage(context.Background(), tool.BrowserStorageRequest{
		Action:  "get",
		Storage: "session",
		Key:     "k",
	}); err != nil {
		t.Fatalf("Storage returned error: %v", err)
	}
	if !strings.Contains(capturedExpr, "sessionStorage.getItem") {
		t.Fatalf("expected sessionStorage.getItem, got %q", capturedExpr)
	}
}

func TestEmulateAppliesColorSchemeAndTimezone(t *testing.T) {
	tab := tool.BrowserTab{TabID: 203, URL: "https://example.com", Title: "Emulate"}
	var methods []string
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		if cmd.Domain != "Emulation" {
			t.Fatalf("expected Emulation domain, got %s", cmd.Domain)
		}
		methods = append(methods, cmd.Method)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Emulate(context.Background(), tool.BrowserEmulateRequest{
		ColorScheme: "dark",
		Timezone:    "America/New_York",
	})
	if err != nil {
		t.Fatalf("Emulate returned error: %v", err)
	}
	if !contains(methods, "setEmulatedMedia") {
		t.Fatalf("expected setEmulatedMedia, got %v", methods)
	}
	if !contains(methods, "setTimezoneOverride") {
		t.Fatalf("expected setTimezoneOverride, got %v", methods)
	}
	if !strings.Contains(out, "applied emulation") {
		t.Fatalf("unexpected output: %q", out)
	}
}

func TestEmulateResetClears(t *testing.T) {
	tab := tool.BrowserTab{TabID: 204, URL: "https://example.com", Title: "Emulate Reset"}
	var methods []string
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		methods = append(methods, cmd.Method)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	if _, err := controller.Emulate(context.Background(), tool.BrowserEmulateRequest{Reset: true}); err != nil {
		t.Fatalf("Emulate reset returned error: %v", err)
	}
	if !contains(methods, "clearDeviceMetricsOverride") || !contains(methods, "clearGeolocationOverride") {
		t.Fatalf("expected clear overrides, got %v", methods)
	}
}

func TestGetAttributesSelector(t *testing.T) {
	tab := tool.BrowserTab{TabID: 205, URL: "https://example.com", Title: "Attrs"}
	var capturedExpr string
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var params struct {
			Expression string `json:"expression"`
		}
		_ = json.Unmarshal(cmd.Params, &params)
		capturedExpr = params.Expression
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"{\"tag\":\"a\",\"attributes\":{\"href\":\"/x\"},\"styles\":{}}"}}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.GetAttributes(context.Background(), tool.BrowserGetAttributesRequest{
		Selector:   "a.link",
		Attributes: []string{"href"},
		Styles:     []string{"color"},
	})
	if err != nil {
		t.Fatalf("GetAttributes returned error: %v", err)
	}
	if !strings.Contains(capturedExpr, "a.link") {
		t.Fatalf("expected selector in expression, got %q", capturedExpr)
	}
	if !strings.Contains(capturedExpr, "getComputedStyle") {
		t.Fatalf("expected getComputedStyle in expression, got %q", capturedExpr)
	}
	if !strings.Contains(out, "href") {
		t.Fatalf("expected href in output, got %q", out)
	}
}

func TestWaitForNavigationMatchesURL(t *testing.T) {
	tab := tool.BrowserTab{TabID: 206, URL: "https://example.com", Title: "Nav"}
	var capturedExpr string
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var params struct {
			Expression string `json:"expression"`
		}
		_ = json.Unmarshal(cmd.Params, &params)
		capturedExpr = params.Expression
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"type":"string","value":"https://example.com/done"}}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.WaitForNavigation(context.Background(), tool.BrowserWaitForNavigationRequest{
		URLPattern:     "/done",
		WaitUntil:      "load",
		TimeoutSeconds: 5,
	})
	if err != nil {
		t.Fatalf("WaitForNavigation returned error: %v", err)
	}
	if !strings.Contains(capturedExpr, "/done") {
		t.Fatalf("expected urlPattern in expression, got %q", capturedExpr)
	}
	if !strings.Contains(out, "example.com/done") {
		t.Fatalf("expected final url in output, got %q", out)
	}
}

func TestSetCookieSendsNativeCommand(t *testing.T) {
	tab := tool.BrowserTab{TabID: 207, URL: "https://example.com", Title: "Cookie"}
	var capturedParams map[string]interface{}
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		if cmd.Domain+"."+cmd.Method != "PierCode.setCookie" {
			t.Fatalf("expected PierCode.setCookie, got %s.%s", cmd.Domain, cmd.Method)
		}
		_ = json.Unmarshal(cmd.Params, &capturedParams)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"ok":true,"name":"sid","domain":".example.com"}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.SetCookie(context.Background(), tool.BrowserSetCookieRequest{
		Action: "set",
		Name:   "sid",
		Value:  "xyz",
		Domain: ".example.com",
		CallID: "cookie-set",
	})
	if err != nil {
		t.Fatalf("SetCookie returned error: %v", err)
	}
	if capturedParams["name"] != "sid" || capturedParams["value"] != "xyz" {
		t.Fatalf("unexpected native params: %#v", capturedParams)
	}
	if !strings.Contains(out, "sid") {
		t.Fatalf("expected cookie name in output, got %q", out)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
