package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func TestStorageSetBuildsExpression(t *testing.T) {
	tab := tool.BrowserTab{TabID: 201, URL: "https://example.com", Title: "Storage"}
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
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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

func TestWaitForNavigationResolvesOnLifecycleEvent(t *testing.T) {
	// The rewritten WaitForNavigation is event-driven (CDP Page lifecycle/load),
	// not in-page polling, so it survives JS-context destruction. The mock only
	// answers PierCode.getTab (final-URL lookup); the resolving signal arrives as
	// a Page.loadEventFired event injected into the controller's EventBus.
	tab := tool.BrowserTab{TabID: 206, URL: "https://example.com/done", Title: "Nav"}
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		if cmd.Domain+"."+cmd.Method == "PierCode.getTab" {
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		} else {
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	// Fire the load event shortly after the wait begins.
	go func() {
		time.Sleep(50 * time.Millisecond)
		controller.HandleEvent(Event{Event: "Page.loadEventFired", TabID: tab.TabID})
	}()

	out, err := controller.WaitForNavigation(context.Background(), tool.BrowserWaitForNavigationRequest{
		WaitUntil:      "load",
		TimeoutSeconds: 5,
	})
	if err != nil {
		t.Fatalf("WaitForNavigation returned error: %v", err)
	}
	if !strings.Contains(out, "example.com/done") {
		t.Fatalf("expected final url in output, got %q", out)
	}
	if !strings.Contains(out, "load") {
		t.Fatalf("expected the lifecycle kind in output, got %q", out)
	}
}

func TestWaitForNavigationTimesOut(t *testing.T) {
	tab := tool.BrowserTab{TabID: 209, URL: "https://example.com", Title: "Nav"}
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		if cmd.Domain+"."+cmd.Method == "PierCode.getTab" {
			data, _ := json.Marshal(tab)
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		} else {
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		}
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	// No nav event is ever fired → must time out, not hang past the deadline.
	_, err := controller.WaitForNavigation(context.Background(), tool.BrowserWaitForNavigationRequest{
		WaitUntil:      "load",
		TimeoutSeconds: 1,
	})
	if err == nil {
		t.Fatal("expected timeout error when no navigation event fires")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}
}

func TestSetCookieSendsNativeCommand(t *testing.T) {
	tab := tool.BrowserTab{TabID: 207, URL: "https://example.com", Title: "Cookie"}
	var capturedParams map[string]interface{}
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
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

func TestEmulateNetworkThrottle(t *testing.T) {
	tab := tool.BrowserTab{TabID: 211, URL: "https://example.com", Title: "Throttle"}
	var sawNetworkEnable, sawEmulateConditions bool
	var condOffline interface{}
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		switch cmd.Domain + "." + cmd.Method {
		case "Network.enable":
			sawNetworkEnable = true
		case "Network.emulateNetworkConditions":
			sawEmulateConditions = true
			var p map[string]interface{}
			_ = json.Unmarshal(cmd.Params, &p)
			condOffline = p["offline"]
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	controller := newApprovedController(relay)
	controller.tabs.SetDefault(tab)

	out, err := controller.Emulate(context.Background(), tool.BrowserEmulateRequest{Network: "slow-3g"})
	if err != nil {
		t.Fatalf("Emulate(network) error: %v", err)
	}
	if !sawNetworkEnable {
		t.Fatal("expected Network.enable before throttling")
	}
	if !sawEmulateConditions {
		t.Fatal("expected Network.emulateNetworkConditions")
	}
	if condOffline != false {
		t.Fatalf("slow-3g profile should not be offline, got offline=%v", condOffline)
	}
	if !strings.Contains(out, "emulateNetworkConditions") {
		t.Fatalf("output should report the throttle, got %q", out)
	}
}
