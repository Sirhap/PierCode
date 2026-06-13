package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
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
	fidelity  InputFidelity
	sleep     func(ctx context.Context, d time.Duration) error
}

func NewController(relay *RelayManager, broadcast func([]byte)) *Controller {
	return &Controller{
		relay:     relay,
		tabs:      NewTabRegistry(),
		policy:    NewSecurityPolicy(),
		approvals: NewApprovalManager(broadcast),
		events:    NewEventBus(),
		fidelity:  defaultInputFidelity(),
		sleep:     ctxSleep,
	}
}

func (c *Controller) DeliverResult(res Result) bool {
	return c.relay.DeliverResult(res)
}

// AllowSensitiveHost marks a domain as not payment/financial-sensitive, so the
// keyword heuristic stops refusing browser actions on it (e.g. developer docs or
// e-commerce test sites that merely mention payment/checkout).
func (c *Controller) AllowSensitiveHost(hostOrURL string) {
	if c.policy != nil {
		c.policy.AllowSensitiveHost(hostOrURL)
	}
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
	case "Page.javascriptDialogOpening":
		// A native JS dialog (alert/confirm/prompt/beforeunload) blocks the page's
		// event loop, and once blocked the extension can stop receiving any further
		// CDP commands for the tab. If no explicit browser_handle_dialog call is
		// waiting for this dialog, auto-dismiss it so the tab cannot wedge.
		if c.events != nil && !c.events.HasDialogWaiter(event.TabID) {
			c.autoDismissDialog(event.TabID)
		}
	case "tab_removed":
		c.tabs.ClearDefault(event.TabID)
		c.events.ClearConsole(event.TabID)
		c.events.ClearNetwork(event.TabID)
		c.events.ClearDomainTracking(event.TabID)
	case "tab_updated":
		tab := tool.BrowserTab{TabID: event.TabID, URL: event.URL, Title: event.Title}
		c.tabs.Upsert(tab)
	case "debugger_detached":
		// Extension's chrome.debugger was detached (e.g. user opened DevTools).
		// All CDP state (DOM, Accessibility) for this tab is now invalid.
		c.tabs.MarkStale(event.TabID)
		c.events.ClearDomainTracking(event.TabID)
	}
}

// autoDismissDialog cancels a native JS dialog that opened without an active
// browser_handle_dialog waiter, preventing the tab from wedging. It runs in its
// own goroutine with a short timeout so a slow/disconnected relay can never
// block the event-dispatch path.
func (c *Controller) autoDismissDialog(tabID int) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultActionTimeout)
		defer cancel()
		params, _ := json.Marshal(map[string]interface{}{"accept": false})
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tabID,
			Domain: "Page",
			Method: "handleJavaScriptDialog",
			Params: params,
		}, defaultActionTimeout); err != nil {
			log.Printf("[PierCode] auto-dismiss dialog on tab %d failed: %v", tabID, err)
		}
	}()
}

func (c *Controller) ListTabs(ctx context.Context, includeAI bool) ([]tool.BrowserTab, error) {
	// Always fetch AI pages from the extensions; filter server-side below. A
	// controlled/tracked AI page (one the AI opened itself) must surface even
	// when includeAI is false.
	params, _ := json.Marshal(map[string]interface{}{"includeAiPages": true})
	// Fan out to EVERY connected browser — each only knows its own chrome.tabs,
	// so a single first-result-wins send would surface just one browser's tabs
	// (and could be the wrong browser entirely). Merge + de-dup by tabId.
	results, err := c.relay.SendCommandFanout(ctx, Command{
		Domain: "PierCode",
		Method: "listTabs",
		Params: params,
	}, defaultReadTimeout)
	if err != nil {
		return nil, err
	}
	seen := make(map[int]bool)
	var merged []tool.BrowserTab
	for _, res := range results {
		var out struct {
			Tabs []tool.BrowserTab `json:"tabs"`
		}
		if json.Unmarshal(res.Data, &out) != nil {
			continue
		}
		for _, t := range out.Tabs {
			if t.TabID > 0 && seen[t.TabID] {
				continue
			}
			t = c.tabs.Upsert(t)
			// Hide the user's own untracked AI conversation tabs unless asked;
			// keep controlled/tracked AI pages always.
			if !includeAI && c.policy.IsAIPage(t.URL) && !t.Controlled && t.TrackSource == "" {
				continue
			}
			if t.TabID > 0 {
				seen[t.TabID] = true
			}
			merged = append(merged, t)
		}
	}
	return merged, nil
}

func (c *Controller) NewTab(ctx context.Context, rawURL string) (tool.BrowserTab, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		rawURL = "about:blank"
	}
	if err := c.policy.CheckNavigate(rawURL); err != nil {
		return tool.BrowserTab{}, err
	}
	// A tab the AI opens via browser_new_tab — even an AI-conversation page like
	// qwen.ai — IS its working tab, so it becomes the controlled default and is
	// pre-approved, so the very next browser_* call against it isn't blocked by
	// the AI-page gate. (The hazard the old code guarded against was adopting the
	// USER's existing AI conversation; that path is browser_use_tab, which still
	// asks.)
	//
	// EXCEPTION: a spawn_agent worker tab (URL carries ?piercode_agent=<id>) is
	// driven by its OWN content script, not the coordinator's browser_* tools.
	// It must NOT become the coordinator's default target — otherwise tabID-less
	// browser calls silently re-point at the worker's chat page. It's tracked
	// (MarkCreated) for finalize, but stays controlled=false and non-default.
	isAIPage := c.policy.IsAIPage(rawURL)
	isWorkerTab := isWorkerAgentURL(rawURL)
	controlled := !isWorkerTab
	var tab tool.BrowserTab
	params := map[string]interface{}{"url": rawURL, "controlled": controlled}
	if err := c.sendNativeWithTimeout(ctx, "createTab", params, defaultNavigateTimeout, &tab); err != nil {
		return tool.BrowserTab{}, err
	}
	c.tabs.MarkCreated(tab.TabID)
	if controlled {
		tab.Controlled = true
		c.tabs.SetDefault(tab)
		if isAIPage {
			c.tabs.MarkApproved(tab.TabID)
		}
	}
	tab = c.tabs.Upsert(tab)
	return tab, nil
}

