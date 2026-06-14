package executor

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// TestBrowserTabKey pins the per-tab lock-key contract: a positive tabId (as the
// float64 that encoding/json produces, or a raw int) keys per tab, while a
// missing / zero / negative / non-numeric tabId collapses to the shared default
// key so those calls serialize on the controller's default tab.
func TestBrowserTabKey(t *testing.T) {
	cases := []struct {
		name string
		args map[string]interface{}
		want string
	}{
		{"float64 positive", map[string]interface{}{"tabId": float64(7)}, "tab:7"},
		{"int positive", map[string]interface{}{"tabId": 7}, "tab:7"},
		{"zero", map[string]interface{}{"tabId": float64(0)}, "tab:default"},
		{"negative", map[string]interface{}{"tabId": float64(-3)}, "tab:default"},
		{"missing", map[string]interface{}{}, "tab:default"},
		{"nil args", nil, "tab:default"},
		{"string tabId", map[string]interface{}{"tabId": "7"}, "tab:default"},
		// json.Number is NOT handled (Gin's ShouldBindJSON yields float64, not
		// json.Number) — if a future decode path switches to UseNumber, this case
		// will flip and flag that browserTabKey needs a json.Number branch.
		{"json.Number (decoder UseNumber)", map[string]interface{}{"tabId": json.Number("7")}, "tab:default"},
	}
	for _, c := range cases {
		if got := browserTabKey(c.args); got != c.want {
			t.Errorf("%s: browserTabKey=%q want %q", c.name, got, c.want)
		}
	}
}

// TestPathLockKey pins the writer lock-key contract: relative paths are joined
// to rootDir, the key is Clean'd and case-folded (best-effort alias collapse),
// and a missing path falls back to one shared key so malformed calls serialize
// conservatively.
func TestPathLockKey(t *testing.T) {
	root := filepath.Clean("/tmp/work")
	rel := func(p string) string { return "path:" + strings.ToLower(filepath.Clean(filepath.Join(root, p))) }

	cases := []struct {
		name string
		args map[string]interface{}
		want string
	}{
		{"relative joins root", map[string]interface{}{"path": "a/b.txt"}, rel("a/b.txt")},
		{"dotdot cleaned", map[string]interface{}{"path": "a/../b.txt"}, rel("b.txt")},
		{"case folded", map[string]interface{}{"path": "A/B.TXT"}, rel("a/b.txt")},
		{"absolute kept", map[string]interface{}{"path": "/etc/hosts"}, "path:" + strings.ToLower(filepath.Clean("/etc/hosts"))},
		{"empty path shared", map[string]interface{}{"path": "  "}, "path:?"},
		{"missing path shared", map[string]interface{}{}, "path:?"},
	}
	for _, c := range cases {
		if got := pathLockKey(root, c.args); got != c.want {
			t.Errorf("%s: pathLockKey=%q want %q", c.name, got, c.want)
		}
	}

	// Two spellings of the same relative path must collapse to one key (so two
	// writers to the same file serialize), while different files do not.
	if pathLockKey(root, map[string]interface{}{"path": "a/b.txt"}) !=
		pathLockKey(root, map[string]interface{}{"path": "./a/b.txt"}) {
		t.Error("equivalent paths must share a lock key")
	}
	if pathLockKey(root, map[string]interface{}{"path": "a.txt"}) ==
		pathLockKey(root, map[string]interface{}{"path": "b.txt"}) {
		t.Error("different files must not share a lock key")
	}
}
