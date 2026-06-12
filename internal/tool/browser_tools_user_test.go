package tool

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// userJourneyRecorder implements BrowserController for realistic user journeys.
// It records the actions PierCode would perform in a way that reflects what a
// real operator cares about: pages, clicks, typing, screenshots, downloads,
// rather than low-level Chrome tab IDs.
// Un-exercised methods fall through to noopBrowserController.
type userJourneyRecorder struct {
	noopBrowserController
	listTabsIncludeAI bool
	navigations       []string
	clicks            []BrowserClickRequest
	types             []BrowserTypeRequest
	waits             []BrowserWaitRequest
	scrolls           []BrowserScrollRequest
	screenshots       []BrowserScreenshotRequest
	handles           []BrowserHandleDialogRequest
	finds             []BrowserFindRequest
	formInputs        []BrowserFormInputRequest
	selects           []BrowserSelectRequest
	downloads         []BrowserDownloadsRequest
	finalizes         []BrowserFinalizeTabsRequest
}

func (r *userJourneyRecorder) ListTabs(_ context.Context, includeAI bool) ([]BrowserTab, error) {
	r.listTabsIncludeAI = includeAI
	return []BrowserTab{
		{TabID: 1, URL: "https://example.com", Title: "Example", Controlled: true},
		{TabID: 2, URL: "https://docs.example.com", Title: "Docs", Controlled: false},
	}, nil
}

func (r *userJourneyRecorder) NewTab(_ context.Context, url string) (BrowserTab, error) {
	return BrowserTab{TabID: 99, URL: url, Title: "New Tab", Controlled: true}, nil
}

func (r *userJourneyRecorder) UseTab(_ context.Context, tabID int, _, _ string) (BrowserTab, error) {
	return BrowserTab{TabID: tabID, URL: "https://example.com/used", Title: "Used Tab", Controlled: true}, nil
}

func (r *userJourneyRecorder) Navigate(_ context.Context, _ *int, url, _ string) (BrowserTab, error) {
	r.navigations = append(r.navigations, url)
	return BrowserTab{TabID: 1, URL: url, Title: "Page"}, nil
}

func (r *userJourneyRecorder) NavigateWithBeforeunload(_ context.Context, _ *int, url, _, _ string) (BrowserTab, error) {
	r.navigations = append(r.navigations, url)
	return BrowserTab{TabID: 1, URL: url, Title: "Page"}, nil
}

func (r *userJourneyRecorder) Snapshot(_ context.Context, _ *int, _ SnapshotOptions) (BrowserSnapshot, error) {
	return BrowserSnapshot{
		SnapshotID: "snap-1",
		Tab:        BrowserTab{TabID: 1, URL: "https://example.com", Title: "Example"},
		Text:       "button \"Login\"\ntextbox \"Search\"\n",
		NodeCount:  2,
		RefCount:   2,
	}, nil
}

func (r *userJourneyRecorder) Click(_ context.Context, req BrowserClickRequest) (string, error) {
	r.clicks = append(r.clicks, req)
	return "clicked button Login", nil
}

func (r *userJourneyRecorder) Type(_ context.Context, req BrowserTypeRequest) (string, error) {
	r.types = append(r.types, req)
	return "typed text", nil
}

func (r *userJourneyRecorder) Screenshot(_ context.Context, req BrowserScreenshotRequest) (BrowserScreenshot, error) {
	r.screenshots = append(r.screenshots, req)
	format := req.Format
	if format == "" {
		format = "jpeg"
	}
	return BrowserScreenshot{
		Tab:      BrowserTab{TabID: 1, URL: "https://example.com", Title: "Example"},
		Format:   format,
		Bytes:    10,
		FilePath: filepath.Join(req.OutputDir, "shot."+format),
	}, nil
}

func (r *userJourneyRecorder) Wait(_ context.Context, req BrowserWaitRequest) (string, error) {
	r.waits = append(r.waits, req)
	return "wait satisfied", nil
}

func (r *userJourneyRecorder) Scroll(_ context.Context, req BrowserScrollRequest) (string, error) {
	r.scrolls = append(r.scrolls, req)
	return "scrolled", nil
}

func (r *userJourneyRecorder) Select(_ context.Context, req BrowserSelectRequest) (string, error) {
	r.selects = append(r.selects, req)
	return "selected option", nil
}

func (r *userJourneyRecorder) HandleDialog(_ context.Context, req BrowserHandleDialogRequest) (string, error) {
	r.handles = append(r.handles, req)
	return "dialog handled", nil
}

func (r *userJourneyRecorder) Find(_ context.Context, req BrowserFindRequest) ([]BrowserFindResult, error) {
	r.finds = append(r.finds, req)
	return []BrowserFindResult{
		{Ref: "button#login", Role: "button", Text: "Login", Score: 100},
	}, nil
}

func (r *userJourneyRecorder) FormInput(_ context.Context, req BrowserFormInputRequest) (string, error) {
	r.formInputs = append(r.formInputs, req)
	return "form input set", nil
}

func (r *userJourneyRecorder) Downloads(_ context.Context, req BrowserDownloadsRequest) (BrowserDownloadsResponse, error) {
	r.downloads = append(r.downloads, req)
	return BrowserDownloadsResponse{
		Downloads: []BrowserDownload{{ID: "1", State: "complete", Filename: "report.pdf"}},
		Count:     1,
		Total:     1,
	}, nil
}

func (r *userJourneyRecorder) FinalizeTabs(_ context.Context, req BrowserFinalizeTabsRequest) (BrowserFinalizeTabsResponse, error) {
	r.finalizes = append(r.finalizes, req)
	return BrowserFinalizeTabsResponse{
		Closed:   req.CloseTabIDs,
		Released: req.ReleaseTabIDs,
	}, nil
}

