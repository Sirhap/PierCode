package tool

import (
	"context"
	"encoding/json"
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

func TestBrowserScreenshotUploadsAttachmentToSourceClient(t *testing.T) {
	root := t.TempDir()
	fake := &fakeBrowserController{}
	tool := NewBrowserScreenshotTool()
	sent := false
	result := tool.Execute(&Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"format":  "png",
			"call_id": "shot1",
		},
		RootDir: root,
		Browser: fake,
		Client: ClientIO{
			SourceClientID: "client1",
			BroadcastToClient: func(clientID string, payload []byte) bool {
				if clientID != "client1" {
					t.Fatalf("unexpected client id: %q", clientID)
				}
				var msg map[string]interface{}
				if err := json.Unmarshal(payload, &msg); err != nil {
					t.Fatalf("invalid attachment payload: %v", err)
				}
				if msg["type"] != "browser_attachment_upload" || msg["call_id"] != "shot1" {
					t.Fatalf("unexpected attachment payload: %#v", msg)
				}
				sent = true
				go PendingAttachmentUploads.Deliver("shot1", AttachmentUploadResult{OK: true})
				return true
			},
		},
	})
	if result.Status != "success" {
		t.Fatalf("expected success, got status=%s error=%s", result.Status, result.Error)
	}
	if !sent {
		t.Fatal("expected attachment upload event")
	}
	if !strings.Contains(result.Output, "Attachment upload: uploaded to current AI chat page") {
		t.Fatalf("missing upload success status: %s", result.Output)
	}
}

func TestBrowserScreenshotAttachFalseSkipsAttachmentUpload(t *testing.T) {
	root := t.TempDir()
	fake := &fakeBrowserController{}
	tool := NewBrowserScreenshotTool()
	result := tool.Execute(&Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"format":  "png",
			"call_id": "shot2",
			"attach":  false,
		},
		RootDir: root,
		Browser: fake,
		Client: ClientIO{
			SourceClientID: "client1",
			BroadcastToClient: func(string, []byte) bool {
				t.Fatal("attachment upload should not be sent when attach=false")
				return false
			},
		},
	})
	if result.Status != "success" {
		t.Fatalf("expected success, got status=%s error=%s", result.Status, result.Error)
	}
	if strings.Contains(result.Output, "Attachment upload:") {
		t.Fatalf("unexpected upload status: %s", result.Output)
	}
	if !strings.Contains(result.Output, "do not paste it inline") {
		t.Fatalf("expected legacy saved-file guidance: %s", result.Output)
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
	noopBrowserController // safe defaults for the methods this test never calls
	screenshotReq BrowserScreenshotRequest
	uploadReq     BrowserUploadRequest
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

func (f *fakeBrowserController) Upload(_ context.Context, req BrowserUploadRequest) (string, error) {
	f.uploadReq = req
	return "", nil
}

func (f *fakeBrowserController) Downloads(_ context.Context, _ BrowserDownloadsRequest) (BrowserDownloadsResponse, error) {
	return BrowserDownloadsResponse{
		Downloads: []BrowserDownload{{ID: "1", State: "complete", Filename: "report.pdf"}},
		Count:     1,
		Total:     1,
	}, nil
}
