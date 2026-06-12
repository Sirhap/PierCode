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

	snap, refs, err := CompactSnapshot(raw, tab, "snap_test", tool.SnapshotOptions{MaxNodes: 20})
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

func TestCompactSnapshotIndentsHierarchy(t *testing.T) {
	// nav > list > 2 links; the links must be indented under their ancestors.
	raw := json.RawMessage(`{
		"nodes": [
			{"nodeId":"1","role":{"value":"navigation"},"name":{"value":"Main"},"childIds":["2"]},
			{"nodeId":"2","role":{"value":"list"},"name":{"value":""},"childIds":["3","4"],"properties":[{"name":"focusable","value":{"value":true}}]},
			{"nodeId":"3","role":{"value":"link"},"name":{"value":"Home"},"parentId":"2"},
			{"nodeId":"4","role":{"value":"link"},"name":{"value":"Docs"},"parentId":"2"}
		]
	}`)
	tab := tool.BrowserTab{TabID: 13, URL: "https://example.com", Title: "Nav"}
	snap, refs, err := CompactSnapshot(raw, tab, "snap_h", tool.SnapshotOptions{})
	if err != nil {
		t.Fatalf("CompactSnapshot error: %v", err)
	}
	// navigation at depth 0, list nested, links nested deeper (2 spaces/level).
	if !strings.Contains(snap.Text, "navigation \"Main\"") {
		t.Fatalf("missing navigation root: %s", snap.Text)
	}
	if !strings.Contains(snap.Text, "    [e") || !strings.Contains(snap.Text, "link \"Home\"") {
		t.Fatalf("links not indented under their ancestors: %s", snap.Text)
	}
	if len(refs) < 2 {
		t.Fatalf("expected link refs, got %+v", refs)
	}
}

func TestCompactSnapshotRefIDSubtree(t *testing.T) {
	raw := json.RawMessage(`{
		"nodes": [
			{"nodeId":"1","role":{"value":"navigation"},"name":{"value":"Main"},"childIds":["2","5"]},
			{"nodeId":"2","role":{"value":"button"},"name":{"value":"Menu"},"childIds":["3"],"parentId":"1","properties":[{"name":"focusable","value":{"value":true}}]},
			{"nodeId":"3","role":{"value":"link"},"name":{"value":"Inside"},"parentId":"2"},
			{"nodeId":"5","role":{"value":"link"},"name":{"value":"Outside"},"parentId":"1"}
		]
	}`)
	tab := tool.BrowserTab{TabID: 14, URL: "https://example.com", Title: "T"}
	// First snapshot to learn the ref of the button (e0).
	snap, refs, err := CompactSnapshot(raw, tab, "snap_r1", tool.SnapshotOptions{})
	if err != nil || len(refs) == 0 {
		t.Fatalf("setup snapshot failed: %v refs=%+v", err, refs)
	}
	buttonRef := refs[0].Ref
	// Re-snapshot focused on the button subtree.
	snap2, _, err := CompactSnapshot(raw, tab, "snap_r2", tool.SnapshotOptions{RefID: buttonRef})
	if err != nil {
		t.Fatalf("subtree snapshot error: %v", err)
	}
	if !strings.Contains(snap2.Text, "Inside") {
		t.Fatalf("subtree should contain the button's child: %s", snap2.Text)
	}
	if strings.Contains(snap2.Text, "Outside") {
		t.Fatalf("subtree should NOT contain a sibling outside the ref: %s", snap2.Text)
	}
	_ = snap
}

func TestCompactSnapshotMissingRefIDErrors(t *testing.T) {
	raw := json.RawMessage(`{"nodes":[{"nodeId":"1","role":{"value":"link"},"name":{"value":"X"}}]}`)
	tab := tool.BrowserTab{TabID: 15, URL: "https://example.com", Title: "T"}
	_, _, err := CompactSnapshot(raw, tab, "snap_m", tool.SnapshotOptions{RefID: "e99"})
	if err == nil {
		t.Fatal("expected error for unknown refId")
	}
}
