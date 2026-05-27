package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

type Controller struct {
	relay     *RelayManager
	tabs      *TabRegistry
	policy    *SecurityPolicy
	approvals *ApprovalManager
	events    *EventBus
	snapSeq   atomic.Uint64
}

func NewController(relay *RelayManager, broadcast func([]byte)) *Controller {
	return &Controller{
		relay:     relay,
		tabs:      NewTabRegistry(),
		policy:    NewSecurityPolicy(),
		approvals: NewApprovalManager(broadcast),
		events:    NewEventBus(),
	}
}

func (c *Controller) DeliverResult(res Result) bool {
	return c.relay.DeliverResult(res)
}

func (c *Controller) DeliverApproval(answer ApprovalAnswer) bool {
	return c.approvals.Deliver(answer)
}

// HandleEvent processes browser events relayed from the Extension.
// [Fixed by mimo-v2.5-pro: added debugger_detached handler to invalidate stale snapshots]
func (c *Controller) HandleEvent(event Event) {
	if c.events != nil {
		c.events.HandleEvent(event)
	}
	switch event.Event {
	case "tab_removed":
		c.tabs.ClearDefault(event.TabID)
	case "tab_updated":
		tab := tool.BrowserTab{TabID: event.TabID, URL: event.URL, Title: event.Title}
		c.tabs.Upsert(tab)
	case "debugger_detached":
		// Extension's chrome.debugger was detached (e.g. user opened DevTools).
		// All CDP state (DOM, Accessibility) for this tab is now invalid.
		c.tabs.MarkStale(event.TabID)
	}
}

func (c *Controller) ListTabs(ctx context.Context, includeAI bool) ([]tool.BrowserTab, error) {
	params := map[string]interface{}{"includeAiPages": includeAI}
	var out struct {
		Tabs []tool.BrowserTab `json:"tabs"`
	}
	if err := c.sendNative(ctx, "listTabs", params, &out); err != nil {
		return nil, err
	}
	for i := range out.Tabs {
		out.Tabs[i] = c.tabs.Upsert(out.Tabs[i])
	}
	return out.Tabs, nil
}

func (c *Controller) NewTab(ctx context.Context, rawURL string) (tool.BrowserTab, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		rawURL = "about:blank"
	}
	if err := c.policy.CheckNavigate(rawURL); err != nil {
		return tool.BrowserTab{}, err
	}
	var tab tool.BrowserTab
	if err := c.sendNativeWithTimeout(ctx, "createTab", map[string]interface{}{"url": rawURL}, defaultNavigateTimeout, &tab); err != nil {
		return tool.BrowserTab{}, err
	}
	tab.Controlled = true
	c.tabs.SetDefault(tab)
	return tab, nil
}

func (c *Controller) UseTab(ctx context.Context, tabID int, reason, callID string) (tool.BrowserTab, error) {
	tab, err := c.getTab(ctx, tabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	risk := "将现有浏览器标签页交给 PierCode 控制。"
	if c.policy.IsAIPage(tab.URL) {
		risk = "目标是 AI 对话页，控制它可能中断当前对话。"
	}
	if err := c.ask(ctx, callID, "选择受控标签页", tab, reason, risk); err != nil {
		return tool.BrowserTab{}, err
	}
	tab.Controlled = true
	c.tabs.SetDefault(tab)
	// [Fixed by mimo-v2.5-pro: persist AI page approval so downstream tools don't re-block]
	c.tabs.MarkApproved(tab.TabID)
	return tab, nil
}

func (c *Controller) Navigate(ctx context.Context, tabID *int, rawURL, callID string) (tool.BrowserTab, error) {
	if err := c.policy.CheckNavigate(rawURL); err != nil {
		return tool.BrowserTab{}, err
	}
	tab, err := c.ensureTab(ctx, tabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	oldOrigin := originOf(tab.URL)
	newOrigin := originOf(rawURL)
	if oldOrigin != "" && newOrigin != "" && oldOrigin != newOrigin {
		if err := c.ask(ctx, callID, "导航到新域名", tab, rawURL, "即将把受控标签页导航到新的 origin。"); err != nil {
			return tool.BrowserTab{}, err
		}
	}
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "enable",
		Params: json.RawMessage(`{}`),
	}, defaultReadTimeout); err != nil {
		return tool.BrowserTab{}, err
	}
	params, _ := json.Marshal(map[string]string{"url": rawURL})
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "navigate",
		Params: params,
	}, defaultNavigateTimeout); err != nil {
		return tool.BrowserTab{}, err
	}
	c.tabs.MarkStale(tab.TabID)
	next, err := c.getTab(ctx, tab.TabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	next.Controlled = true
	c.tabs.SetDefault(next)
	return next, nil
}

