package tool

import (
	"strings"
	"testing"
)

func TestBrowserBatchRunsSequentiallyAndStopsOnError(t *testing.T) {
	tl := NewBrowserBatchTool()
	var calls []string
	ctx := &Context{
		Args: map[string]interface{}{
			"actions": []interface{}{
				map[string]interface{}{"name": "browser_click", "input": map[string]interface{}{"ref": "e1"}},
				map[string]interface{}{"name": "browser_type", "input": map[string]interface{}{"text": "hi"}},
				map[string]interface{}{"name": "browser_click", "input": map[string]interface{}{"ref": "e9"}},
			},
		},
		Dispatch: func(name string, args map[string]interface{}) BatchItemResult {
			calls = append(calls, name)
			// Fail the second action (browser_type) to verify stop-on-first-error.
			if name == "browser_type" {
				return BatchItemResult{Status: "error", Error: "boom"}
			}
			return BatchItemResult{Status: "success", Output: "ok"}
		},
	}
	res := tl.Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("batch tool itself should succeed (reporting item errors), got %s: %s", res.Status, res.Error)
	}
	// Only the first two actions ran; the third was skipped after the error.
	if len(calls) != 2 || calls[0] != "browser_click" || calls[1] != "browser_type" {
		t.Fatalf("expected [browser_click browser_type], got %v", calls)
	}
	if !strings.Contains(res.Output, "stopped at action 2") {
		t.Fatalf("expected stop-on-first-error message, got: %s", res.Output)
	}
}

func TestBrowserBatchAppliesDefaultTab(t *testing.T) {
	tl := NewBrowserBatchTool()
	var seenTab interface{}
	ctx := &Context{
		Args: map[string]interface{}{
			"tabId": float64(42),
			"actions": []interface{}{
				map[string]interface{}{"name": "browser_click", "input": map[string]interface{}{"ref": "e1"}},
			},
		},
		Dispatch: func(name string, args map[string]interface{}) BatchItemResult {
			seenTab = args["tabId"]
			return BatchItemResult{Status: "success", Output: "ok"}
		},
	}
	if res := tl.Execute(ctx); res.Status != "success" {
		t.Fatalf("unexpected: %s", res.Error)
	}
	if seenTab != 42 {
		t.Fatalf("expected default tabId 42 (int) applied to action, got %v (%T)", seenTab, seenTab)
	}
}

func TestBrowserBatchValidation(t *testing.T) {
	tl := NewBrowserBatchTool()
	// nested batch rejected
	if err := tl.Validate(map[string]interface{}{"actions": []interface{}{
		map[string]interface{}{"name": "browser_batch", "input": map[string]interface{}{}},
	}}); err == nil {
		t.Fatal("nested browser_batch must be rejected")
	}
	// non-browser tool rejected
	if err := tl.Validate(map[string]interface{}{"actions": []interface{}{
		map[string]interface{}{"name": "exec_cmd", "input": map[string]interface{}{}},
	}}); err == nil {
		t.Fatal("non-browser tool in batch must be rejected")
	}
	// empty rejected
	if err := tl.Validate(map[string]interface{}{"actions": []interface{}{}}); err == nil {
		t.Fatal("empty actions must be rejected")
	}
	// valid passes
	if err := tl.Validate(map[string]interface{}{"actions": []interface{}{
		map[string]interface{}{"name": "browser_click", "input": map[string]interface{}{"ref": "e1"}},
	}}); err != nil {
		t.Fatalf("valid batch should pass: %v", err)
	}
}

func TestBrowserBatchNoDispatcher(t *testing.T) {
	tl := NewBrowserBatchTool()
	ctx := &Context{Args: map[string]interface{}{"actions": []interface{}{
		map[string]interface{}{"name": "browser_click", "input": map[string]interface{}{}},
	}}}
	if res := tl.Execute(ctx); res.Status != "error" {
		t.Fatal("batch without a dispatcher must error")
	}
}