// isWorkerAgentURL reports whether a URL is a spawn_agent worker tab (it carries
// the piercode_agent query param). Such tabs are self-driven and must not become
// the coordinator's default/controlled target.
func isWorkerAgentURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return u.Query().Get("piercode_agent") != ""
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
	c.tabs.MarkClaimed(tab.TabID)
	tab = c.tabs.Upsert(tab)
	// [Fixed by mimo-v2.5-pro: persist AI page approval so downstream tools don't re-block]
	c.tabs.MarkApproved(tab.TabID)
	return tab, nil
}

func (c *Controller) FinalizeTabs(ctx context.Context, req tool.BrowserFinalizeTabsRequest) (tool.BrowserFinalizeTabsResponse, error) {
	resp := tool.BrowserFinalizeTabsResponse{}
	closeIDs := uniquePositiveInts(req.CloseTabIDs)
	releaseIDs := uniquePositiveInts(req.ReleaseTabIDs)

	var closable []int
	for _, tabID := range closeIDs {
		source := c.tabs.TrackingSource(tabID)
		switch {
		case source == "created":
			closable = append(closable, tabID)
		case source == "claimed" && req.CloseClaimedTabs:
			closable = append(closable, tabID)
		case source == "claimed":
			resp.Skipped = append(resp.Skipped, fmt.Sprintf("tabId=%d skipped: claimed tabs require closeClaimedTabs=true", tabID))
		default:
			resp.Skipped = append(resp.Skipped, fmt.Sprintf("tabId=%d skipped: tab is not tracked by PierCode", tabID))
		}
	}

	if len(closable) > 0 {
		tab := tool.BrowserTab{TabID: closable[0]}
		if fetched, err := c.getTab(ctx, closable[0]); err == nil {
			tab = fetched
		}
		target := fmt.Sprintf("close tabIds=%v", closable)
		if err := c.ask(ctx, req.CallID, "关闭受控浏览器标签页", tab, target, "关闭标签页可能丢失页面状态或未保存内容。"); err != nil {
			return tool.BrowserFinalizeTabsResponse{}, err
		}
		var out struct {
			Closed  []int    `json:"closed"`
			Skipped []string `json:"skipped"`
		}
		if err := c.sendNative(ctx, "finalizeTabs", map[string]interface{}{"closeTabIds": closable}, &out); err != nil {
			return tool.BrowserFinalizeTabsResponse{}, err
		}
		resp.Closed = append(resp.Closed, out.Closed...)
		resp.Skipped = append(resp.Skipped, out.Skipped...)
		for _, tabID := range out.Closed {
			c.tabs.ClearDefault(tabID)
			c.events.ClearConsole(tabID)
			c.events.ClearNetwork(tabID)
			c.events.ClearDomainTracking(tabID)
		}
	}

	for _, tabID := range releaseIDs {
		c.tabs.Release(tabID)
		resp.Released = append(resp.Released, tabID)
	}
	return resp, nil
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
				c.relay.SendCommand(ctx, Command{
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

func (c *Controller) Snapshot(ctx context.Context, tabID *int, opts tool.SnapshotOptions) (tool.BrowserSnapshot, error) {
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
	// Pull cross-origin OOPIF child-frame AX trees (best-effort) and merge them
	// so elements inside cross-origin iframes (Stripe fields, embedded editors)
	// are visible and clickable. Same-origin frames already appear in the main
	// tree; this covers the out-of-process ones.
	frameTrees := c.collectFrameAXTrees(ctx, tab.TabID)
	snapshot, refs, err := CompactSnapshotWithFrames(raw, frameTrees, tab, snapshotID, opts)
	if err != nil {
		return tool.BrowserSnapshot{}, err
	}
	if opts.WithCoordinates {
		if marks, mErr := c.enumerateInteractive(ctx, tab.TabID); mErr == nil && len(marks) > 0 {
			var b strings.Builder
			b.WriteString("\n\nInteractive elements (index · role · text @ x,y wxh):\n")
			for _, m := range marks {
				b.WriteString(fmt.Sprintf("  [%d] %s %q @ %.0f,%.0f %.0fx%.0f\n", m.Index, m.Role, m.Text, m.CenterX, m.CenterY, m.W, m.H))
			}
			snapshot.Text += b.String()
		}
	}
	c.tabs.StoreSnapshot(tab, snapshotID, refs)
	return snapshot, nil
}

// frameAXTree is one OOPIF child frame's accessibility tree plus the session it
// came from (needed later to resolve/click nodes inside that frame).
type frameAXTree struct {
	SessionID string
	URL       string
	Raw       json.RawMessage
}

// collectFrameAXTrees enumerates the tab's attached OOPIF sessions (via the
// extension's native listFrameSessions) and fetches each one's AX tree on its
// own session. All best-effort: any failure yields no frame rather than an error
// (the main-frame snapshot must always succeed).
func (c *Controller) collectFrameAXTrees(ctx context.Context, tabID int) []frameAXTree {
	var resp struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
			URL       string `json:"url"`
		} `json:"sessions"`
	}
	if err := c.sendNative(ctx, "listFrameSessions", map[string]interface{}{"tabId": tabID}, &resp); err != nil {
		return nil
	}
	var out []frameAXTree
	for _, s := range resp.Sessions {
		if s.SessionID == "" {
			continue
		}
		raw, err := c.relay.SendCommand(ctx, Command{
			TabID:     &tabID,
			SessionID: s.SessionID,
			Domain:    "Accessibility",
			Method:    "getFullAXTree",
			Params:    json.RawMessage(`{}`),
		}, defaultReadTimeout)
		if err != nil {
			continue
		}
		out = append(out, frameAXTree{SessionID: s.SessionID, URL: s.URL, Raw: raw})
	}
	return out
}

func (c *Controller) Click(ctx context.Context, req tool.BrowserClickRequest) (string, error) {
	if req.Mark != nil {
		tab, terr := c.ensureTab(ctx, req.TabID)
		if terr != nil {
			return "", terr
		}
		marks, ok := c.tabs.Marks(tab.TabID)
		if !ok {
			return "", fmt.Errorf("no marks for this tab; call browser_mark first")
		}
		var cx, cy float64
		found := false
		for _, m := range marks {
			if m.Index == *req.Mark {
				cx, cy, found = m.CenterX, m.CenterY, true
				break
			}
		}
		if !found {
			return "", fmt.Errorf("mark %d not found; call browser_mark to refresh", *req.Mark)
		}
		req.X, req.Y = &cx, &cy
	}
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
	// Skip the elementFromPoint hit-test for iframe targets: the topmost element
	// at the iframe-absolute point on the page session is the <iframe> itself,
	// not the inner control, so the test would always (wrongly) fail.
	if !isIframeTarget(target) {
		if err := c.assertPointActionable(ctx, tab.TabID, x, y); err != nil {
			return "", err
		}
	}
	if err := c.ask(ctx, req.CallID, action+" 页面元素", tab, target, action+" 可能触发页面操作。"); err != nil {
		return "", err
	}
	if err := c.dispatchClick(ctx, tab.TabID, x, y, button, clickCount); err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	if err := c.settle(ctx, tab.TabID); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s %s at %.0f,%.0f in tabId=%d%s", action, target, x, y, tab.TabID, c.switchNote()), nil
}

// switchNote returns a one-line note when an automatic controlled-tab switch
// happened (e.g. a click opened a new tab that became the default), so the model
// is told the controlled tab moved instead of silently acting on a new tab.
func (c *Controller) switchNote() string {
	if from, to, ok := c.tabs.ConsumeDefaultSwitch(); ok {
		return fmt.Sprintf("\nNote: controlled tab switched from #%d to #%d (a new tab opened and became active). Subsequent tabId-less tools now target #%d.", from, to, to)
	}
	return ""
}

// isIframeTarget reports whether resolvePoint resolved an OOPIF node (its target
// description is suffixed "(in iframe)").
func isIframeTarget(target string) bool {
	return strings.Contains(target, "(in iframe)")
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
	if !isIframeTarget(target) {
		if err := c.assertPointActionable(ctx, tab.TabID, x, y); err != nil {
			return "", err
		}
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
	if req.Mode == "keys" {
		// Per-character keyDown/keyUp so editors, autocomplete, and key-listening
		// widgets fire their handlers. Falls back to insertText per character for
		// runes CDP can't express as a key event (CJK, emoji, etc.).
		if err := c.dispatchTypedKeys(ctx, tab.TabID, req.Text); err != nil {
			return "", err
		}
	} else {
		params, _ := json.Marshal(map[string]string{"text": req.Text})
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Input",
			Method: "insertText",
			Params: params,
		}, defaultActionTimeout); err != nil {
			return "", err
		}
	}
	if err := c.ensureTypedTextLanded(ctx, tab.TabID, req.Ref, req.Selector, req.SnapshotID, req.Text, req.Clear); err != nil {
		return "", err
	}
	if req.Submit {
		if err := c.sendKey(ctx, tab.TabID, "Enter"); err != nil {
			return "", err
		}
	}
	c.tabs.MarkStale(tab.TabID)
	if err := c.settle(ctx, tab.TabID); err != nil {
		return "", err
	}
	return fmt.Sprintf("typed %d characters into %s in tabId=%d", len([]rune(req.Text)), target, tab.TabID), nil
}

