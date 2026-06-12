package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestSecurityPolicyCheckNavigate(t *testing.T) {
	p := NewSecurityPolicy()

	allowed := []string{
		"https://example.com",
		"http://localhost:3000/path?q=1",
		"about:blank",
		"", // empty is a no-op, allowed
		"  https://example.com/with-space  ",
	}
	for _, u := range allowed {
		if err := p.CheckNavigate(u); err != nil {
			t.Errorf("CheckNavigate(%q) = %v, want nil", u, err)
		}
	}

	blocked := []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"chrome://settings",
		"chrome-extension://abc/page.html",
		"data:text/html,<script>alert(1)</script>",
		"ftp://example.com/file",
	}
	for _, u := range blocked {
		if err := p.CheckNavigate(u); err == nil {
			t.Errorf("CheckNavigate(%q) = nil, want error (dangerous scheme)", u)
		}
	}
}

func TestSecurityPolicyIsAIPage(t *testing.T) {
	p := NewSecurityPolicy()
	ai := []string{
		"https://chatgpt.com/c/123",
		"https://claude.ai/chat/x",
		"https://gemini.google.com/app",
		"https://sub.qwen.ai/foo",
	}
	for _, u := range ai {
		if !p.IsAIPage(u) {
			t.Errorf("IsAIPage(%q) = false, want true", u)
		}
	}
	notAI := []string{
		"https://example.com",
		"https://github.com",
		"",
	}
	for _, u := range notAI {
		if p.IsAIPage(u) {
			t.Errorf("IsAIPage(%q) = true, want false", u)
		}
	}
}

func TestSecurityPolicyIsSensitive(t *testing.T) {
	p := NewSecurityPolicy()
	sensitive := []tool.BrowserTab{
		{URL: "https://mybank.com/login"},
		{URL: "https://shop.com/checkout"},
		{URL: "https://x.com/payment"},
	}
	for _, tab := range sensitive {
		if !p.IsSensitive(tab) {
			t.Errorf("IsSensitive(%q) = false, want true", tab.URL)
		}
	}
	if p.IsSensitive(tool.BrowserTab{URL: "https://example.com/docs"}) {
		t.Error("IsSensitive(docs) = true, want false")
	}
}

// Navigate must reject dangerous schemes before issuing any relay command.
func TestNavigateRejectsDangerousSchemeWithoutRelay(t *testing.T) {
	relay := NewRelayManagerFromSend(func(payload []byte) bool {
		t.Fatalf("relay must not be called for a blocked navigation; got: %s", payload)
		return false
	})
	controller := NewController(relay, func([]byte) {})

	for _, u := range []string{"file:///etc/passwd", "javascript:alert(1)", "chrome://settings"} {
		_, err := controller.Navigate(context.Background(), nil, u, "call1")
		if err == nil {
			t.Errorf("Navigate(%q) = nil error, want rejection", u)
		}
		if !strings.Contains(err.Error(), "http") {
			t.Errorf("Navigate(%q) error = %q, want scheme message", u, err)
		}
	}
}

// multiCmdRelay answers any PierCode.getTab with the given tab and any other
// command with an empty success, so multi-step orchestration paths can be
// exercised without a real extension.
func multiCmdRelay(t *testing.T, tab tool.BrowserTab) *RelayManager {
	t.Helper()
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		var data []byte
		if cmd.Domain == "PierCode" && cmd.Method == "getTab" {
			data, _ = json.Marshal(tab)
		} else {
			data = []byte(`{}`)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	return relay
}

func TestReloadOrchestration(t *testing.T) {
	const tabID = 7
	tab := tool.BrowserTab{TabID: tabID, URL: "https://example.com", Title: "Example"}
	controller := NewController(multiCmdRelay(t, tab), func([]byte) {})

	got, err := controller.Reload(context.Background(), tool.BrowserReloadRequest{TabID: intPtr(tabID)})
	if err != nil {
		t.Fatalf("Reload failed: %v", err)
	}
	if got.TabID != tabID || !got.Controlled {
		t.Fatalf("unexpected reload result: %+v", got)
	}
}
