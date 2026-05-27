package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

type runtimeEvalResult struct {
	Result struct {
		Type        string          `json:"type"`
		Value       json.RawMessage `json:"value"`
		Description string          `json:"description"`
		ObjectID    string          `json:"objectId"`
	} `json:"result"`
	ExceptionDetails *struct {
		Text      string `json:"text"`
		Exception struct {
			Description string `json:"description"`
			Value       string `json:"value"`
		} `json:"exception"`
	} `json:"exceptionDetails,omitempty"`
}

func (c *Controller) Wait(ctx context.Context, req tool.BrowserWaitRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	timeout := clampSeconds(req.TimeoutSeconds, 10, 60)
	var expression string
	if strings.TrimSpace(req.LoadState) != "" {
		expression = waitLoadStateExpression(req.LoadState, timeout)
	} else {
		state := strings.ToLower(strings.TrimSpace(req.State))
		if state == "" {
			state = "visible"
		}
		expression = waitSelectorExpression(req.Selector, state, timeout)
	}
	out, err := c.runtimeEvaluate(ctx, tab.TabID, expression, true, timeout+2*time.Second, true)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("wait satisfied in tabId=%d: %s", tab.TabID, runtimeValueString(out)), nil
}

func (c *Controller) WaitForFunction(ctx context.Context, req tool.BrowserWaitForFunctionRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	timeout := clampSeconds(req.TimeoutSeconds, 10, 60)
	out, err := c.runtimeEvaluate(ctx, tab.TabID, waitForFunctionExpression(req.Expression, timeout), true, timeout+2*time.Second, true)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("condition satisfied in tabId=%d: %s", tab.TabID, runtimeValueString(out)), nil
}

func (c *Controller) Hover(ctx context.Context, req tool.BrowserHoverRequest) (string, error) {
	tab, x, y, target, err := c.resolvePoint(ctx, req.TabID, req.Ref, req.Selector, req.SnapshotID, req.X, req.Y)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_hover refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "悬停页面元素", tab, target, "悬停可能触发菜单、预览或页面交互。"); err != nil {
		return "", err
	}
	if err := c.dispatchMouseMoved(ctx, tab.TabID, x, y); err != nil {
		return "", err
	}
	if req.WaitAfterHoverMS > 0 {
		wait := time.Duration(minInt(req.WaitAfterHoverMS, 5000)) * time.Millisecond
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("hovered %s at %.0f,%.0f in tabId=%d", target, x, y, tab.TabID), nil
}