// Clipboard reads or writes the page's clipboard via the async Clipboard API in
// page context. Reading exposes potentially sensitive host clipboard data and
// writing changes shared system state, so both require approval. The async
// Clipboard API can be blocked by the page's permission policy; when that
// happens the error is surfaced rather than silently swallowed.
func (c *Controller) Clipboard(ctx context.Context, req tool.BrowserClipboardRequest) (tool.BrowserClipboardResponse, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserClipboardResponse{}, err
	}
	if c.policy.IsSensitive(tab) {
		return tool.BrowserClipboardResponse{}, fmt.Errorf("browser_clipboard refused on sensitive payment/financial page")
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	var expr, askWhat, askWhy string
	switch action {
	case "read":
		askWhat, askWhy = "读取剪贴板", "读取剪贴板会暴露系统剪贴板中的内容。"
		expr = `(async function(){ try { return {ok:true, text: await navigator.clipboard.readText()}; } catch(e){ return {ok:false, error:String(e&&e.message||e)}; } })()`
	case "write":
		askWhat, askWhy = "写入剪贴板", "写入剪贴板会修改系统剪贴板内容。"
		expr = `(async function(){ try { await navigator.clipboard.writeText(` + jsString(req.Text) + `); return {ok:true}; } catch(e){ return {ok:false, error:String(e&&e.message||e)}; } })()`
	default:
		return tool.BrowserClipboardResponse{}, fmt.Errorf("action must be 'read' or 'write'")
	}
	if err := c.ask(ctx, req.CallID, askWhat, tab, action, askWhy); err != nil {
		return tool.BrowserClipboardResponse{}, err
	}
	out, err := c.runtimeEvaluate(ctx, tab.TabID, expr, true, defaultActionTimeout, true)
	if err != nil {
		return tool.BrowserClipboardResponse{}, err
	}
	var result struct {
		OK    bool   `json:"ok"`
		Text  string `json:"text"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(out.Result.Value, &result)
	if !result.OK {
		msg := result.Error
		if msg == "" {
			msg = "clipboard access blocked by the page (focus the tab or check clipboard permission policy)"
		}
		return tool.BrowserClipboardResponse{}, fmt.Errorf("clipboard %s failed: %s", action, msg)
	}
	return tool.BrowserClipboardResponse{Tab: tab, Text: result.Text}, nil
}

type typedTextEnsureResult struct {
	OK      bool   `json:"ok"`
	Changed bool   `json:"changed"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Type    string `json:"type"`
}

func (c *Controller) ensureTypedTextLanded(ctx context.Context, tabID int, ref, selector, snapshotID, text string, clear bool) error {
	if ref != "" {
		objectID, release, err := c.resolveRefObject(ctx, tabID, snapshotID, ref)
		if err != nil {
			return err
		}
		defer release()
		out, err := c.callFunctionOnObject(ctx, tabID, objectID, ensureTypedTextFunction(), []interface{}{text, clear})
		if err != nil {
			return err
		}
		return validateTypedTextResult(out, text)
	}
	if selector == "" {
		return nil
	}
	expression := `(function() {
  var el = document.querySelector(` + jsString(selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(selector) + `);
  return (` + ensureTypedTextFunction() + `).call(el, ` + jsString(text) + `, ` + fmt.Sprintf("%t", clear) + `);
})()`
	out, err := c.runtimeEvaluate(ctx, tabID, expression, false, defaultActionTimeout, true)
	if err != nil {
		return err
	}
	return validateTypedTextResult(out, text)
}

func validateTypedTextResult(out *runtimeEvalResult, text string) error {
	var result typedTextEnsureResult
	if len(out.Result.Value) > 0 {
		if err := json.Unmarshal(out.Result.Value, &result); err != nil {
			return fmt.Errorf("failed to parse typed text verification: %w", err)
		}
	}
	if !result.OK {
		return fmt.Errorf("typed text did not appear in target %s: expected %q, before %q, after %q", result.Type, text, result.Before, result.After)
	}
	return nil
}

func ensureTypedTextFunction() string {
	return `function(text, clear) {
  function read(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return String(el.value || '');
    if (el.isContentEditable) return String(el.textContent || '');
    return '';
  }
  function write(el, value) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (setter) setter.call(el, value); else el.value = value;
    } else if (tag === 'textarea') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (setter) setter.call(el, value); else el.value = value;
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
    } else {
      throw new Error('Target does not accept typed text: ' + tag);
    }
    el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true, inputType: 'insertText', data: text}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
  var before = read(this);
  var ok = clear ? before === String(text) : before.indexOf(String(text)) >= 0;
  var changed = false;
  if (!ok) {
    write(this, clear ? String(text) : before + String(text));
    changed = true;
  }
  var after = read(this);
  ok = clear ? after === String(text) : after.indexOf(String(text)) >= 0;
  return {ok: ok, changed: changed, before: before, after: after, type: (this.tagName || '').toLowerCase()};
}`
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
	lm := c.fetchLayoutMetrics(ctx, tab.TabID)
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
	// Fit the capture inside the vision-token budget (longest-edge + byte cap
	// with a JPEG quality step-down). Best-effort: a decode failure leaves the
	// bytes untouched. The format may change to jpeg after the budget pass.
	decoded, format, pxW, pxH := budgetScreenshotWithDims(decoded, format)
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

	scale := 0.0
	if lm.CSSWidth > 0 && pxW > 0 {
		scale = float64(pxW) / float64(lm.CSSWidth)
	}
	shot := tool.BrowserScreenshot{
		Tab: tab, Format: format, Bytes: size, FilePath: tmpFile.Name(),
		Width: pxW, Height: pxH,
		CSSWidth: lm.CSSWidth, CSSHeight: lm.CSSHeight,
		DevicePixelRatio: lm.DPR, ScreenshotScale: scale,
		ScrollX: lm.ScrollX, ScrollY: lm.ScrollY,
	}
	return shot, nil
}

// Mark enumerates the tab's interactive elements, injects a numbered overlay,
// records the marks for browser_click mark= resolution, and returns a screenshot
// with the overlay baked in plus the mark list. clear=true just removes the
// overlay and returns.
func (c *Controller) Mark(ctx context.Context, req tool.BrowserMarkRequest) ([]tool.MarkedElement, tool.BrowserScreenshot, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	if req.Clear {
		_, _ = c.runtimeEvaluate(ctx, tab.TabID, buildClearOverlayExpression(), false, defaultActionTimeout, true)
		c.tabs.SetMarks(tab.TabID, nil)
		return nil, tool.BrowserScreenshot{}, nil
	}
	marks, err := c.enumerateInteractive(ctx, tab.TabID)
	if err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	if _, err := c.runtimeEvaluate(ctx, tab.TabID, buildMarkOverlayExpression(marks), false, defaultActionTimeout, true); err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	c.tabs.SetMarks(tab.TabID, marks)
	// No settle before the shot: Page.captureScreenshot forces a frame, so the
	// just-injected overlay is committed and captured without an extra delay.
	shot, err := c.Screenshot(ctx, tool.BrowserScreenshotRequest{TabID: &tab.TabID, Format: req.Format, OutputDir: req.OutputDir})
	if err != nil {
		// Marks stay recorded even if the screenshot fails — the overlay is on the
		// page and browser_click mark= resolves from the registry, not the image.
		return marks, tool.BrowserScreenshot{}, err
	}
	return marks, shot, nil
}

// layoutMetrics holds the CSS-pixel layout viewport, visual-viewport scroll,
// and devicePixelRatio used to map a screenshot-px point back to the CSS-px click
// coordinate space.
type layoutMetrics struct {
	CSSWidth, CSSHeight int
	ScrollX, ScrollY    float64
	DPR                 float64
}

// fetchLayoutMetrics queries Page.getLayoutMetrics + window.devicePixelRatio for
// the tab. Best-effort: any relay/decode failure leaves the safe defaults
// (DPR=1, zero dims) so a screenshot is never blocked by it.
func (c *Controller) fetchLayoutMetrics(ctx context.Context, tabID int) layoutMetrics {
	lm := layoutMetrics{DPR: 1}
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Page", Method: "getLayoutMetrics"}, defaultReadTimeout)
	if err == nil {
		var m struct {
			CSSLayoutViewport struct {
				ClientWidth  int `json:"clientWidth"`
				ClientHeight int `json:"clientHeight"`
			} `json:"cssLayoutViewport"`
			VisualViewport struct {
				PageX float64 `json:"pageX"`
				PageY float64 `json:"pageY"`
			} `json:"visualViewport"`
		}
		if json.Unmarshal(raw, &m) == nil {
			lm.CSSWidth = m.CSSLayoutViewport.ClientWidth
			lm.CSSHeight = m.CSSLayoutViewport.ClientHeight
			lm.ScrollX = m.VisualViewport.PageX
			lm.ScrollY = m.VisualViewport.PageY
		}
	}
	if out, err := c.runtimeEvaluate(ctx, tabID, "window.devicePixelRatio", false, defaultReadTimeout, true); err == nil && out != nil {
		var dpr float64
		if json.Unmarshal(out.Result.Value, &dpr) == nil && dpr > 0 {
			lm.DPR = dpr
		}
	}
	return lm
}

// RecordGIF captures a short animated GIF of the controlled tab by grabbing a
// burst of JPEG frames at a fixed interval and encoding them. It is a simple,
// dependency-free recorder (no CDP screencast plumbing): good for capturing a
// hover/transition/loading sequence. Frames and duration are bounded.
func (c *Controller) RecordGIF(ctx context.Context, req tool.BrowserRecordRequest) (tool.BrowserScreenshot, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserScreenshot{}, err
	}
	frames := req.Frames
	if frames <= 0 {
		frames = 12
	}
	if frames > 60 {
		frames = 60
	}
	intervalMS := req.IntervalMS
	if intervalMS <= 0 {
		intervalMS = 200
	}
	if intervalMS < 50 {
		intervalMS = 50
	}
	captureParams, _ := json.Marshal(map[string]interface{}{"format": "jpeg", "quality": 60})

	shots := make([][]byte, 0, frames)
	ticker := time.NewTicker(time.Duration(intervalMS) * time.Millisecond)
	defer ticker.Stop()
	for i := 0; i < frames; i++ {
		raw, capErr := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Page",
			Method: "captureScreenshot",
			Params: captureParams,
		}, defaultScreenshotTimeout)
		if capErr != nil {
			if len(shots) == 0 {
				return tool.BrowserScreenshot{}, capErr
			}
			break // partial recording is still useful
		}
		var out struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(raw, &out); err == nil {
			if decoded, derr := base64.StdEncoding.DecodeString(out.Data); derr == nil {
				shots = append(shots, decoded)
			}
		}
		if i < frames-1 {
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return tool.BrowserScreenshot{}, ctx.Err()
			}
		}
	}

	gifBytes, err := encodeGIF(shots, intervalMS/10)
	if err != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to encode gif: %w", err)
	}
	if gifBytes == nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("no frames captured for gif")
	}

	outputDir := filepath.Clean(strings.TrimSpace(req.OutputDir))
	if outputDir == "" {
		return tool.BrowserScreenshot{}, fmt.Errorf("gif output directory is required")
	}
	if mkErr := os.MkdirAll(outputDir, 0o755); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create gif dir: %w", mkErr)
	}
	tmpFile, mkErr := os.CreateTemp(outputDir, "recording-*.gif")
	if mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create gif file: %w", mkErr)
	}
	defer tmpFile.Close()
	if _, mkErr = tmpFile.Write(gifBytes); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to write gif: %w", mkErr)
	}
	return tool.BrowserScreenshot{Tab: tab, Format: "gif", Bytes: len(gifBytes), FilePath: tmpFile.Name()}, nil
}