func TestUserBrowserListTabsWithoutManualTabId(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserTabsTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if !strings.Contains(result.Output, "受控 tab:") {
		t.Fatalf("expected human-readable controlled tab section, got %q", result.Output)
	}
}

func TestUserBrowserFindBeforeClickWithoutTabId(t *testing.T) {
	recorder := &userJourneyRecorder{}
	findTool := NewBrowserFindTool()
	clickTool := NewBrowserClickTool()

	findResult := findTool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"query": "Login"},
		Browser: recorder,
	})

	if findResult.Status != "success" {
		t.Fatalf("find failed: %s", findResult.Error)
	}
	if len(recorder.finds) != 1 || recorder.finds[0].Query != "Login" {
		t.Fatalf("expected find to record query, got %#v", recorder.finds)
	}
	if !strings.Contains(findResult.Output, "button#login") {
		t.Fatalf("expected selectable selector in find output, got %q", findResult.Output)
	}

	clickResult := clickTool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"selector": "button#login"},
		Browser: recorder,
	})

	if clickResult.Status != "success" {
		t.Fatalf("click failed: %s", clickResult.Error)
	}
	if len(recorder.clicks) != 1 || recorder.clicks[0].Selector != "button#login" {
		t.Fatalf("expected click to use find-derived selector, got %#v", recorder.clicks)
	}
}

func TestUserBrowserTypingWithSelector(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserTypeTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"text": "piercode", "selector": "input[name=q]", "submit": true},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.types) != 1 || recorder.types[0].Text != "piercode" || !recorder.types[0].Submit {
		t.Fatalf("expected typing request recorded with submit=true, got %#v", recorder.types)
	}
}

func TestUserBrowserScreenshotSavedUnderWorkspace(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserScreenshotTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"format": "png"},
		Browser: recorder,
		RootDir: "/tmp/workspace",
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.screenshots) != 1 || recorder.screenshots[0].OutputDir != "/tmp/workspace/.piercode/screenshots" {
		t.Fatalf("expected screenshot to use workspace-relative save dir, got %#v", recorder.screenshots)
	}
	if !strings.Contains(result.Output, "/tmp/workspace/.piercode/screenshots/shot.png") {
		t.Fatalf("expected human-readable saved path in output, got %q", result.Output)
	}
}

func TestUserBrowserWaitForSelectorWithoutTabId(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserWaitTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"selector": "#dashboard", "state": "visible"},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.waits) != 1 || recorder.waits[0].Selector != "#dashboard" {
		t.Fatalf("expected wait recorded for user-visible selector, got %#v", recorder.waits)
	}
}

func TestUserBrowserScrollDirectionDown(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserScrollTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"direction": "down", "amount": float64(800)},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.scrolls) != 1 || recorder.scrolls[0].Direction != "down" || recorder.scrolls[0].Amount != 800 {
		t.Fatalf("expected down scroll recorded with amount=800, got %#v", recorder.scrolls)
	}
}

func TestUserBrowserDownloadHistory(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserDownloadsTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"state": "complete", "limit": float64(5)},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.downloads) != 1 || recorder.downloads[0].State != "complete" || recorder.downloads[0].Limit != 5 {
		t.Fatalf("expected download query recorded with complete state and limit 5, got %#v", recorder.downloads)
	}
	if !strings.Contains(result.Output, "report.pdf") {
		t.Fatalf("expected human-readable download filename in output, got %q", result.Output)
	}
}

func TestUserBrowserFinalizeTabsReleasesTrackedTab(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserFinalizeTabsTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"releaseTabIds": []interface{}{float64(1)}},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.finalizes) != 1 || len(recorder.finalizes[0].ReleaseTabIDs) != 1 || recorder.finalizes[0].ReleaseTabIDs[0] != 1 {
		t.Fatalf("expected finalization to release tab 1, got %#v", recorder.finalizes)
	}
	if !strings.Contains(result.Output, "released") {
		t.Fatalf("expected release confirmation in output, got %q", result.Output)
	}
}

func TestUserBrowserFormInputSelectsOptionBySelector(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserFormInputTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"selector": "#country", "value": "China"},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.formInputs) != 1 || recorder.formInputs[0].Value != "China" || recorder.formInputs[0].Selector != "#country" {
		t.Fatalf("expected form input recorded with selector and value, got %#v", recorder.formInputs)
	}
}

func TestUserBrowserDialogHandlingAcceptsBeforeUnload(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserHandleDialogTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"action": "accept", "timeout": float64(3)},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.handles) != 1 || recorder.handles[0].Action != "accept" || recorder.handles[0].TimeoutSeconds != 3 {
		t.Fatalf("expected dialog acceptance request with timeout 3, got %#v", recorder.handles)
	}
}

func TestUserBrowserSelectOptionByLabel(t *testing.T) {
	recorder := &userJourneyRecorder{}
	tool := NewBrowserSelectTool()

	result := tool.Execute(&Context{
		Context: context.Background(),
		Args:    map[string]interface{}{"selector": "#language", "value": "English", "by": "label"},
		Browser: recorder,
	})

	if result.Status != "success" {
		t.Fatalf("expected success, got %s: %s", result.Status, result.Error)
	}
	if len(recorder.selects) != 1 || recorder.selects[0].By != "label" || recorder.selects[0].Value != "English" {
		t.Fatalf("expected select recorded with by=label, got %#v", recorder.selects)
	}
}
