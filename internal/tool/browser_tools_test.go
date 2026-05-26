package tool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBrowserClickValidationRequiresOneTarget(t *testing.T) {
	tool := NewBrowserClickTool()
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing target to fail")
	}
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "selector": "button", "snapshotId": "snap"}); err == nil {
		t.Fatal("expected multiple targets to fail")
	}
	if err := tool.Validate(map[string]interface{}{"ref": "e0"}); err == nil {
		t.Fatal("expected ref without snapshotId to fail")
	}
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "snapshotId": "snap"}); err != nil {
		t.Fatalf("expected ref+snapshotId to pass: %v", err)
	}
}

func TestBrowserTypeValidationRequiresTextAndOneTarget(t *testing.T) {
	tool := NewBrowserTypeTool()
	if err := tool.Validate(map[string]interface{}{"selector": "input"}); err == nil {
		t.Fatal("expected missing text to fail")
	}
	if err := tool.Validate(map[string]interface{}{"text": "hello", "ref": "e0"}); err == nil {
		t.Fatal("expected ref without snapshotId to fail")
	}
	if err := tool.Validate(map[string]interface{}{"text": "hello", "selector": "input"}); err != nil {
		t.Fatalf("expected selector target to pass: %v", err)
	}
}

func TestBrowserScreenshotSavesUnderWorkspaceAndDoesNotLeakDataURL(t *testing.T) {
	root := t.TempDir()
	fake := &fakeBrowserController{}
	tool := NewBrowserScreenshotTool()
	result := tool.Execute(&Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"format": "png",
		},
		RootDir: root,
		Browser: fake,
	})
	if result.Status != "success" {
		t.Fatalf("expected success, got status=%s error=%s", result.Status, result.Error)
	}
	wantOutputDir := filepath.Join(root, ".piercode", "screenshots")
	if fake.screenshotReq.OutputDir != wantOutputDir {
		t.Fatalf("unexpected output dir: got %q want %q", fake.screenshotReq.OutputDir, wantOutputDir)
	}
	if strings.Contains(result.Output, "data:image") || strings.Contains(result.Output, "base64") {
		t.Fatalf("screenshot output leaked data URL/base64: %s", result.Output)
	}
	if !strings.Contains(result.Output, filepath.Join(wantOutputDir, "shot.png")) {
		t.Fatalf("screenshot output missing saved file path: %s", result.Output)
	}
}

func TestBrowserUploadResolvesWorkspaceFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "fixture.txt"), []byte("upload"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	fake := &fakeBrowserController{}
	tool := NewBrowserUploadTool()
	result := tool.Execute(&Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"selector": "#file",
			"paths":    []interface{}{"fixture.txt"},
		},
		RootDir: root,
		Browser: fake,
	})
	if result.Status != "success" {
		t.Fatalf("expected success, got status=%s error=%s", result.Status, result.Error)
	}
	wantPath, err := filepath.EvalSymlinks(filepath.Join(root, "fixture.txt"))
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}
	if len(fake.uploadReq.Paths) != 1 || fake.uploadReq.Paths[0] != wantPath {
		t.Fatalf("unexpected upload paths: %#v", fake.uploadReq.Paths)
	}
}

type fakeBrowserController struct {
	screenshotReq BrowserScreenshotRequest
	uploadReq     BrowserUploadRequest
}

func (f *fakeBrowserController) ListTabs(context.Context, bool) ([]BrowserTab, error) {
	return nil, nil
}
func (f *fakeBrowserController) NewTab(context.Context, string) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) UseTab(context.Context, int, string, string) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) Navigate(context.Context, *int, string, string) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) Snapshot(context.Context, *int, int) (BrowserSnapshot, error) {
	return BrowserSnapshot{}, nil
}
func (f *fakeBrowserController) Click(context.Context, BrowserClickRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Type(context.Context, BrowserTypeRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Screenshot(_ context.Context, req BrowserScreenshotRequest) (BrowserScreenshot, error) {
	f.screenshotReq = req
	return BrowserScreenshot{
		Tab:      BrowserTab{TabID: 7, URL: "https://example.com", Title: "Example"},
		Format:   "png",
		Bytes:    123,
		DataURL:  "data:image/png;base64,SHOULD_NOT_LEAK",
		FilePath: filepath.Join(req.OutputDir, "shot.png"),
	}, nil
}
func (f *fakeBrowserController) Wait(context.Context, BrowserWaitRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) WaitForFunction(context.Context, BrowserWaitForFunctionRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Hover(context.Context, BrowserHoverRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Scroll(context.Context, BrowserScrollRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Evaluate(context.Context, BrowserEvaluateRequest) (BrowserEvaluateResponse, error) {
	return BrowserEvaluateResponse{}, nil
}
func (f *fakeBrowserController) GetContent(context.Context, BrowserGetContentRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Select(context.Context, BrowserSelectRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) GoBack(context.Context, *int, string) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) GoForward(context.Context, *int, string) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) Reload(context.Context, BrowserReloadRequest) (BrowserTab, error) {
	return BrowserTab{}, nil
}
func (f *fakeBrowserController) Focus(context.Context, BrowserFocusRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) PressKey(context.Context, BrowserPressKeyRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) Drag(context.Context, BrowserDragRequest) (string, error) {
	return "", nil
}
func (f *fakeBrowserController) PDF(context.Context, BrowserPDFRequest) (BrowserPDFResponse, error) {
	return BrowserPDFResponse{}, nil
}
func (f *fakeBrowserController) Upload(_ context.Context, req BrowserUploadRequest) (string, error) {
	f.uploadReq = req
	return "", nil
}
func (f *fakeBrowserController) HandleDialog(context.Context, BrowserHandleDialogRequest) (string, error) {
	return "", nil
}
