package tool

import (
	"context"
	"errors"
)

// noopBrowserController implements BrowserController with safe, panic-free
// defaults. It is a TEST HELPER: test fakes embed it and override only the
// methods they exercise, so adding a method to BrowserController no longer
// forces every fake to grow a new stub. Un-overridden methods return
// errNoopBrowser rather than panicking (which a nil-interface embed would do).
type noopBrowserController struct{}

var errNoopBrowser = errors.New("noopBrowserController: method not implemented in this test")

func (noopBrowserController) ListTabs(_ context.Context, _ bool) ([]BrowserTab, error) {
	return nil, errNoopBrowser
}

func (noopBrowserController) NewTab(_ context.Context, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) UseTab(_ context.Context, _ int, _, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) Navigate(_ context.Context, _ *int, _, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) NavigateWithBeforeunload(_ context.Context, _ *int, _, _, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) Snapshot(_ context.Context, _ *int, _ int) (BrowserSnapshot, error) {
	return BrowserSnapshot{}, errNoopBrowser
}

func (noopBrowserController) Click(_ context.Context, _ BrowserClickRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Type(_ context.Context, _ BrowserTypeRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Screenshot(_ context.Context, _ BrowserScreenshotRequest) (BrowserScreenshot, error) {
	return BrowserScreenshot{}, errNoopBrowser
}

func (noopBrowserController) Wait(_ context.Context, _ BrowserWaitRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) WaitForFunction(_ context.Context, _ BrowserWaitForFunctionRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Hover(_ context.Context, _ BrowserHoverRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Scroll(_ context.Context, _ BrowserScrollRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Evaluate(_ context.Context, _ BrowserEvaluateRequest) (BrowserEvaluateResponse, error) {
	return BrowserEvaluateResponse{}, errNoopBrowser
}

func (noopBrowserController) GetContent(_ context.Context, _ BrowserGetContentRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Select(_ context.Context, _ BrowserSelectRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) GoBack(_ context.Context, _ *int, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) GoForward(_ context.Context, _ *int, _ string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) Reload(_ context.Context, _ BrowserReloadRequest) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}

func (noopBrowserController) Focus(_ context.Context, _ BrowserFocusRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) PressKey(_ context.Context, _ BrowserPressKeyRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Drag(_ context.Context, _ BrowserDragRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) PDF(_ context.Context, _ BrowserPDFRequest) (BrowserPDFResponse, error) {
	return BrowserPDFResponse{}, errNoopBrowser
}

func (noopBrowserController) Upload(_ context.Context, _ BrowserUploadRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) HandleDialog(_ context.Context, _ BrowserHandleDialogRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Find(_ context.Context, _ BrowserFindRequest) ([]BrowserFindResult, error) {
	return nil, errNoopBrowser
}

func (noopBrowserController) Zoom(_ context.Context, _ BrowserZoomRequest) (BrowserZoomResponse, error) {
	return BrowserZoomResponse{}, errNoopBrowser
}

func (noopBrowserController) Resize(_ context.Context, _ BrowserResizeRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) FormInput(_ context.Context, _ BrowserFormInputRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) ReadConsole(_ context.Context, _ BrowserConsoleRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) ReadNetwork(_ context.Context, _ BrowserNetworkLogRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Cookies(_ context.Context, _ BrowserCookiesRequest) (BrowserCookiesResponse, error) {
	return BrowserCookiesResponse{}, errNoopBrowser
}

func (noopBrowserController) FinalizeTabs(_ context.Context, _ BrowserFinalizeTabsRequest) (BrowserFinalizeTabsResponse, error) {
	return BrowserFinalizeTabsResponse{}, errNoopBrowser
}

func (noopBrowserController) Viewport(_ context.Context, _ BrowserViewportRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Downloads(_ context.Context, _ BrowserDownloadsRequest) (BrowserDownloadsResponse, error) {
	return BrowserDownloadsResponse{}, errNoopBrowser
}

func (noopBrowserController) Storage(_ context.Context, _ BrowserStorageRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) SetCookie(_ context.Context, _ BrowserSetCookieRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) WaitForNavigation(_ context.Context, _ BrowserWaitForNavigationRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) Emulate(_ context.Context, _ BrowserEmulateRequest) (string, error) {
	return "", errNoopBrowser
}

func (noopBrowserController) GetAttributes(_ context.Context, _ BrowserGetAttributesRequest) (string, error) {
	return "", errNoopBrowser
}