func (c *Controller) NavigateWithBeforeunload(ctx context.Context, tabID *int, rawURL, callID, beforeunloadPolicy string) (tool.BrowserTab, error) {
	if beforeunloadPolicy == "" || beforeunloadPolicy == "none" {
		return c.Navigate(ctx, tabID, rawURL, callID)
	}
	if err := c.policy.CheckNavigate(rawURL); err != nil {
		return tool.BrowserTab{}, err
	}
	tab, err := c.ensureTab(ctx, tabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	oldOrigin := originOf(tab.URL)
	newOrigin := originOf(rawURL)
	if oldOrigin != "" && newOrigin != "" && oldOrigin != newOrigin {
		if err := c.ask(ctx, callID, "导航到新域名", tab, rawURL, "即将把受控标签页导航到新的 origin。"); err != nil {
			return tool.BrowserTab{}, err
		}
	}
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "enable",
		Params: json.RawMessage(`{}`),
	}, defaultReadTimeout); err != nil {
		return tool.BrowserTab{}, err
	}

	// Set up beforeunload dialog handler
	navCallID := fmt.Sprintf("nav_bu_%d", time.Now().UnixNano())
	dialogCh := c.events.WaitForDialog(navCallID, tab.TabID, 5*time.Second)
	go func() {
		defer c.events.RemoveDialog(navCallID)
		select {
		case event := <-dialogCh:
			if event.Type == "beforeunload" {
				accept := beforeunloadPolicy == "accept"
				params, _ := json.Marshal(map[string]interface{}{"accept": accept})
				c.relay.SendCommand(context.Background(), Command{
					TabID:  &tab.TabID,
					Domain: "Page",
					Method: "handleJavaScriptDialog",
					Params: params,
				}, defaultActionTimeout)
			}
		case <-time.After(5 * time.Second):
		}
	}()

	params, _ := json.Marshal(map[string]string{"url": rawURL})
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "navigate",
		Params: params,
	}, defaultNavigateTimeout); err != nil {
		return tool.BrowserTab{}, err
	}
	c.tabs.MarkStale(tab.TabID)
	next, err := c.getTab(ctx, tab.TabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	next.Controlled = true
	c.tabs.SetDefault(next)
	return next, nil
}

func (c *Controller) Snapshot(ctx context.Context, tabID *int, maxNodes int) (tool.BrowserSnapshot, error) {
	tab, err := c.ensureTab(ctx, tabID)
	if err != nil {
		return tool.BrowserSnapshot{}, err
	}
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Accessibility",
		Method: "enable",
		Params: json.RawMessage(`{}`),
	}, defaultReadTimeout); err != nil {
		return tool.BrowserSnapshot{}, err
	}
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Accessibility",
		Method: "getFullAXTree",
		Params: json.RawMessage(`{}`),
	}, defaultReadTimeout)
	if err != nil {
		return tool.BrowserSnapshot{}, err
	}
	// [Fixed by mimo-v2.5-pro: don't silently ignore getTab error]
	if freshTab, err := c.getTab(ctx, tab.TabID); err == nil {
		tab = freshTab
	}
	tab.Controlled = true
	snapshotID := fmt.Sprintf("snap_%d", c.snapSeq.Add(1))
	snapshot, refs, err := CompactSnapshot(raw, tab, snapshotID, maxNodes)
	if err != nil {
		return tool.BrowserSnapshot{}, err
	}
	c.tabs.StoreSnapshot(tab, snapshotID, refs)
	return snapshot, nil
}