func (c *Controller) Scroll(ctx context.Context, req tool.BrowserScrollRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if req.Ref != "" {
		target, err := c.tabs.ResolveRef(tab.TabID, req.SnapshotID, req.Ref)
		if err != nil {
			return "", err
		}
		if target.BackendID <= 0 {
			return "", fmt.Errorf("ref %s has no backend node id; call browser_snapshot again or use selector", req.Ref)
		}
		if err := c.scrollBackendNodeIntoView(ctx, tab.TabID, target.BackendID); err != nil {
			return "", err
		}
		c.tabs.MarkStale(tab.TabID)
		return fmt.Sprintf("scrolled ref %s into view in tabId=%d", req.Ref, tab.TabID), nil
	}
	if req.Selector != "" {
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  el.scrollIntoView({behavior: 'instant', block: 'center', inline: 'center'});
  return {scrolled: true};
})()`
		if _, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultActionTimeout, true); err != nil {
			return "", err
		}
		c.tabs.MarkStale(tab.TabID)
		return fmt.Sprintf("scrolled selector %s into view in tabId=%d", req.Selector, tab.TabID), nil
	}

	dx, dy := scrollDelta(req.Direction, req.Amount)
	method := strings.ToLower(strings.TrimSpace(req.Method))
	if method == "" || method == "auto" || method == "scrollby" {
		expression := fmt.Sprintf(`window.scrollBy({top: %g, left: %g, behavior: 'instant'}); ({x: window.scrollX, y: window.scrollY})`, dy, dx)
		if _, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultActionTimeout, true); err != nil {
			if method == "scrollby" {
				return "", err
			}
		} else {
			c.tabs.MarkStale(tab.TabID)
			return fmt.Sprintf("scrolled %s by %dpx in tabId=%d", normalizedDirection(req.Direction), normalizedAmount(req.Amount), tab.TabID), nil
		}
	}
	if err := c.dispatchMouseWheel(ctx, tab.TabID, dx, dy); err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("mouse-wheel scrolled %s by %dpx in tabId=%d", normalizedDirection(req.Direction), normalizedAmount(req.Amount), tab.TabID), nil
}

func (c *Controller) Evaluate(ctx context.Context, req tool.BrowserEvaluateRequest) (tool.BrowserEvaluateResponse, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserEvaluateResponse{}, err
	}
	if c.policy.IsSensitive(tab) {
		return tool.BrowserEvaluateResponse{}, fmt.Errorf("browser_evaluate refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "执行页面 JavaScript", tab, truncate(req.Expression, 120), "JavaScript 可读取或修改页面状态，需确认后执行。"); err != nil {
		return tool.BrowserEvaluateResponse{}, err
	}
	out, err := c.runtimeEvaluate(ctx, tab.TabID, evaluateExpression(req.Expression), true, defaultActionTimeout, true)
	if err != nil {
		return tool.BrowserEvaluateResponse{}, err
	}
	serialized := runtimeValueString(out)
	var payload struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal([]byte(serialized), &payload); err == nil && payload.Type != "" {
		return tool.BrowserEvaluateResponse{Tab: tab, Type: payload.Type, Value: rawJSONValueString(payload.Value)}, nil
	}
	return tool.BrowserEvaluateResponse{Tab: tab, Type: out.Result.Type, Value: serialized}, nil
}

func (c *Controller) GetContent(ctx context.Context, req tool.BrowserGetContentRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "text"
	}
	out, err := c.runtimeEvaluate(ctx, tab.TabID, getContentExpression(format, req.Selector), false, defaultReadTimeout, true)
	if err != nil {
		return "", err
	}
	text := runtimeValueString(out)
	if len([]byte(text)) > 100*1024 {
		text = string([]byte(text)[:100*1024]) + "\n...[truncated]"
	}
	return text, nil
}

func (c *Controller) Select(ctx context.Context, req tool.BrowserSelectRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_select refused on sensitive payment/financial page")
	}
	target := targetLabel(req.Ref, req.Selector)
	if err := c.ask(ctx, req.CallID, "选择下拉选项", tab, target, "选择会修改页面表单值。"); err != nil {
		return "", err
	}
	by := strings.ToLower(strings.TrimSpace(req.By))
	if by == "" {
		by = "value"
	}
	fn := `function(value, by) {
  if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
  if (by === 'label') {
    for (var i = 0; i < this.options.length; i++) {
      if (this.options[i].text === String(value)) {
        this.selectedIndex = i;
        break;
      }
    }
  } else if (by === 'index') {
    this.selectedIndex = parseInt(value, 10);
  } else {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    if (setter) setter.call(this, value);
    else this.value = value;
  }
  this.dispatchEvent(new Event('input', {bubbles: true}));
  this.dispatchEvent(new Event('change', {bubbles: true}));
  return {selected: this.value, selectedIndex: this.selectedIndex};
}`
	if req.Ref != "" {
		objectID, release, err := c.resolveRefObject(ctx, tab.TabID, req.SnapshotID, req.Ref)
		if err != nil {
			return "", err
		}
		defer release()
		if _, err := c.callFunctionOnObject(ctx, tab.TabID, objectID, fn, []interface{}{req.Value, by}); err != nil {
			return "", err
		}
	} else {
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  return (` + fn + `).call(el, ` + jsString(req.Value) + `, ` + jsString(by) + `);
})()`
		if _, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultActionTimeout, true); err != nil {
			return "", err
		}
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("selected value %q in %s in tabId=%d", req.Value, target, tab.TabID), nil
}

func (c *Controller) GoBack(ctx context.Context, tabID *int, callID string) (tool.BrowserTab, error) {
	return c.navigateHistory(ctx, tabID, -1, callID)
}

func (c *Controller) GoForward(ctx context.Context, tabID *int, callID string) (tool.BrowserTab, error) {
	return c.navigateHistory(ctx, tabID, 1, callID)
}

