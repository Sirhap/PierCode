package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestRelayManagerSendCommandDeliversResult(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var sent Command
		if err := json.Unmarshal(payload, &sent); err != nil {
			t.Fatalf("invalid command payload: %v", err)
		}
		relay.DeliverResult(Result{ID: sent.ID, Success: true, Data: json.RawMessage(`{"ok":true}`)})
		return true
	})

	raw, err := relay.SendCommand(context.Background(), Command{Domain: "PierCode", Method: "listTabs"}, time.Second)
	if err != nil {
		t.Fatalf("SendCommand returned error: %v", err)
	}
	if string(raw) != `{"ok":true}` {
		t.Fatalf("unexpected result: %s", raw)
	}
}

func TestRelayManagerNoRelay(t *testing.T) {
	relay := NewRelayManagerFromSend(func([]byte) bool { return false })
	_, err := relay.SendCommand(context.Background(), Command{Domain: "Page", Method: "captureScreenshot"}, time.Second)
	if err == nil || err.Error() != ErrNoRelay.Error() {
		t.Fatalf("expected ErrNoRelay, got %v", err)
	}
}

func TestRelayManagerIgnoresUnknownResult(t *testing.T) {
	relay := NewRelayManagerFromSend(func([]byte) bool { return true })
	if relay.DeliverResult(Result{ID: "missing", Success: true}) {
		t.Fatal("unknown result should not be delivered")
	}
}

// twoBrowserTransport simulates two connected browsers: browser A owns the tab
// (success) while B does not ("No tab with id"). Both receive a broadcast
// (owner unknown), and B answers first — the relay must still return A's success
// rather than first-result-wins.
type twoBrowserTransport struct{ relay *RelayManager }

func (t *twoBrowserTransport) SendBrowserCommand(_ *int, payload []byte) (bool, bool) {
	var cmd Command
	_ = json.Unmarshal(payload, &cmd)
	t.relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "No tab with id: 7."})
	t.relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"ok":true}`)})
	return true, false // broadcast, not owner-targeted
}
func (t *twoBrowserTransport) BrowserRelayIDs() []string       { return []string{"A", "B"} }
func (t *twoBrowserTransport) SendToID(_ string, _ []byte) bool { return true }

func TestRelayPrefersSuccessOverNonOwnerFailure(t *testing.T) {
	transport := &twoBrowserTransport{}
	relay := NewRelayManager(transport)
	transport.relay = relay

	tabID := 7
	raw, err := relay.SendCommand(context.Background(),
		Command{TabID: &tabID, Domain: "PierCode", Method: "getTab"}, time.Second)
	if err != nil {
		t.Fatalf("expected owner success to win, got error: %v", err)
	}
	if string(raw) != `{"ok":true}` {
		t.Fatalf("unexpected result: %s", raw)
	}
}

// ownerTargetedTransport confirms a known-owner tab routes to exactly one client.
type ownerTargetedTransport struct {
	relay    *RelayManager
	sentToID string
}

func (t *ownerTargetedTransport) SendBrowserCommand(_ *int, payload []byte) (bool, bool) {
	return t.SendToID("owner-A", payload), true
}
func (t *ownerTargetedTransport) BrowserRelayIDs() []string { return []string{"owner-A", "B"} }
func (t *ownerTargetedTransport) SendToID(id string, payload []byte) bool {
	t.sentToID = id
	var cmd Command
	_ = json.Unmarshal(payload, &cmd)
	t.relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"ok":true}`)})
	return true
}

func TestRelayOwnerTargetedSkipsBroadcast(t *testing.T) {
	transport := &ownerTargetedTransport{}
	relay := NewRelayManager(transport)
	transport.relay = relay

	tabID := 3
	if _, err := relay.SendCommand(context.Background(),
		Command{TabID: &tabID, Domain: "PierCode", Method: "getTab"}, time.Second); err != nil {
		t.Fatalf("targeted send failed: %v", err)
	}
	if transport.sentToID != "owner-A" {
		t.Fatalf("expected delivery to owner-A, went to %q", transport.sentToID)
	}
}