func (c *Controller) Click(ctx context.Context, req tool.BrowserClickRequest) (string, error) {
	tab, x, y, target, err := c.resolvePoint(ctx, req.TabID, req.Ref, req.Selector, req.SnapshotID, req.X, req.Y)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_click refused on sensitive payment/financial page")
	}
	button := req.Button
	if button == "" {
		button = "left"
	}
	clickCount := req.ClickCount
	if clickCount <= 0 {
		clickCount = 1
	}
	action := "clicked"
	if button == "right" {
		action = "right-clicked"
	}
	if clickCount == 2 {
		action = "double-clicked"
	}
	if clickCount == 3 {
		action = "triple-clicked"
	}
	if err := c.ask(ctx, req.CallID, action+" 页面元素", tab, target, action+" 可能触发页面操作。"); err != nil {
		return "", err
	}
	if err := c.dispatchClick(ctx, tab.TabID, x, y, button, clickCount); err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("%s %s at %.0f,%.0f in tabId=%d", action, target, x, y, tab.TabID), nil
}

func (c *Controller) Type(ctx context.Context, req tool.BrowserTypeRequest) (string, error) {
	if strings.TrimSpace(req.Text) == "" {
		return "", fmt.Errorf("text is required")
	}
	tab, x, y, target, err := c.resolvePoint(ctx, req.TabID, req.Ref, req.Selector, req.SnapshotID, nil, nil)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_type refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "输入文本", tab, target, "输入会修改网页表单内容。"); err != nil {
		return "", err
	}
	if err := c.dispatchClick(ctx, tab.TabID, x, y, "left", 1); err != nil {
		return "", err
	}
	if req.Clear {
		// [Fixed by mimo-v2.5-pro: use Ctrl on Windows/Linux, Meta on macOS]
		selectModifier := "Ctrl"
		if runtime.GOOS == "darwin" {
			selectModifier = "Meta"
		}
		if err := c.sendKeyChord(ctx, tab.TabID, selectModifier, "a"); err != nil {
			return "", err
		}
		if err := c.sendKey(ctx, tab.TabID, "Backspace"); err != nil {
			return "", err
		}
	}
	params, _ := json.Marshal(map[string]string{"text": req.Text})
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Input",
		Method: "insertText",
		Params: params,
	}, defaultActionTimeout); err != nil {
		return "", err
	}
	if req.Submit {
		if err := c.sendKey(ctx, tab.TabID, "Enter"); err != nil {
			return "", err
		}
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("typed %d characters into %s in tabId=%d", len([]rune(req.Text)), target, tab.TabID), nil
}

func (c *Controller) Screenshot(ctx context.Context, req tool.BrowserScreenshotRequest) (tool.BrowserScreenshot, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserScreenshot{}, err
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "jpeg"
	}
	if format != "jpeg" && format != "png" {
		return tool.BrowserScreenshot{}, fmt.Errorf("format must be jpeg or png")
	}
	quality := req.Quality
	if quality <= 0 {
		quality = 70
	}
	params := map[string]interface{}{"format": format}
	if format == "jpeg" {
		params["quality"] = quality
	}
	if req.FullPage {
		params["captureBeyondViewport"] = true
	}
	rawParams, _ := json.Marshal(params)
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "captureScreenshot",
		Params: rawParams,
	}, defaultScreenshotTimeout)
	if err != nil {
		return tool.BrowserScreenshot{}, err
	}
	var out struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return tool.BrowserScreenshot{}, err
	}
	// [Fixed by mimo-v2.5-pro: save screenshot to temp file, return path instead of base64]
	decoded, err := base64.StdEncoding.DecodeString(out.Data)
	if err != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("invalid screenshot base64: %w", err)
	}
	size := len(decoded)

	outputDir := strings.TrimSpace(req.OutputDir)
	if outputDir == "" {
		return tool.BrowserScreenshot{}, fmt.Errorf("screenshot output directory is required")
	}
	outputDir = filepath.Clean(outputDir)
	if mkErr := os.MkdirAll(outputDir, 0o755); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create screenshot dir: %w", mkErr)
	}
	ext := ".jpg"
	if format == "png" {
		ext = ".png"
	}
	tmpFile, mkErr := os.CreateTemp(outputDir, "screenshot-*"+ext)

	if mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create screenshot file: %w", mkErr)
	}
	defer tmpFile.Close()
	if _, mkErr = tmpFile.Write(decoded); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to write screenshot: %w", mkErr)
	}

	shot := tool.BrowserScreenshot{Tab: tab, Format: format, Bytes: size, FilePath: tmpFile.Name()}
	return shot, nil
}