func (c *Controller) Reload(ctx context.Context, req tool.BrowserReloadRequest) (tool.BrowserTab, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	params, _ := json.Marshal(map[string]interface{}{"ignoreCache": req.IgnoreCache})
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "reload",
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

func (c *Controller) Focus(ctx context.Context, req tool.BrowserFocusRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	fn := `function() {
  if (!this || typeof this.focus !== 'function') throw new Error('Target cannot be focused');
  this.focus();
  return {focused: document.activeElement === this};
}`
	if req.Ref != "" {
		objectID, release, err := c.resolveRefObject(ctx, tab.TabID, req.SnapshotID, req.Ref)
		if err != nil {
			return "", err
		}
		defer release()
		if _, err := c.callFunctionOnObject(ctx, tab.TabID, objectID, fn, nil); err != nil {
			return "", err
		}
	} else {
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  return (` + fn + `).call(el);
})()`
		if _, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultActionTimeout, true); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("focused %s in tabId=%d", targetLabel(req.Ref, req.Selector), tab.TabID), nil
}

func (c *Controller) PressKey(ctx context.Context, req tool.BrowserPressKeyRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	chord, err := parseKeyChord(req.Key)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_press_key refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "发送键盘输入", tab, req.Key, "键盘输入可能触发页面操作或浏览器快捷键。"); err != nil {
		return "", err
	}
	if err := c.dispatchKeyChord(ctx, tab.TabID, chord); err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("pressed %s in tabId=%d", req.Key, tab.TabID), nil
}

func (c *Controller) Drag(ctx context.Context, req tool.BrowserDragRequest) (string, error) {
	fromTab, fromX, fromY, fromTarget, err := c.resolvePoint(ctx, req.TabID, req.FromRef, req.FromSelector, req.SnapshotID, req.FromX, req.FromY)
	if err != nil {
		return "", err
	}
	toTab, toX, toY, toTarget, err := c.resolvePoint(ctx, &fromTab.TabID, req.ToRef, req.ToSelector, req.SnapshotID, req.ToX, req.ToY)
	if err != nil {
		return "", err
	}
	if toTab.TabID != fromTab.TabID {
		return "", fmt.Errorf("drag endpoints must be in the same tab")
	}
	if c.policy.IsSensitive(fromTab) {
		return "", fmt.Errorf("browser_drag refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "拖拽页面元素", fromTab, fromTarget+" -> "+toTarget, "拖拽会改变页面状态或触发网页操作。"); err != nil {
		return "", err
	}
	if err := c.dispatchDrag(ctx, fromTab.TabID, Point{X: fromX, Y: fromY}, Point{X: toX, Y: toY}); err != nil {
		return "", err
	}
	c.tabs.MarkStale(fromTab.TabID)
	return fmt.Sprintf("dragged %s to %s in tabId=%d", fromTarget, toTarget, fromTab.TabID), nil
}

func (c *Controller) PDF(ctx context.Context, req tool.BrowserPDFRequest) (tool.BrowserPDFResponse, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserPDFResponse{}, err
	}
	params := map[string]interface{}{
		"printBackground": true,
		"landscape":       req.Landscape,
	}
	if err := applyPaperFormat(params, req.Format); err != nil {
		return tool.BrowserPDFResponse{}, err
	}
	rawParams, _ := json.Marshal(params)
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "printToPDF",
		Params: rawParams,
	}, defaultScreenshotTimeout)
	if err != nil {
		return tool.BrowserPDFResponse{}, err
	}
	var out struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return tool.BrowserPDFResponse{}, err
	}
	decoded, err := base64.StdEncoding.DecodeString(out.Data)
	if err != nil {
		return tool.BrowserPDFResponse{}, fmt.Errorf("invalid PDF base64: %w", err)
	}
	filePath, err := resolvePDFOutputPath(req.OutputPath)
	if err != nil {
		return tool.BrowserPDFResponse{}, err
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return tool.BrowserPDFResponse{}, fmt.Errorf("failed to create PDF dir: %w", err)
	}
	if err := os.WriteFile(filePath, decoded, 0o644); err != nil {
		return tool.BrowserPDFResponse{}, fmt.Errorf("failed to write PDF: %w", err)
	}
	return tool.BrowserPDFResponse{Tab: tab, FilePath: filePath, Bytes: len(decoded)}, nil
}

func (c *Controller) Upload(ctx context.Context, req tool.BrowserUploadRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if len(req.Paths) == 0 {
		return "", fmt.Errorf("paths is required")
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_upload refused on sensitive payment/financial page")
	}
	target := targetLabel(req.Ref, req.Selector)
	if err := c.ask(ctx, req.CallID, "上传本地文件", tab, target, "上传会把本地文件提供给网页表单。"); err != nil {
		return "", err
	}

	method := "DOM.setFileInputFiles"
	if err := c.setFileInputFilesWithCDP(ctx, tab.TabID, req, req.Paths); err != nil {
		primaryErr := err
		method = "DataTransfer fallback"
		if err := c.setFileInputFilesWithDataTransfer(ctx, tab.TabID, req); err != nil {
			return "", fmt.Errorf("DOM.setFileInputFiles failed: %v; fallback failed: %w", primaryErr, err)
		}
	}

	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("uploaded %d file(s) to %s in tabId=%d using %s: %s", len(req.Paths), target, tab.TabID, method, uploadPathSummary(req.Paths)), nil
}

func (c *Controller) HandleDialog(ctx context.Context, req tool.BrowserHandleDialogRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_handle_dialog refused on sensitive payment/financial page")
	}
	if err := c.ask(ctx, req.CallID, "处理页面弹窗", tab, req.Action, "接受或关闭 JavaScript 弹窗会继续页面脚本执行。"); err != nil {
		return "", err
	}
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "enable",
		Params: json.RawMessage(`{}`),
	}, defaultReadTimeout); err != nil {
		return "", err
	}
	timeout := clampSeconds(req.TimeoutSeconds, 5, 60)
	callID := req.CallID
	if callID == "" {
		callID = fmt.Sprintf("dialog_%d", time.Now().UnixNano())
	}
	ch := c.events.WaitForDialog(callID, tab.TabID, timeout)
	defer c.events.RemoveDialog(callID)
	select {
	case event := <-ch:
		params := map[string]interface{}{"accept": strings.EqualFold(req.Action, "accept")}
		if req.PromptText != "" {
			params["promptText"] = req.PromptText
		}
		rawParams, _ := json.Marshal(params)
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Page",
			Method: "handleJavaScriptDialog",
			Params: rawParams,
		}, defaultActionTimeout); err != nil {
			return "", err
		}
		c.tabs.MarkStale(tab.TabID)
		return fmt.Sprintf("dialog %s: type=%s message=%q in tabId=%d", req.Action, event.Type, event.Message, tab.TabID), nil
	case <-time.After(timeout):
		return "", fmt.Errorf("no dialog appeared within %ds", int(timeout/time.Second))
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

type Point struct {
	X float64
	Y float64
}

func (c *Controller) navigateHistory(ctx context.Context, tabID *int, delta int, callID string) (tool.BrowserTab, error) {
	tab, err := c.ensureTab(ctx, tabID)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tab.TabID, Domain: "Page", Method: "enable", Params: json.RawMessage(`{}`)}, defaultReadTimeout); err != nil {
		return tool.BrowserTab{}, err
	}
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tab.TabID, Domain: "Page", Method: "getNavigationHistory", Params: json.RawMessage(`{}`)}, defaultReadTimeout)
	if err != nil {
		return tool.BrowserTab{}, err
	}
	var hist struct {
		CurrentIndex int `json:"currentIndex"`
		Entries      []struct {
			ID    int    `json:"id"`
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &hist); err != nil {
		return tool.BrowserTab{}, err
	}
	targetIndex := hist.CurrentIndex + delta
	if targetIndex < 0 || targetIndex >= len(hist.Entries) {
		return tool.BrowserTab{}, fmt.Errorf("no browser history entry in that direction")
	}
	target := hist.Entries[targetIndex]
	if oldOrigin, newOrigin := originOf(tab.URL), originOf(target.URL); oldOrigin != "" && newOrigin != "" && oldOrigin != newOrigin {
		if err := c.ask(ctx, callID, "历史导航到新域名", tab, target.URL, "即将把受控标签页导航到新的 origin。"); err != nil {
			return tool.BrowserTab{}, err
		}
	}
	params, _ := json.Marshal(map[string]int{"entryId": target.ID})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tab.TabID, Domain: "Page", Method: "navigateToHistoryEntry", Params: params}, defaultNavigateTimeout); err != nil {
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

func (c *Controller) runtimeEvaluate(ctx context.Context, tabID int, expression string, awaitPromise bool, timeout time.Duration, returnByValue bool) (*runtimeEvalResult, error) {
	params := map[string]interface{}{
		"expression":    expression,
		"returnByValue": returnByValue,
		"awaitPromise":  awaitPromise,
		"timeout":       int(timeout / time.Millisecond),
	}
	rawParams, _ := json.Marshal(params)
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tabID,
		Domain: "Runtime",
		Method: "evaluate",
		Params: rawParams,
	}, timeout+2*time.Second)
	if err != nil {
		return nil, err
	}
	var out runtimeEvalResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out.ExceptionDetails != nil {
		msg := strings.TrimSpace(out.ExceptionDetails.Exception.Description)
		if msg == "" {
			msg = strings.TrimSpace(out.ExceptionDetails.Exception.Value)
		}
		if msg == "" {
			msg = strings.TrimSpace(out.ExceptionDetails.Text)
		}
		if msg == "" {
			msg = "Runtime.evaluate failed"
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return &out, nil
}

func (c *Controller) withFileInputObject(ctx context.Context, tabID int, ref, selector, snapshotID string, fn func(objectID string) error) error {
	var objectID string
	var release func()
	var err error
	if ref != "" {
		objectID, release, err = c.resolveRefObject(ctx, tabID, snapshotID, ref)
	} else {
		objectID, release, err = c.resolveSelectorObject(ctx, tabID, selector)
	}
	if err != nil {
		return err
	}
	defer release()
	return fn(objectID)
}

func (c *Controller) resolveSelectorObject(ctx context.Context, tabID int, selector string) (string, func(), error) {
	expression := `(function() {
  var el = document.querySelector(` + jsString(selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(selector) + `);
  return el;
})()`
	out, err := c.runtimeEvaluate(ctx, tabID, expression, false, defaultActionTimeout, false)
	if err != nil {
		return "", func() {}, err
	}
	if out.Result.ObjectID == "" {
		return "", func() {}, fmt.Errorf("selector %s did not resolve to an object", selector)
	}
	release := func() {
		params, _ := json.Marshal(map[string]string{"objectId": out.Result.ObjectID})
		_, _ = c.relay.SendCommand(context.Background(), Command{TabID: &tabID, Domain: "Runtime", Method: "releaseObject", Params: params}, time.Second)
	}
	return out.Result.ObjectID, release, nil
}

func (c *Controller) resolveRefObject(ctx context.Context, tabID int, snapshotID, ref string) (string, func(), error) {
	target, err := c.tabs.ResolveRef(tabID, snapshotID, ref)
	if err != nil {
		return "", func() {}, err
	}
	if target.BackendID <= 0 {
		return "", func() {}, fmt.Errorf("ref %s has no backend node id; call browser_snapshot again or use selector", ref)
	}
	params, _ := json.Marshal(map[string]int{"backendNodeId": target.BackendID})
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "DOM", Method: "resolveNode", Params: params}, defaultActionTimeout)
	if err != nil {
		return "", func() {}, err
	}
	var out struct {
		Object struct {
			ObjectID string `json:"objectId"`
		} `json:"object"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", func() {}, err
	}
	if out.Object.ObjectID == "" {
		return "", func() {}, fmt.Errorf("DOM.resolveNode returned no object id")
	}
	release := func() {
		params, _ := json.Marshal(map[string]string{"objectId": out.Object.ObjectID})
		_, _ = c.relay.SendCommand(context.Background(), Command{TabID: &tabID, Domain: "Runtime", Method: "releaseObject", Params: params}, time.Second)
	}
	return out.Object.ObjectID, release, nil
}

