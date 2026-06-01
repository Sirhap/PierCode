package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestRelayManagerSendCommandDeliversResult(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManager(func(payload []byte) bool {
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
	relay := NewRelayManager(func([]byte) bool { return false })
	_, err := relay.SendCommand(context.Background(), Command{Domain: "Page", Method: "captureScreenshot"}, time.Second)
	if err == nil || err.Error() != ErrNoRelay.Error() {
		t.Fatalf("expected ErrNoRelay, got %v", err)
	}
}

func TestRelayManagerIgnoresUnknownResult(t *testing.T) {
	relay := NewRelayManager(func([]byte) bool { return true })
	if relay.DeliverResult(Result{ID: "missing", Success: true}) {
		t.Fatal("unknown result should not be delivered")
	}
}
