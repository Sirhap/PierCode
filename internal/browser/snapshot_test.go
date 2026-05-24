package browser

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestCompactSnapshotFiltersAndCreatesRefs(t *testing.T) {
	raw := json.RawMessage(`{
		"nodes": [
			{"nodeId":"1","role":{"value":"generic"},"name":{"value":""}},
			{"nodeId":"2","backendDOMNodeId":7,"role":{"value":"button"},"name":{"value":"Search"},"properties":[{"name":"focusable","value":{"value":true}}]},
			{"nodeId":"3","role":{"value":"heading"},"name":{"value":"Docs"},"properties":[{"name":"level","value":{"value":2}}]},
			{"nodeId":"4","ignored":true,"role":{"value":"button"},"name":{"value":"Hidden"}}
		]
	}`)
	tab := tool.BrowserTab{TabID: 12, URL: "https://example.com", Title: "Example"}

	snap, refs, err := CompactSnapshot(raw, tab, "snap_test", 20)
	if err != nil {
		t.Fatalf("CompactSnapshot returned error: %v", err)
	}
	if !strings.Contains(snap.Text, "snapshotId=snap_test") || !strings.Contains(snap.Text, `[e0] button "Search"`) {
		t.Fatalf("unexpected snapshot text: %s", snap.Text)
	}
	if strings.Contains(snap.Text, "Hidden") || strings.Contains(snap.Text, "generic") {
		t.Fatalf("snapshot did not filter ignored/generic nodes: %s", snap.Text)
	}
	if len(refs) != 2 || refs[0].Ref != "e0" || refs[0].BackendID != 7 {
		t.Fatalf("unexpected refs: %+v", refs)
	}
}