// ensureTab resolves the target tab for a browser tool call.
// [Fixed by mimo-v2.5-pro: skip AI page block for tabs approved via browser_use_tab]
func (c *Controller) ensureTab(ctx context.Context, tabID *int) (tool.BrowserTab, error) {
	if tabID != nil && *tabID > 0 {
		tab, err := c.getTab(ctx, *tabID)
		if err != nil {
			return tool.BrowserTab{}, err
		}
		if c.policy.IsAIPage(tab.URL) && !c.tabs.IsApproved(tab.TabID) {
			return tool.BrowserTab{}, fmt.Errorf("refusing to control AI conversation tab by default; use browser_use_tab and approve explicitly")
		}
		return c.tabs.Upsert(tab), nil
	}
	if tab, ok := c.tabs.DefaultTab(); ok {
		return tab, nil
	}
	return c.NewTab(ctx, "about:blank")
}

func (c *Controller) getTab(ctx context.Context, tabID int) (tool.BrowserTab, error) {
	var tab tool.BrowserTab
	if err := c.sendNative(ctx, "getTab", map[string]interface{}{"tabId": tabID}, &tab); err != nil {
		return tool.BrowserTab{}, err
	}
	return c.tabs.Upsert(tab), nil
}

func (c *Controller) sendNative(ctx context.Context, method string, params interface{}, out interface{}) error {
	return c.sendNativeWithTimeout(ctx, method, params, defaultReadTimeout, out)
}