func (c *Controller) Viewport(ctx context.Context, req tool.BrowserViewportRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	method := "setDeviceMetricsOverride"
	params := json.RawMessage(`{}`)
	if !req.Reset {
		rawParams, _ := json.Marshal(map[string]interface{}{
			"width":             req.Width,
			"height":            req.Height,
			"deviceScaleFactor": 1,
			"mobile":            false,
		})
		params = rawParams
	} else {
		method = "clearDeviceMetricsOverride"
	}
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Emulation",
		Method: method,
		Params: params,
	}, defaultActionTimeout); err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	if req.Reset {
		return fmt.Sprintf("reset viewport override in tabId=%d", tab.TabID), nil
	}
	return fmt.Sprintf("set viewport override to %dx%d in tabId=%d", req.Width, req.Height, tab.TabID), nil
}

func (c *Controller) Downloads(ctx context.Context, req tool.BrowserDownloadsRequest) (tool.BrowserDownloadsResponse, error) {
	limit := req.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	state := strings.ToLower(strings.TrimSpace(req.State))
	if state == "" {
		state = "all"
	}
	var out tool.BrowserDownloadsResponse
	if err := c.sendNative(ctx, "downloads", map[string]interface{}{"limit": limit, "state": state}, &out); err != nil {
		return tool.BrowserDownloadsResponse{}, err
	}
	return out, nil
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
		// Same gate as the explicit-tabID path above. Without it, the implicit
		// default-tab route was the one place an AI conversation page could be
		// driven without browser_use_tab approval.
		if c.policy.IsAIPage(tab.URL) && !c.tabs.IsApproved(tab.TabID) {
			return tool.BrowserTab{}, fmt.Errorf("refusing to control AI conversation tab by default; use browser_use_tab and approve explicitly")
		}
		return tab, nil
	}
	return c.NewTab(ctx, "about:blank")
}