func (c *Controller) callFunctionOnObject(ctx context.Context, tabID int, objectID, fn string, args []interface{}) (*runtimeEvalResult, error) {
	cdpArgs := make([]map[string]interface{}, 0, len(args))
	for _, arg := range args {
		cdpArgs = append(cdpArgs, map[string]interface{}{"value": arg})
	}
	params := map[string]interface{}{
		"objectId":            objectID,
		"functionDeclaration": fn,
		"arguments":           cdpArgs,
		"returnByValue":       true,
		"awaitPromise":        true,
	}
	rawParams, _ := json.Marshal(params)
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Runtime", Method: "callFunctionOn", Params: rawParams}, defaultActionTimeout)
	if err != nil {
		return nil, err
	}
	var out runtimeEvalResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out.ExceptionDetails != nil {
		msg := strings.TrimSpace(out.ExceptionDetails.Exception.Description)
		if msg == "" {
			msg = strings.TrimSpace(out.ExceptionDetails.Text)
		}
		return nil, fmt.Errorf("%s", msg)
	}
	return &out, nil
}

func (c *Controller) setFileInputFilesWithCDP(ctx context.Context, tabID int, req tool.BrowserUploadRequest, paths []string) error {
	return c.withFileInputObject(ctx, tabID, req.Ref, req.Selector, req.SnapshotID, func(objectID string) error {
		params, _ := json.Marshal(map[string]interface{}{
			"objectId": objectID,
			"files":    paths,
		})
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tabID,
			Domain: "DOM",
			Method: "setFileInputFiles",
			Params: params,
		}, defaultActionTimeout); err != nil {
			return err
		}
		return c.dispatchFileInputEvents(ctx, tabID, objectID)
	})
}

