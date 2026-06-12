package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestDebuggerDetachedMarksSnapshotsStale(t *testing.T) {
	controller := NewController(NewRelayManagerFromSend(func([]byte) bool { return false }), func([]byte) {})
	tab := tool.BrowserTab{TabID: 99, URL: "https://example.com", Title: "Example"}
	controller.tabs.StoreSnapshot(tab, "snap_detach", []RefTarget{{Ref: "e0", Role: "link", Name: "Learn more"}})

	if _, err := controller.tabs.ResolveRef(tab.TabID, "snap_detach", "e0"); err != nil {
		t.Fatalf("snapshot should resolve before detach: %v", err)
	}

	controller.HandleEvent(Event{Type: "browser_event", Event: "debugger_detached", TabID: tab.TabID, Reason: "target_closed"})

	_, err := controller.tabs.ResolveRef(tab.TabID, "snap_detach", "e0")
	if err == nil || !strings.Contains(err.Error(), "snapshot is stale; call browser_snapshot again") {
		t.Fatalf("expected stale snapshot error after detach, got %v", err)
	}
}

func TestResolvePointMarksSnapshotStaleWhenBackendNodeCannotResolve(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		go func() {
			switch cmd.Domain + "." + cmd.Method {
			case "PierCode.getTab":
				data, _ := json.Marshal(tool.BrowserTab{TabID: 101, URL: "https://example.com", Title: "Example", Controlled: true})
				relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
			case "DOM.getBoxModel":
				relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "No target with given id found"})
			default:
				relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "unexpected command " + cmd.Domain + "." + cmd.Method})
			}
		}()
		return true
	})
	controller := NewController(relay, func([]byte) {})
	tab := tool.BrowserTab{TabID: 101, URL: "https://example.com", Title: "Example"}
	controller.tabs.SetDefault(tab)
	controller.tabs.StoreSnapshot(tab, "snap_backend_gone", []RefTarget{{Ref: "e0", BackendID: 7, Role: "link", Name: "Learn more"}})

	_, _, _, _, err := controller.resolvePoint(context.Background(), intPtr(tab.TabID), "e0", "", "snap_backend_gone", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "snapshot is stale; call browser_snapshot again") {
		t.Fatalf("expected stale snapshot error, got %v", err)
	}

	_, err = controller.tabs.ResolveRef(tab.TabID, "snap_backend_gone", "e0")
	if err == nil || !strings.Contains(err.Error(), "snapshot is stale; call browser_snapshot again") {
		t.Fatalf("expected cached snapshot to be stale, got %v", err)
	}
}
