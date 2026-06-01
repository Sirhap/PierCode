package tool

import (
	"context"
	"strings"
	"testing"
)

func TestBrowserViewportValidation(t *testing.T) {
	tool := NewBrowserViewportTool()
	if err := tool.Validate(map[string]interface{}{"reset": true}); err != nil {
		t.Fatalf("expected reset without dimensions to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"width": float64(319), "height": float64(800)}); err == nil {
		t.Fatal("expected narrow width to fail")
	}
	if err := tool.Validate(map[string]interface{}{"width": float64(390), "height": float64(239)}); err == nil {
		t.Fatal("expected short height to fail")
	}
	if err := tool.Validate(map[string]interface{}{"width": float64(390), "height": float64(844)}); err != nil {
		t.Fatalf("expected valid viewport to pass: %v", err)
	}
}

func TestBrowserDownloadsValidationAndFormatting(t *testing.T) {
	tool := NewBrowserDownloadsTool()
	if err := tool.Validate(map[string]interface{}{"state": "bad"}); err == nil {
		t.Fatal("expected invalid state to fail")
	}
	fake := &fakeBrowserController{}
	result := tool.Execute(&Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"limit": float64(2),
			"state": "complete",
		},
		Browser: fake,
	})
	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if !strings.Contains(result.Output, "Recent downloads") {
		t.Fatalf("expected downloads output, got %q", result.Output)
	}
}

func TestBrowserFinalizeTabsValidation(t *testing.T) {
	tool := NewBrowserFinalizeTabsTool()
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing tab ids to fail")
	}
	if err := tool.Validate(map[string]interface{}{"closeTabIds": []interface{}{float64(1)}}); err != nil {
		t.Fatalf("expected closeTabIds to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"releaseTabIds": []interface{}{float64(2)}}); err != nil {
		t.Fatalf("expected releaseTabIds to pass: %v", err)
	}
}