func (c *Controller) setFileInputFilesWithDataTransfer(ctx context.Context, tabID int, req tool.BrowserUploadRequest) error {
	files, err := buildUploadFallbackFiles(req.Paths)
	if err != nil {
		return err
	}
	return c.withFileInputObject(ctx, tabID, req.Ref, req.Selector, req.SnapshotID, func(objectID string) error {
		_, err := c.callFunctionOnObject(ctx, tabID, objectID, fileInputDataTransferFunction(), []interface{}{files})
		return err
	})
}

func (c *Controller) dispatchFileInputEvents(ctx context.Context, tabID int, objectID string) error {
	_, err := c.callFunctionOnObject(ctx, tabID, objectID, `function() {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') throw new Error('Target is not a file input');
  this.dispatchEvent(new Event('input', {bubbles: true}));
  this.dispatchEvent(new Event('change', {bubbles: true}));
  return {count: this.files ? this.files.length : 0};
}`, nil)
	return err
}

func (c *Controller) scrollBackendNodeIntoView(ctx context.Context, tabID, backendID int) error {
	params, _ := json.Marshal(map[string]int{"backendNodeId": backendID})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "DOM", Method: "scrollIntoViewIfNeeded", Params: params}, defaultActionTimeout); err == nil {
		return nil
	}
	objectID, release, err := c.resolveRefObjectByBackendID(ctx, tabID, backendID)
	if err != nil {
		return err
	}
	defer release()
	_, err = c.callFunctionOnObject(ctx, tabID, objectID, `function() { this.scrollIntoView({behavior: 'instant', block: 'center', inline: 'center'}); return true; }`, nil)
	return err
}