func (c *Controller) getTab(ctx context.Context, tabID int) (tool.BrowserTab, error) {
	var tab tool.BrowserTab
	// Carry tabId in cmd.TabID so the relay routes getTab to the browser that
	// owns it (or, owner unknown, prefers the success over other browsers'
	// "No tab with id" failures). Without this, getTab broadcast and a
	// non-owning browser's failure could win the race.
	rawParams, _ := json.Marshal(map[string]interface{}{"tabId": tabID})
	tid := tabID
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tid,
		Domain: "PierCode",
		Method: "getTab",
		Params: rawParams,
	}, defaultReadTimeout)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	if err := json.Unmarshal(raw, &tab); err != nil {
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
	host, _ := registrableDomain(tab.URL)
	return c.approvals.Ask(ctx, ApprovalAsk{
		CallID:      callID,
		Action:      action,
		Tab:         tab,
		Target:      target,
		Risk:        risk,
		Host:        host,
		ActionClass: actionClassFor(action),
	})
}

// actionClassFor groups an approval prompt's action into a coarse class used as
// the grant key, so "always for this site" applies to a category (clicking,
// typing, …) rather than the exact phrasing. Mutating-but-low-risk pointer/text
// actions share "interact"; higher-risk capabilities each get their own class
// so a broad interact grant never silently covers evaluate/cookie/upload.
func actionClassFor(action string) string {
	a := action
	switch {
	case containsAny(a, "JavaScript", "evaluate", "脚本"):
		return "evaluate"
	case containsAny(a, "cookie", "Cookie"):
		return "cookie"
	case containsAny(a, "剪贴板", "clipboard"):
		return "clipboard"
	case containsAny(a, "上传", "upload"):
		return "upload"
	case containsAny(a, "弹窗", "dialog"):
		return "dialog"
	default:
		return "interact"
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
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
		// OOPIF node: resolve its box on its own child session (frame-relative in
		// headed mode) and add the iframe element's viewport offset to get the
		// absolute click point. Input is always dispatched on the page session.
		if target.SessionID != "" && target.BackendID > 0 {
			x, y, ferr := c.resolveOOPIFPoint(ctx, tab.TabID, target)
			if ferr != nil {
				c.tabs.MarkStale(tab.TabID)
				return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("snapshot is stale; call browser_snapshot again: %w", ferr)
			}
			return tab, x, y, fmt.Sprintf("%s %q (in iframe)", target.Role, target.Name), nil
		}
		// Scroll the element into view BEFORE reading bounds so the click point
		// reflects the post-scroll viewport position — otherwise a ref below the
		// fold resolves to off-screen coordinates and the dispatched mouse event
		// silently misses.
		if target.BackendID > 0 {
			if err := c.scrollBackendNodeIntoView(ctx, tab.TabID, target.BackendID); err != nil {
				c.tabs.MarkStale(tab.TabID)
				return tool.BrowserTab{}, 0, 0, "", fmt.Errorf("snapshot is stale; call browser_snapshot again: %w", err)
			}
			// Always re-read bounds after scrolling (cached snapshot bounds are
			// pre-scroll and now wrong).
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

// boxModelBoundsOnSession is boxModelBounds but addressed to a specific CDP
// session (an OOPIF child frame). In headed mode the returned coordinates are
// relative to that frame's own viewport, not the main viewport.
func (c *Controller) boxModelBoundsOnSession(ctx context.Context, tabID int, sessionID string, backendID int) (*Bounds, error) {
	params, _ := json.Marshal(map[string]int{"backendNodeId": backendID})
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:     &tabID,
		SessionID: sessionID,
		Domain:    "DOM",
		Method:    "getBoxModel",
		Params:    params,
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

// resolveOOPIFPoint computes the viewport-absolute click point for a node inside
// a cross-origin iframe: the node's frame-relative center (read on its own
// session) PLUS the iframe element's viewport offset (read on the page session
// via the frame's owner). Input is then dispatched on the page session at this
// absolute point. The frame's owning <iframe> is located with
// Target.getTargetInfo (frame id) → DOM.getFrameOwner on the page session.
func (c *Controller) resolveOOPIFPoint(ctx context.Context, tabID int, target RefTarget) (float64, float64, error) {
	// 1. Node box on its own frame session (frame-relative in headed mode).
	nodeBox, err := c.boxModelBoundsOnSession(ctx, tabID, target.SessionID, target.BackendID)
	if err != nil {
		return 0, 0, fmt.Errorf("box on frame session: %w", err)
	}
	// 2. Frame id for this session, then the iframe owner's backend node on the
	// page session, then its box (viewport-absolute, since the page session is
	// the top frame).
	offset, err := c.iframeOwnerOffset(ctx, tabID, target.SessionID)
	if err != nil {
		// Without the offset the frame-relative point is wrong; fail loud so the
		// caller re-snapshots rather than silently mis-clicking.
		return 0, 0, fmt.Errorf("iframe owner offset: %w", err)
	}
	return offset.X + centerX(nodeBox), offset.Y + centerY(nodeBox), nil
}

// iframeOwnerOffset returns the viewport-absolute top-left of the <iframe>
// element that owns the given child session's frame.
func (c *Controller) iframeOwnerOffset(ctx context.Context, tabID int, sessionID string) (Bounds, error) {
	// Frame id of the child session.
	rawInfo, err := c.relay.SendCommand(ctx, Command{
		TabID: &tabID, SessionID: sessionID, Domain: "Target", Method: "getTargetInfo", Params: json.RawMessage(`{}`),
	}, defaultActionTimeout)
	if err != nil {
		return Bounds{}, err
	}
	var info struct {
		TargetInfo struct {
			TargetID string `json:"targetId"`
		} `json:"targetInfo"`
	}
	if err := json.Unmarshal(rawInfo, &info); err != nil {
		return Bounds{}, err
	}
	// DOM.getFrameOwner on the PAGE session maps a frameId → the owning <iframe>
	// element's backend node. For a CDP frame, targetId == frameId for OOPIFs.
	ownerParams, _ := json.Marshal(map[string]string{"frameId": info.TargetInfo.TargetID})
	rawOwner, err := c.relay.SendCommand(ctx, Command{
		TabID: &tabID, Domain: "DOM", Method: "getFrameOwner", Params: ownerParams,
	}, defaultActionTimeout)
	if err != nil {
		return Bounds{}, err
	}
	var owner struct {
		BackendNodeID int `json:"backendNodeId"`
	}
	if err := json.Unmarshal(rawOwner, &owner); err != nil || owner.BackendNodeID == 0 {
		// getFrameOwner on the page session can't resolve the <iframe> when it is
		// itself nested inside another cross-origin frame (A→B→C). The single-level
		// offset would mis-place the click, so fail loud rather than mis-click.
		return Bounds{}, fmt.Errorf("iframe owner not reachable from the page session (likely a deeply-nested cross-origin frame); clicking inside nested cross-origin iframes is not supported — interact with the page that hosts the field directly")
	}
	// Scroll the iframe into view + read its box on the page session. If the box
	// can't be read here, the owner lives in another process (nested OOPIF) and
	// the single-level offset is wrong — surface it instead of mis-clicking.
	_ = c.scrollBackendNodeIntoView(ctx, tabID, owner.BackendNodeID)
	box, err := c.boxModelBounds(ctx, tabID, owner.BackendNodeID)
	if err != nil {
		return Bounds{}, fmt.Errorf("iframe owner box not readable on the page session (nested cross-origin frame): %w", err)
	}
	return *box, nil
}

// assertPointActionable verifies, in page context, that the click point (x,y) is
// inside the viewport and that the topmost element there is hittable (not zero-
// size and not buried under a different overlay). It returns a descriptive error
// instead of letting a click land on empty space or get eaten by a modal/toast,
// which previously produced a false "clicked" success. It is intentionally
// lenient: it only fails when the point is off-screen or no element is hit, so a
// legitimately-styled target is never blocked.
func (c *Controller) assertPointActionable(ctx context.Context, tabID int, x, y float64) error {
	expr := fmt.Sprintf(`(function(){
  var x=%[1]f, y=%[2]f;
  var vw=window.innerWidth, vh=window.innerHeight;
  if(x<0||y<0||x>vw||y>vh) return {ok:false, reason:'point ('+Math.round(x)+','+Math.round(y)+') is outside the '+vw+'x'+vh+' viewport — scroll the element into view first'};
  var el=document.elementFromPoint(x,y);
  if(!el) return {ok:false, reason:'no element at the click point — it may be covered or off-screen'};
  return {ok:true};
})()`, x, y)
	out, err := c.runtimeEvaluate(ctx, tabID, expr, false, defaultActionTimeout, true)
	if err != nil {
		// A failed hit-test eval must not block the action (e.g. CSP); fall through.
		return nil
	}
	var res struct {
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if out != nil {
		_ = json.Unmarshal(out.Result.Value, &res)
	}
	if out != nil && len(out.Result.Value) > 0 && !res.OK {
		return fmt.Errorf("target not actionable: %s", res.Reason)
	}
	return nil
}

// moveTo 从最后已知指针(未知则用目标本身)发 MoveSteps 个插值 mouseMoved 到 (x,y),
// 并更新最后指针。button="none"/buttons=0 是普通移动;拖拽用 buttons=1。沿途的中间点
// 让页面 mouseover/mouseenter 逐段触发(hover 菜单/tooltip 才会展开),且真实事件轨迹
// 与扩展端幻影光标动画一致,不再瞬移。
func (c *Controller) moveTo(ctx context.Context, tabID int, x, y float64, button string, buttons int) error {
	from := Point{X: x, Y: y}
	if p, ok := c.tabs.LastPointer(tabID); ok {
		from = p
	}
	for _, pt := range lerpPoints(from, Point{X: x, Y: y}, c.fidelity.MoveSteps) {
		ev := map[string]interface{}{"type": "mouseMoved", "x": pt.X, "y": pt.Y, "button": button}
		if buttons != 0 {
			ev["buttons"] = buttons
		}
		params, _ := json.Marshal(ev)
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
	}
	c.tabs.SetLastPointer(tabID, Point{X: x, Y: y})
	return nil
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
	// 先发插值 mouseMoved:扩展端虚拟光标(phantom cursor)随之滑到目标点,页面 hover 态也
	// 先于点击沿途触发,更接近真实用户操作
	if err := c.moveTo(ctx, tabID, x, y, "none", 0); err != nil {
		return err
	}
	press, _ := json.Marshal(map[string]interface{}{
		"type": "mousePressed", "x": x, "y": y, "button": button,
		"buttons": buttons, "clickCount": clickCount,
	})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: press}, defaultActionTimeout); err != nil {
		return err
	}
	if err := c.sleep(ctx, time.Duration(c.fidelity.ClickHoldMS)*time.Millisecond); err != nil {
		return err
	}
	release, _ := json.Marshal(map[string]interface{}{
		"type": "mouseReleased", "x": x, "y": y, "button": button,
		"buttons": 0, "clickCount": clickCount,
	})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: release}, defaultActionTimeout); err != nil {
		return err
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

// dispatchTypedKeys types text one character at a time as keyDown/keyUp pairs so
// the page's keydown/keypress/keyup/input handlers all fire (Monaco, CodeMirror,
// autocomplete, games). For a printable character, a single keyDown carrying the
// "text" field both fires the key events and inserts the character; a paired
// keyUp completes the stroke. "\n" is sent as Enter. Characters that have no
// usable key event (e.g. CJK, emoji) fall back to Input.insertText so they still
// land, just without per-key events.
func (c *Controller) dispatchTypedKeys(ctx context.Context, tabID int, text string) error {
	for _, r := range text {
		if err := c.sendOneRune(ctx, tabID, r); err != nil {
			return err
		}
		// 逐字间隔，给受控输入(React onChange 节流、@提及补全、debounce 搜索)留出处理时间。
		if err := c.sleep(ctx, time.Duration(c.fidelity.TypeCharDelayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

// sendOneRune 发送单个字符（原来内联在 dispatchTypedKeys 循环里的逻辑）。
func (c *Controller) sendOneRune(ctx context.Context, tabID int, r rune) error {
	if r == '\n' || r == '\r' {
		return c.sendNamedKey(ctx, tabID, "Enter", "\r")
	}
	if r == '\t' {
		return c.sendNamedKey(ctx, tabID, "Tab", "\t")
	}
	// Printable ASCII (and Latin-1) map cleanly to a key event with text.
	if r >= 0x20 && r < 0x7f {
		s := string(r)
		down, _ := json.Marshal(map[string]interface{}{"type": "keyDown", "text": s, "key": s, "unmodifiedText": s})
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: down}, defaultActionTimeout); err != nil {
			return err
		}
		up, _ := json.Marshal(map[string]interface{}{"type": "keyUp", "key": s})
		_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: up}, defaultActionTimeout)
		return err
	}
	// Non-ASCII rune: no reliable key event — insert it so it still lands.
	ins, _ := json.Marshal(map[string]string{"text": string(r)})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "insertText", Params: ins}, defaultActionTimeout)
	return err
}

// sendNamedKey sends a named key (Enter/Tab/…) as a keyDown(text)/keyUp pair.
func (c *Controller) sendNamedKey(ctx context.Context, tabID int, key, text string) error {
	down, _ := json.Marshal(map[string]interface{}{"type": "keyDown", "key": key, "text": text})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: down}, defaultActionTimeout); err != nil {
		return err
	}
	up, _ := json.Marshal(map[string]interface{}{"type": "keyUp", "key": key})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: up}, defaultActionTimeout); err != nil {
		return err
	}
	return nil
}

