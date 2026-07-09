package browser

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestViewportSetAndResetEmitEmulationCommands(t *testing.T) {
	tab := tool.BrowserTab{TabID: 91, URL: "https://example.com", Title: "Viewport"}
	var relay *RelayManager
	var seen []string

	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		seen = append(seen, cmd.Domain+"."+cmd.Method)
		switch cmd.Domain + "." + cmd.Method {
		case "Emulation.setDeviceMetricsOverride":
			var params map[string]interface{}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid viewport params: %v", err)
			}
			if params["width"] != float64(390) || params["height"] != float64(844) || params["mobile"] != false {
				t.Fatalf("unexpected viewport params: %#v", params)
			}
		case "Emulation.clearDeviceMetricsOverride":
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})

	controller := NewController(relay, func([]byte) {})
	controller.tabs.SetDefault(tab)
	controller.tabs.MarkCreated(tab.TabID)

	if _, err := controller.Viewport(context.Background(), tool.BrowserViewportRequest{Width: 390, Height: 844}); err != nil {
		t.Fatalf("Viewport set returned error: %v", err)
	}
	if _, err := controller.Viewport(context.Background(), tool.BrowserViewportRequest{Reset: true}); err != nil {
		t.Fatalf("Viewport reset returned error: %v", err)
	}
	want := []string{"Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("unexpected commands: got %#v want %#v", seen, want)
	}
}

func TestFinalizeTabsClosesCreatedAndSkipsClaimedByDefault(t *testing.T) {
	var relay *RelayManager
	var closedPayload []int
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		switch cmd.Domain + "." + cmd.Method {
		case "PierCode.getTab":
			var params struct {
				TabID int `json:"tabId"`
			}
			_ = json.Unmarshal(cmd.Params, &params)
			data, _ := json.Marshal(tool.BrowserTab{TabID: params.TabID, URL: "https://example.com", Title: "Tracked"})
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		case "PierCode.finalizeTabs":
			var params struct {
				CloseTabIDs []int `json:"closeTabIds"`
			}
			if err := json.Unmarshal(cmd.Params, &params); err != nil {
				t.Fatalf("invalid finalize params: %v", err)
			}
			closedPayload = params.CloseTabIDs
			data, _ := json.Marshal(map[string]interface{}{"closed": params.CloseTabIDs})
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		default:
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		return true
	})
	var controller *Controller
	approvalCount := 0
	controller = NewController(relay, func(payload []byte) {
		var ask ApprovalAsk
		if err := json.Unmarshal(payload, &ask); err == nil && ask.Type == "browser_approval_ask" {
			approvalCount++
			go controller.DeliverApproval(ApprovalAnswer{ApprovalID: ask.ApprovalID, Approved: true})
		}
	})
	controller.tabs.Upsert(tool.BrowserTab{TabID: 101, URL: "https://created.example", Title: "Created"})
	controller.tabs.MarkCreated(101)
	controller.tabs.Upsert(tool.BrowserTab{TabID: 102, URL: "https://claimed.example", Title: "Claimed"})
	controller.tabs.MarkClaimed(102)

	resp, err := controller.FinalizeTabs(context.Background(), tool.BrowserFinalizeTabsRequest{
		CloseTabIDs:   []int{101, 102, 999},
		ReleaseTabIDs: []int{102},
		CallID:        "finalize-test",
	})
	if err != nil {
		t.Fatalf("FinalizeTabs returned error: %v", err)
	}
	if !reflect.DeepEqual(closedPayload, []int{101}) || !reflect.DeepEqual(resp.Closed, []int{101}) {
		t.Fatalf("expected only created tab to close, payload=%v resp=%v", closedPayload, resp.Closed)
	}
	// Browser approval is disabled: closing a controlled tab no longer prompts.
	if approvalCount != 0 {
		t.Fatalf("expected no close approval, got %d", approvalCount)
	}
	if !reflect.DeepEqual(resp.Released, []int{102}) {
		t.Fatalf("unexpected released tabs: %#v", resp.Released)
	}
	joined := strings.Join(resp.Skipped, "\n")
	if !strings.Contains(joined, "claimed tabs require closeClaimedTabs=true") || !strings.Contains(joined, "not tracked") {
		t.Fatalf("expected claimed/untracked skip reasons, got %#v", resp.Skipped)
	}
	if source := controller.tabs.TrackingSource(102); source != "" {
		t.Fatalf("expected claimed tab to be released, got source %q", source)
	}
}

func TestDownloadsQueriesNativeRecentDownloads(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		if cmd.Domain != "PierCode" || cmd.Method != "downloads" {
			t.Fatalf("unexpected command: %s.%s", cmd.Domain, cmd.Method)
		}
		var params map[string]interface{}
		if err := json.Unmarshal(cmd.Params, &params); err != nil {
			t.Fatalf("invalid downloads params: %v", err)
		}
		if params["limit"] != float64(2) || params["state"] != "complete" {
			t.Fatalf("unexpected downloads params: %#v", params)
		}
		data, _ := json.Marshal(tool.BrowserDownloadsResponse{
			Downloads: []tool.BrowserDownload{{ID: "7", State: "complete", Filename: "report.pdf"}},
			Count:     1,
			Total:     1,
		})
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	controller := NewController(relay, func([]byte) {})
	resp, err := controller.Downloads(context.Background(), tool.BrowserDownloadsRequest{Limit: 2, State: "complete"})
	if err != nil {
		t.Fatalf("Downloads returned error: %v", err)
	}
	if resp.Count != 1 || resp.Downloads[0].Filename != "report.pdf" {
		t.Fatalf("unexpected downloads response: %#v", resp)
	}
}