func (c *Controller) resolveRefObjectByBackendID(ctx context.Context, tabID, backendID int) (string, func(), error) {
	params, _ := json.Marshal(map[string]int{"backendNodeId": backendID})
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "DOM", Method: "resolveNode", Params: params}, defaultActionTimeout)
	if err != nil {
		return "", func() {}, err
	}
	var out struct {
		Object struct {
			ObjectID string `json:"objectId"`
		} `json:"object"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", func() {}, err
	}
	if out.Object.ObjectID == "" {
		return "", func() {}, fmt.Errorf("DOM.resolveNode returned no object id")
	}
	release := func() {
		params, _ := json.Marshal(map[string]string{"objectId": out.Object.ObjectID})
		_, _ = c.relay.SendCommand(context.Background(), Command{TabID: &tabID, Domain: "Runtime", Method: "releaseObject", Params: params}, time.Second)
	}
	return out.Object.ObjectID, release, nil
}

type uploadFallbackFile struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
}

const maxUploadFallbackBytes int64 = 25 * 1024 * 1024

func buildUploadFallbackFiles(paths []string) ([]uploadFallbackFile, error) {
	files := make([]uploadFallbackFile, 0, len(paths))
	var total int64
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("upload file is not readable: %s: %w", path, err)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("upload path is a directory: %s", path)
		}
		total += info.Size()
		if total > maxUploadFallbackBytes {
			return nil, fmt.Errorf("fallback upload is limited to %d bytes total", maxUploadFallbackBytes)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("failed to read upload file %s: %w", path, err)
		}
		contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
		files = append(files, uploadFallbackFile{
			Name: filepath.Base(path),
			Type: contentType,
			Data: base64.StdEncoding.EncodeToString(data),
		})
	}
	return files, nil
}

func fileInputDataTransferFunction() string {
	return `function(files) {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') throw new Error('Target is not a file input');
  if (!this.multiple && files.length > 1) throw new Error('Target file input does not accept multiple files');
  var transfer = new DataTransfer();
  files.forEach(function(file) {
    var binary = atob(file.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    transfer.items.add(new File([bytes], file.name, {type: file.type || 'application/octet-stream'}));
  });
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files').set;
  if (setter) setter.call(this, transfer.files);
  else this.files = transfer.files;
  this.dispatchEvent(new Event('input', {bubbles: true}));
  this.dispatchEvent(new Event('change', {bubbles: true}));
  return {count: this.files.length, names: Array.prototype.map.call(this.files, function(file) { return file.name; })};
}`
}

func uploadPathSummary(paths []string) string {
	names := make([]string, 0, len(paths))
	for _, path := range paths {
		names = append(names, filepath.Base(path))
	}
	return strings.Join(names, ", ")
}

func (c *Controller) dispatchMouseMoved(ctx context.Context, tabID int, x, y float64) error {
	params, _ := json.Marshal(map[string]interface{}{
		"type":   "mouseMoved",
		"x":      x,
		"y":      y,
		"button": "none",
	})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout)
	return err
}

func (c *Controller) dispatchMouseWheel(ctx context.Context, tabID int, dx, dy float64) error {
	params, _ := json.Marshal(map[string]interface{}{
		"type":   "mouseWheel",
		"x":      500,
		"y":      500,
		"deltaX": dx,
		"deltaY": dy,
	})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout)
	return err
}

func (c *Controller) dispatchDrag(ctx context.Context, tabID int, from, to Point) error {
	events := []map[string]interface{}{
		{"type": "mouseMoved", "x": from.X, "y": from.Y, "button": "none"},
		{"type": "mousePressed", "x": from.X, "y": from.Y, "button": "left", "buttons": 1},
		{"type": "mouseMoved", "x": from.X + 1, "y": from.Y + 1, "button": "left", "buttons": 1},
	}
	for _, point := range interpolate(from, to, 10) {
		events = append(events, map[string]interface{}{"type": "mouseMoved", "x": point.X, "y": point.Y, "button": "left", "buttons": 1})
	}
	events = append(events,
		map[string]interface{}{"type": "mouseMoved", "x": to.X, "y": to.Y, "button": "left", "buttons": 1},
		map[string]interface{}{"type": "mouseMoved", "x": to.X, "y": to.Y, "button": "left", "buttons": 1},
		map[string]interface{}{"type": "mouseReleased", "x": to.X, "y": to.Y, "button": "left", "buttons": 0},
	)
	for i, event := range events {
		params, _ := json.Marshal(event)
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
		if i >= 2 && i < len(events)-1 {
			select {
			case <-time.After(16 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

type keyChord struct {
	Key       string
	Mods      []string
	Modifiers int
}

func (c *Controller) dispatchKeyChord(ctx context.Context, tabID int, chord keyChord) error {
	if chord.Modifiers == 0 {
		return c.sendKey(ctx, tabID, chord.Key)
	}
	current := 0
	for _, mod := range chord.Mods {
		current |= modifierBit(mod)
		if err := c.dispatchKeyEvent(ctx, tabID, "keyDown", modifierKeyName(mod), current); err != nil {
			return err
		}
	}
	if err := c.dispatchKeyEvent(ctx, tabID, "keyDown", chord.Key, chord.Modifiers); err != nil {
		return err
	}
	if err := c.dispatchKeyEvent(ctx, tabID, "keyUp", chord.Key, chord.Modifiers); err != nil {
		return err
	}
	for i := len(chord.Mods) - 1; i >= 0; i-- {
		mod := chord.Mods[i]
		if err := c.dispatchKeyEvent(ctx, tabID, "keyUp", modifierKeyName(mod), current); err != nil {
			return err
		}
		current &^= modifierBit(mod)
	}
	return nil
}

func (c *Controller) dispatchKeyEvent(ctx context.Context, tabID int, typ, key string, modifiers int) error {
	params, _ := json.Marshal(map[string]interface{}{"type": typ, "key": key, "modifiers": modifiers})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: params}, defaultActionTimeout)
	return err
}

func waitSelectorExpression(selector, state string, timeout time.Duration) string {
	return `new Promise((resolve, reject) => {
  const deadline = Date.now() + ` + fmt.Sprintf("%d", timeout.Milliseconds()) + `;
  const selector = ` + jsString(selector) + `;
  const state = ` + jsString(state) + `;
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      parseFloat(style.opacity || '1') > 0;
  };
  const check = () => {
    try {
      const el = document.querySelector(selector);
      if (state === 'visible' && visible(el)) return resolve({found: true, visible: true});
      if (state === 'hidden' && (!el || !visible(el))) return resolve({found: !!el, hidden: true});
      if (state === 'attached' && el) return resolve({found: true});
      if (state === 'detached' && !el) return resolve({found: false});
      if (Date.now() > deadline) return reject(new Error('Timeout waiting for selector: ' + selector));
      setTimeout(check, 50);
    } catch (e) {
      reject(e);
    }
  };
  check();
})`
}

func waitLoadStateExpression(loadState string, timeout time.Duration) string {
	return `new Promise((resolve, reject) => {
  const target = ` + jsString(strings.ToLower(strings.TrimSpace(loadState))) + `;
  const deadline = Date.now() + ` + fmt.Sprintf("%d", timeout.Milliseconds()) + `;
  const check = () => {
    if (target === 'domcontentloaded' && document.readyState !== 'loading') {
      resolve({readyState: document.readyState});
    } else if (target === 'load' && document.readyState === 'complete') {
      resolve({readyState: 'complete'});
    } else if (Date.now() > deadline) {
      reject(new Error('Timeout waiting for ' + target));
    } else {
      setTimeout(check, 50);
    }
  };
  check();
})`
}

func waitForFunctionExpression(expression string, timeout time.Duration) string {
	return `(function() {
  "use strict";
  var _fetch = window.fetch;
  var _open = XMLHttpRequest.prototype.open;
  var expr = ` + jsString(expression) + `;
  function serialize(value) {
    if (value === undefined) return JSON.stringify({type: 'undefined'});
    try { return JSON.stringify({type: typeof value, value: value}); }
    catch (e) { return JSON.stringify({type: typeof value, value: String(value)}); }
  }
  try {
    return new Promise((resolve, reject) => {
      var deadline = Date.now() + ` + fmt.Sprintf("%d", timeout.Milliseconds()) + `;
      var check = () => {
        try {
          var result = (new Function('return (' + expr + ')'))();
          if (result) resolve(serialize(result));
          else if (Date.now() > deadline) reject(new Error('Timeout waiting for condition'));
          else setTimeout(check, 50);
        } catch(e) { reject(e); }
      };
      check();
    });
  } finally {
    window.fetch = _fetch;
    XMLHttpRequest.prototype.open = _open;
  }
})()`
}

func evaluateExpression(expression string) string {
	return `(function() {
  "use strict";
  var _fetch = window.fetch;
  var _open = XMLHttpRequest.prototype.open;
  function serialize(value) {
    if (value === undefined) return JSON.stringify({type: 'undefined'});
    if (value === null) return JSON.stringify({type: 'null', value: null});
    try { return JSON.stringify({type: typeof value, value: value}); }
    catch (e) { return JSON.stringify({type: typeof value, value: String(value)}); }
  }
  try {
    var __expr = ` + jsString(expression) + `;
    var __result = (new Function('return (' + __expr + ')'))();
    if (__result && typeof __result.then === 'function') {
      return __result.then(serialize).catch(function(e) {
        return JSON.stringify({type: 'error', value: e && e.message ? e.message : String(e)});
      });
    }
    return serialize(__result);
  } catch(e) {
    return JSON.stringify({type: 'error', value: e && e.message ? e.message : String(e)});
  } finally {
    window.fetch = _fetch;
    XMLHttpRequest.prototype.open = _open;
  }
})()`
}

func getContentExpression(format, selector string) string {
	target := "document.body"
	if strings.TrimSpace(selector) != "" {
		target = "document.querySelector(" + jsString(selector) + ")"
	}
	switch format {
	case "html":
		return `(function(){ var el = ` + target + `; if (!el) throw new Error('Element not found'); return el.outerHTML || ''; })()`
	case "structured":
		return `(function(){
  var root = ` + target + `;
  if (!root) throw new Error('Element not found');
  var items = [];
  root.querySelectorAll('h1,h2,h3,button,a,input,textarea,select,[role]').forEach(function(el) {
    items.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 500),
      href: el.href || '',
      type: el.type || ''
    });
  });
  return JSON.stringify(items);
})()`
	default:
		return `(function(){ var el = ` + target + `; if (!el) throw new Error('Element not found'); return el.innerText || el.textContent || ''; })()`
	}
}

func runtimeValueString(out *runtimeEvalResult) string {
	if out == nil {
		return ""
	}
	if len(out.Result.Value) > 0 {
		return rawJSONValueString(out.Result.Value)
	}
	if out.Result.Description != "" {
		return out.Result.Description
	}
	return out.Result.Type
}

func rawJSONValueString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err == nil {
		compact, _ := json.Marshal(v)
		return string(compact)
	}
	return string(raw)
}

func jsString(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func clampSeconds(value, fallback, max int) time.Duration {
	if value <= 0 {
		value = fallback
	}
	if value > max {
		value = max
	}
	return time.Duration(value) * time.Second
}

func scrollDelta(direction string, amount int) (float64, float64) {
	amount = normalizedAmount(amount)
	switch normalizedDirection(direction) {
	case "up":
		return 0, -float64(amount)
	case "left":
		return -float64(amount), 0
	case "right":
		return float64(amount), 0
	default:
		return 0, float64(amount)
	}
}

func normalizedDirection(direction string) string {
	direction = strings.ToLower(strings.TrimSpace(direction))
	if direction == "" {
		return "down"
	}
	return direction
}

func normalizedAmount(amount int) int {
	if amount <= 0 {
		return 500
	}
	return minInt(amount, 5000)
}

func targetLabel(ref, selector string) string {
	if ref != "" {
		return "ref " + ref
	}
	return "selector " + selector
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func truncate(s string, max int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= max {
		return string(r)
	}
	return string(r[:max-1]) + "…"
}

func interpolate(from, to Point, steps int) []Point {
	if steps <= 0 {
		return nil
	}
	points := make([]Point, steps)
	for i := 0; i < steps; i++ {
		t := float64(i+1) / float64(steps+1)
		points[i] = Point{
			X: from.X + (to.X-from.X)*t,
			Y: from.Y + (to.Y-from.Y)*t,
		}
	}
	return points
}

func parseKeyChord(raw string) (keyChord, error) {
	parts := strings.Split(raw, "+")
	var chord keyChord
	for _, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			continue
		}
		switch strings.ToLower(token) {
		case "ctrl", "control":
			chord.Mods = appendUnique(chord.Mods, "Control")
			chord.Modifiers |= 2
		case "alt", "option":
			chord.Mods = appendUnique(chord.Mods, "Alt")
			chord.Modifiers |= 1
		case "meta", "cmd", "command":
			chord.Mods = appendUnique(chord.Mods, "Meta")
			chord.Modifiers |= 4
		case "shift":
			chord.Mods = appendUnique(chord.Mods, "Shift")
			chord.Modifiers |= 8
		case "win", "windows", "super":
			return keyChord{}, fmt.Errorf("Windows/Super key shortcuts are not allowed")
		default:
			if chord.Key != "" {
				return keyChord{}, fmt.Errorf("shortcut must contain exactly one non-modifier key")
			}
			chord.Key = normalizeKeyName(token)
		}
	}
	if chord.Key == "" {
		return keyChord{}, fmt.Errorf("key is required")
	}
	lowerKey := strings.ToLower(chord.Key)
	if chord.Modifiers&1 != 0 && lowerKey == "f4" {
		return keyChord{}, fmt.Errorf("Alt+F4 is not allowed")
	}
	if chord.Modifiers&1 != 0 && chord.Modifiers&2 != 0 && (lowerKey == "delete" || lowerKey == "del") {
		return keyChord{}, fmt.Errorf("Ctrl+Alt+Del is not allowed")
	}
	return chord, nil
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func normalizeKeyName(key string) string {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "esc":
		return "Escape"
	case "del":
		return "Delete"
	case "space":
		return " "
	case "arrowup", "up":
		return "ArrowUp"
	case "arrowdown", "down":
		return "ArrowDown"
	case "arrowleft", "left":
		return "ArrowLeft"
	case "arrowright", "right":
		return "ArrowRight"
	default:
		if len([]rune(key)) == 1 {
			return strings.ToLower(key)
		}
		return key
	}
}

func modifierBit(mod string) int {
	switch mod {
	case "Alt":
		return 1
	case "Control":
		return 2
	case "Meta":
		return 4
	case "Shift":
		return 8
	default:
		return 0
	}
}

func modifierKeyName(mod string) string {
	if mod == "Control" {
		return "Control"
	}
	return mod
}

func applyPaperFormat(params map[string]interface{}, format string) error {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", "a4":
		params["paperWidth"] = 8.27
		params["paperHeight"] = 11.69
	case "letter":
		params["paperWidth"] = 8.5
		params["paperHeight"] = 11
	case "legal":
		params["paperWidth"] = 8.5
		params["paperHeight"] = 14
	default:
		return fmt.Errorf("unsupported PDF format %q; use A4, Letter, or Legal", format)
	}
	return nil
}

func resolvePDFOutputPath(path string) (string, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "" {
		return "", fmt.Errorf("outputPath is required")
	}
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return filepath.Join(path, fmt.Sprintf("page-%d.pdf", time.Now().UnixNano())), nil
	}
	if strings.EqualFold(filepath.Ext(path), ".pdf") {
		return path, nil
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", fmt.Errorf("failed to create PDF dir: %w", err)
	}
	return filepath.Join(path, fmt.Sprintf("page-%d.pdf", time.Now().UnixNano())), nil
}

func distance(a, b Point) float64 {
	return math.Hypot(a.X-b.X, a.Y-b.Y)
}