func (c *Controller) sendNativeWithTimeout(ctx context.Context, method string, params interface{}, timeout time.Duration, out interface{}) error {
	rawParams, _ := json.Marshal(params)
	raw, err := c.relay.SendCommand(ctx, Command{
		Domain: "PierCode",
		Method: method,
		Params: rawParams,
	}, timeout)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (c *Controller) ask(ctx context.Context, callID, action string, tab tool.BrowserTab, target, risk string) error {
	return c.approvals.Ask(ctx, ApprovalAsk{
		CallID: callID,
		Action: action,
		Tab:    tab,
		Target: target,
		Risk:   risk,
	})
}

func (c *Controller) resolvePoint(ctx context.Context, tabID *int, ref, selector, snapshotID string, xArg, yArg *float64) (tool.BrowserTab, float64, float64, string, error) {
	tab, err := c.ensureTab(ctx, tabID)
	if err != nil {
		return tool.BrowserTab{}, 0, 0, "", err
	}
	if xArg != nil && yArg != nil {
		return tab, *xArg, *yArg, fmt.Sprintf("coordinates %.0f,%.0f", *xArg, *yArg), nil
	}
	if ref != "" {
		if snapshotID == "" {
			return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("snapshotId is required when using ref")
		}
		target, err := c.tabs.ResolveRef(tab.TabID, snapshotID, ref)
		if err != nil {
			return tool.BrowserTab{}, 0, 0, "", err
		}
		if target.Bounds == nil && target.BackendID > 0 {
			bounds, err := c.boxModelBounds(ctx, tab.TabID, target.BackendID)
			if err != nil {
				c.tabs.MarkStale(tab.TabID)
				return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("snapshot is stale; call browser_snapshot again: %w", err)
			}
			target.Bounds = bounds
		}
		if target.Bounds == nil {
			return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("ref %s has no clickable bounds; call browser_snapshot again or use selector", ref)
		}
		return tab, centerX(target.Bounds), centerY(target.Bounds), fmt.Sprintf("%s %q", target.Role, target.Name), nil
	}
	if selector != "" {
		var rect Bounds
		if err := c.sendNative(ctx, "resolveSelectorRect", map[string]interface{}{"tabId": tab.TabID, "selector": selector}, &rect); err != nil {
			return tool.BrowserTab{}, 0, 0, "", err
		}
		return tab, centerX(&rect), centerY(&rect), "selector " + selector, nil
	}
	return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("provide exactly one target: ref, selector, or x/y")
}

func (c *Controller) boxModelBounds(ctx context.Context, tabID int, backendID int) (*Bounds, error) {
	params, _ := json.Marshal(map[string]int{"backendNodeId": backendID})
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tabID,
		Domain: "DOM",
		Method: "getBoxModel",
		Params: params,
	}, defaultActionTimeout)
	if err != nil {
		return nil, err
	}
	var out struct {
		Model struct {
			Border []float64 `json:"border"`
		} `json:"model"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if len(out.Model.Border) < 8 {
		return nil, fmt.Errorf("DOM.getBoxModel returned no bounds")
	}
	minX, maxX := out.Model.Border[0], out.Model.Border[0]
	minY, maxY := out.Model.Border[1], out.Model.Border[1]
	for i := 0; i+1 < len(out.Model.Border); i += 2 {
		minX = math.Min(minX, out.Model.Border[i])
		maxX = math.Max(maxX, out.Model.Border[i])
		minY = math.Min(minY, out.Model.Border[i+1])
		maxY = math.Max(maxY, out.Model.Border[i+1])
	}
	return &Bounds{X: minX, Y: minY, Width: maxX - minX, Height: maxY - minY}, nil
}

func (c *Controller) dispatchClick(ctx context.Context, tabID int, x, y float64, button string, clickCount int) error {
	if button == "" {
		button = "left"
	}
	if clickCount <= 0 {
		clickCount = 1
	}
	buttons := 0
	switch button {
	case "left":
		buttons = 1
	case "right":
		buttons = 2
	case "middle":
		buttons = 4
	}
	for _, typ := range []string{"mousePressed", "mouseReleased"} {
		params, _ := json.Marshal(map[string]interface{}{
			"type":   typ,
			"x":      x,
			"y":      y,
			"button": button,
			"buttons": func() int {
				if typ == "mousePressed" {
					return buttons
				}
				return 0
			}(),
			"clickCount": clickCount,
		})
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
	}
	return nil
}

func (c *Controller) sendKey(ctx context.Context, tabID int, key string) error {
	for _, typ := range []string{"keyDown", "keyUp"} {
		params, _ := json.Marshal(map[string]interface{}{"type": typ, "key": key})
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
	}
	return nil
}

// sendKeyChord sends a modifier+key combination via CDP Input.dispatchKeyEvent.
// Supported modifiers: "Meta" (macOS Cmd, code=4), "Ctrl" (Windows/Linux, code=2).
// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4.
// Event sequence: modifierDown → keyDown → keyUp → modifierUp (standard key chord order).
// [Fixed by mimo-v2.5-pro: modifier release value, Ctrl support, key event order]
func (c *Controller) sendKeyChord(ctx context.Context, tabID int, modifier, key string) error {
	modifiers := 0
	switch modifier {
	case "Meta":
		modifiers = 4
	case "Ctrl":
		modifiers = 2
	default:
		return fmt.Errorf("unsupported modifier %q; use Meta or Ctrl", modifier)
	}
	// modifier down
	paramsDown, _ := json.Marshal(map[string]interface{}{"type": "keyDown", "key": modifier, "modifiers": modifiers})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: paramsDown}, defaultActionTimeout); err != nil {
		return err
	}
	// key down (with modifier held)
	paramsKey, _ := json.Marshal(map[string]interface{}{"type": "keyDown", "key": key, "modifiers": modifiers})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: paramsKey}, defaultActionTimeout); err != nil {
		return err
	}
	// key up (with modifier still held — CDP requires modifiers on keyUp too)
	paramsKeyUp, _ := json.Marshal(map[string]interface{}{"type": "keyUp", "key": key, "modifiers": modifiers})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: paramsKeyUp}, defaultActionTimeout); err != nil {
		return err
	}
	// modifier up
	paramsUp, _ := json.Marshal(map[string]interface{}{"type": "keyUp", "key": modifier, "modifiers": modifiers})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: paramsUp}, defaultActionTimeout)
	return err
}

func centerX(b *Bounds) float64 { return b.X + b.Width/2 }
func centerY(b *Bounds) float64 { return b.Y + b.Height/2 }
