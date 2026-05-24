package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestEnsureTabRequiresApprovalForAIPage(t *testing.T) {
	const tabID = 42
	relay := newGetTabRelay(t, tool.BrowserTab{TabID: tabID, URL: "https://chatgpt.com/c/123", Title: "AI chat"})
	controller := NewController(relay, func([]byte) {})

	_, err := controller.ensureTab(context.Background(), intPtr(tabID))
	if err == nil || !strings.Contains(err.Error(), "refusing to control AI conversation tab") {
		t.Fatalf("expected AI tab refusal before approval, got %v", err)
	}

	controller.tabs.MarkApproved(tabID)
	tab, err := controller.ensureTab(context.Background(), intPtr(tabID))
	if err != nil {
		t.Fatalf("expected approved AI tab to pass: %v", err)
	}
	if tab.TabID != tabID {
		t.Fatalf("unexpected tab: %+v", tab)
	}
}

func newGetTabRelay(t *testing.T, tab tool.BrowserTab) *RelayManager {
	t.Helper()
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		if cmd.Domain != "PierCode" || cmd.Method != "getTab" {
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		data, err := json.Marshal(tab)
		if err != nil {
			t.Fatalf("marshal tab: %v", err)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	return relay
}

func intPtr(v int) *int { return &v }