// chordModifierBit 把 sendKeyChord 系列用的修饰符名映射为 CDP modifier 位掩码值。
// CDP: Alt=1, Ctrl=2, Meta=4, Shift=8。
// （注意：controller_ext.go 另有一个 modifierBit，用 "Control" 而非 "Ctrl"，
//  服务于 dispatchKeyChord，语义不同，故此处单列。）
func chordModifierBit(mod string) (int, bool) {
	switch mod {
	case "Alt":
		return 1, true
	case "Ctrl":
		return 2, true
	case "Meta":
		return 4, true
	case "Shift":
		return 8, true
	default:
		return 0, false
	}
}

// sendKeyChordMods 发送 修饰符+键：各修饰符 down → 键 down → 键 up → 各修饰符 up(逆序)。
// 支持 Alt/Ctrl/Meta/Shift 任意组合。
func (c *Controller) sendKeyChordMods(ctx context.Context, tabID int, mods []string, key string) error {
	mask := 0
	for _, m := range mods {
		bit, ok := chordModifierBit(m)
		if !ok {
			return fmt.Errorf("unsupported modifier %q; use Alt, Ctrl, Meta, or Shift", m)
		}
		mask |= bit
	}
	send := func(ev map[string]interface{}) error {
		params, _ := json.Marshal(ev)
		_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: params}, defaultActionTimeout)
		return err
	}
	for _, m := range mods {
		if err := send(map[string]interface{}{"type": "keyDown", "key": m, "modifiers": mask}); err != nil {
			return err
		}
	}
	if err := send(map[string]interface{}{"type": "keyDown", "key": key, "modifiers": mask}); err != nil {
		return err
	}
	if err := send(map[string]interface{}{"type": "keyUp", "key": key, "modifiers": mask}); err != nil {
		return err
	}
	for i := len(mods) - 1; i >= 0; i-- {
		if err := send(map[string]interface{}{"type": "keyUp", "key": mods[i], "modifiers": mask}); err != nil {
			return err
		}
	}
	return nil
}

// sendKeyChord 保留单修饰符 API，委托给 sendKeyChordMods。
func (c *Controller) sendKeyChord(ctx context.Context, tabID int, modifier, key string) error {
	if _, ok := chordModifierBit(modifier); !ok {
		return fmt.Errorf("unsupported modifier %q; use Meta or Ctrl", modifier)
	}
	return c.sendKeyChordMods(ctx, tabID, []string{modifier}, key)
}

func centerX(b *Bounds) float64 { return b.X + b.Width/2 }
func centerY(b *Bounds) float64 { return b.Y + b.Height/2 }

func uniquePositiveInts(values []int) []int {
	seen := make(map[int]bool, len(values))
	out := make([]int, 0, len(values))
	for _, value := range values {
		if value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
