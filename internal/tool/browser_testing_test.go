package tool

import (
	"strings"
	"testing"
)

func TestBrowserAssertValidate(t *testing.T) {
	tl := NewBrowserAssertTool()
	cases := []struct {
		name    string
		args    map[string]interface{}
		wantErr string
	}{
		{"missing kind", map[string]interface{}{}, "kind must be one of"},
		{"bad kind", map[string]interface{}{"kind": "bogus"}, "kind must be one of"},
		{"element kind without selector", map[string]interface{}{"kind": "element_text", "expect": "x"}, "requires a selector"},
		{"attribute without name", map[string]interface{}{"kind": "attribute", "selector": "#a", "expect": "x"}, "attribute name"},
		{"url without expect", map[string]interface{}{"kind": "url"}, "requires expect"},
		{"element_count without count", map[string]interface{}{"kind": "element_count", "selector": "#a"}, "numeric count"},
		{"bad match", map[string]interface{}{"kind": "url", "expect": "x", "match": "fuzzy"}, "match must be"},
		{"bad op", map[string]interface{}{"kind": "element_count", "selector": "#a", "count": 2.0, "op": "!="}, "op must be"},
		{"ok url", map[string]interface{}{"kind": "url", "expect": "x.com"}, ""},
		{"ok console_clean", map[string]interface{}{"kind": "console_clean"}, ""},
		{"ok element_count", map[string]interface{}{"kind": "element_count", "selector": "#a", "count": 3.0, "op": ">="}, ""},
	}
	for _, tc := range cases {
		err := tl.Validate(tc.args)
		if tc.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tc.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Errorf("%s: error = %v, want contains %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestBrowserTestValidate(t *testing.T) {
	tl := NewBrowserTestTool()
	step := func(name string) map[string]interface{} {
		return map[string]interface{}{"name": name, "input": map[string]interface{}{}}
	}
	if err := tl.Validate(map[string]interface{}{}); err == nil || !strings.Contains(err.Error(), "steps is required") {
		t.Errorf("missing steps: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"steps": []interface{}{}}); err == nil || !strings.Contains(err.Error(), "non-empty") {
		t.Errorf("empty steps: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"steps": []interface{}{step("exec_cmd")}}); err == nil || !strings.Contains(err.Error(), "not a browser_* tool") {
		t.Errorf("non-browser step: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"steps": []interface{}{step("browser_test")}}); err == nil || !strings.Contains(err.Error(), "cannot be nested") {
		t.Errorf("nested browser_test: %v", err)
	}
	// {tool,args} alias shape must validate like {name,input}.
	alias := map[string]interface{}{"tool": "browser_assert", "args": map[string]interface{}{"kind": "url", "expect": "x"}}
	if err := tl.Validate(map[string]interface{}{"steps": []interface{}{alias}}); err != nil {
		t.Errorf("alias shape rejected: %v", err)
	}
	// JSON-string steps (model fallback) parse too.
	if err := tl.Validate(map[string]interface{}{"steps": `[{"name":"browser_click","input":{}}]`}); err != nil {
		t.Errorf("json-string steps rejected: %v", err)
	}
	// 51 steps → capped.
	many := make([]interface{}, 51)
	for i := range many {
		many[i] = step("browser_wait")
	}
	if err := tl.Validate(map[string]interface{}{"steps": many}); err == nil || !strings.Contains(err.Error(), "at most 50") {
		t.Errorf("51 steps: %v", err)
	}
}

func TestBrowserTestingMetadataAndExecute(t *testing.T) {
	// Metadata: assert / wait_stable are read-only, test is not.
	for _, tc := range []struct {
		tl       Tool
		readOnly bool
	}{
		{NewBrowserAssertTool(), true},
		{NewBrowserWaitStableTool(), true},
		{NewBrowserTestTool(), false},
	} {
		p, ok := tc.tl.(MetadataProvider)
		if !ok {
			t.Fatalf("%s does not implement MetadataProvider", tc.tl.Name())
		}
		if got := p.Metadata().ReadOnly; got != tc.readOnly {
			t.Errorf("%s ReadOnly = %v, want %v", tc.tl.Name(), got, tc.readOnly)
		}
	}

	// Execute on the /exec route is a clear redirect to the extension SW, not a
	// silent no-op (these tools execute SW-side; see browser_testing.go).
	for _, tl := range []Tool{NewBrowserAssertTool(), NewBrowserWaitStableTool(), NewBrowserTestTool()} {
		ctx := &Context{Browser: noopBrowserController{}, Args: map[string]interface{}{}}
		res := tl.Execute(ctx)
		if res.Status != "error" || !strings.Contains(res.Error, "extension service worker") {
			t.Errorf("%s Execute = %q / %q, want SW-only error", tl.Name(), res.Status, res.Error)
		}
	}
}

func TestBrowserInterceptValidate(t *testing.T) {
	tl := NewBrowserInterceptTool()
	cases := []struct {
		name    string
		args    map[string]interface{}
		wantErr string
	}{
		{"bad action", map[string]interface{}{"action": "frob"}, "action must be"},
		{"add without url", map[string]interface{}{"action": "add"}, "requires a url"},
		{"add bad fail reason", map[string]interface{}{"action": "add", "url": "/api", "fail": "Nope"}, "CDP errorReason"},
		{"add ok fulfill", map[string]interface{}{"action": "add", "url": "/api", "status": 200.0, "body": "{}"}, ""},
		{"add ok fail", map[string]interface{}{"action": "add", "url": "/api", "fail": "BlockedByClient"}, ""},
		{"clear ok", map[string]interface{}{"action": "clear"}, ""},
		{"list ok", map[string]interface{}{"action": "list"}, ""},
		{"default action add needs url", map[string]interface{}{}, "requires a url"},
	}
	for _, tc := range cases {
		err := tl.Validate(tc.args)
		if tc.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tc.name, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Errorf("%s: error = %v, want contains %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestBrowserNetmockMetadataAndExecute(t *testing.T) {
	for _, tc := range []struct {
		tl       Tool
		readOnly bool
	}{
		{NewBrowserInterceptTool(), false},
		{NewBrowserResetTool(), false},
		{NewBrowserVisualDiffTool(), true},
	} {
		p, ok := tc.tl.(MetadataProvider)
		if !ok {
			t.Fatalf("%s does not implement MetadataProvider", tc.tl.Name())
		}
		if got := p.Metadata().ReadOnly; got != tc.readOnly {
			t.Errorf("%s ReadOnly = %v, want %v", tc.tl.Name(), got, tc.readOnly)
		}
	}
	for _, tl := range []Tool{NewBrowserInterceptTool(), NewBrowserResetTool(), NewBrowserVisualDiffTool()} {
		ctx := &Context{Browser: noopBrowserController{}, Args: map[string]interface{}{}}
		res := tl.Execute(ctx)
		if res.Status != "error" || !strings.Contains(res.Error, "extension service worker") {
			t.Errorf("%s Execute = %q / %q, want SW-only error", tl.Name(), res.Status, res.Error)
		}
	}
}

func TestBrowserVisualDiffValidate(t *testing.T) {
	tl := NewBrowserVisualDiffTool()
	if err := tl.Validate(map[string]interface{}{"action": "frob"}); err == nil || !strings.Contains(err.Error(), "action must be") {
		t.Errorf("bad action: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"action": "compare"}); err == nil || !strings.Contains(err.Error(), "requires a key") {
		t.Errorf("compare without key: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{}); err == nil || !strings.Contains(err.Error(), "requires a key") {
		t.Errorf("default compare without key: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"action": "baseline", "key": "home"}); err != nil {
		t.Errorf("baseline ok: %v", err)
	}
	if err := tl.Validate(map[string]interface{}{"action": "list"}); err != nil {
		t.Errorf("list ok: %v", err)
	}
}
