package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func (c *Controller) Find(ctx context.Context, req tool.BrowserFindRequest) ([]tool.BrowserFindResult, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return nil, err
	}
	maxResults := req.MaxResults
	if maxResults <= 0 {
		maxResults = 20
	}
	expression := findElementsExpression(req.Query, maxResults)
	out, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultReadTimeout, true)
	if err != nil {
		return nil, err
	}
	raw := runtimeValueString(out)
	var results []tool.BrowserFindResult
	if err := json.Unmarshal([]byte(raw), &results); err != nil {
		return nil, fmt.Errorf("failed to parse find results: %w", err)
	}
	return results, nil
}

func (c *Controller) Zoom(ctx context.Context, req tool.BrowserZoomRequest) (tool.BrowserZoomResponse, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return tool.BrowserZoomResponse{}, err
	}
	if c.policy.IsSensitive(tab) {
		return tool.BrowserZoomResponse{}, fmt.Errorf("browser_zoom refused on sensitive payment/financial page")
	}
	target := "zoom capture"
	if req.Ref != "" {
		target = "ref " + req.Ref
	} else if req.Selector != "" {
		target = "selector " + req.Selector
	}
	if err := c.ask(ctx, req.CallID, "区域截图", tab, target, "截取页面特定区域的内容。"); err != nil {
		return tool.BrowserZoomResponse{}, err
	}

	var clipX, clipY, clipW, clipH float64
	if req.Width != nil {
		clipW = *req.Width
	}
	if req.Height != nil {
		clipH = *req.Height
	}

	if req.Selector != "" {
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  var rect = el.getBoundingClientRect();
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
})()`
		out, evalErr := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultReadTimeout, true)
		if evalErr != nil {
			return tool.BrowserZoomResponse{}, evalErr
		}
		var rect struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
		}
		if jsonErr := json.Unmarshal([]byte(runtimeValueString(out)), &rect); jsonErr != nil {
			return tool.BrowserZoomResponse{}, fmt.Errorf("failed to parse element bounds: %w", jsonErr)
		}
		clipX = rect.X
		clipY = rect.Y
		if clipW == 0 {
			clipW = rect.Width
		}
		if clipH == 0 {
			clipH = rect.Height
		}
	} else if req.X != nil && req.Y != nil {
		clipX = *req.X
		clipY = *req.Y
	}

	screenshotParams, _ := json.Marshal(map[string]interface{}{
		"format":  "jpeg",
		"quality": 60,
		"clip": map[string]interface{}{
			"x":      clipX,
			"y":      clipY,
			"width":  clipW,
			"height": clipH,
			"scale":  1,
		},
		"captureBeyondViewport": false,
		"fromSurface":           true,
	})
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Page",
		Method: "captureScreenshot",
		Params: screenshotParams,
	}, defaultScreenshotTimeout)
	if err != nil {
		return tool.BrowserZoomResponse{}, err
	}
	var screenshotOut struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &screenshotOut); err != nil {
		return tool.BrowserZoomResponse{}, err
	}
	decoded, err := base64.StdEncoding.DecodeString(screenshotOut.Data)
	if err != nil {
		return tool.BrowserZoomResponse{}, fmt.Errorf("invalid screenshot base64: %w", err)
	}
	outputDir := strings.TrimSpace(req.OutputDir)
	if outputDir == "" {
		home, _ := os.UserHomeDir()
		outputDir = filepath.Join(home, ".piercode", "screenshots")
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return tool.BrowserZoomResponse{}, fmt.Errorf("failed to create screenshot dir: %w", err)
	}
	filePath := filepath.Join(outputDir, fmt.Sprintf("zoom-%d.jpg", time.Now().UnixNano()))
	if err := os.WriteFile(filePath, decoded, 0o644); err != nil {
		return tool.BrowserZoomResponse{}, fmt.Errorf("failed to write screenshot: %w", err)
	}
	return tool.BrowserZoomResponse{Tab: tab, FilePath: filePath, Bytes: len(decoded)}, nil
}

func (c *Controller) Resize(ctx context.Context, req tool.BrowserResizeRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	getWinParams, _ := json.Marshal(map[string]interface{}{})
	raw, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Browser",
		Method: "getWindowForTarget",
		Params: getWinParams,
	}, defaultReadTimeout)
	if err != nil {
		return "", fmt.Errorf("failed to get window id: %w", err)
	}
	var winOut struct {
		WindowID int `json:"windowId"`
	}
	if err := json.Unmarshal(raw, &winOut); err != nil {
		return "", fmt.Errorf("failed to parse window id: %w", err)
	}
	if winOut.WindowID == 0 {
		return "", fmt.Errorf("Browser.getWindowForTarget returned no windowId")
	}
	boundsParams, _ := json.Marshal(map[string]interface{}{
		"windowId": winOut.WindowID,
		"bounds": map[string]interface{}{
			"width":  req.Width,
			"height": req.Height,
		},
	})
	if _, err := c.relay.SendCommand(ctx, Command{
		TabID:  &tab.TabID,
		Domain: "Browser",
		Method: "setWindowBounds",
		Params: boundsParams,
	}, defaultActionTimeout); err != nil {
		return "", fmt.Errorf("failed to set window bounds: %w", err)
	}
	return fmt.Sprintf("resized browser window to %dx%d for tabId=%d", req.Width, req.Height, tab.TabID), nil
}

func (c *Controller) FormInput(ctx context.Context, req tool.BrowserFormInputRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if c.policy.IsSensitive(tab) {
		return "", fmt.Errorf("browser_form_input refused on sensitive payment/financial page")
	}
	target := targetLabel(req.Ref, req.Selector)
	if err := c.ask(ctx, req.CallID, "设置表单元素值", tab, target, "修改表单元素值可能影响页面状态。"); err != nil {
		return "", err
	}

	fn := `function(value) {
  var tag = this.tagName.toLowerCase();
  if (tag === 'input') {
    var type = (this.type || 'text').toLowerCase();
    if (type === 'checkbox') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
      if (setter) setter.call(this, !!value);
      else this.checked = !!value;
      this.dispatchEvent(new Event('input', {bubbles: true}));
      this.dispatchEvent(new Event('change', {bubbles: true}));
      return {type: 'checkbox', checked: this.checked};
    }
    if (type === 'radio') {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
      if (setter) setter.call(this, true);
      else this.checked = true;
      this.dispatchEvent(new Event('input', {bubbles: true}));
      this.dispatchEvent(new Event('change', {bubbles: true}));
      return {type: 'radio', checked: this.checked, value: this.value};
    }
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (setter) setter.call(this, String(value));
    else this.value = String(value);
    this.dispatchEvent(new Event('input', {bubbles: true}));
    this.dispatchEvent(new Event('change', {bubbles: true}));
    return {type: type, value: this.value};
  }
  if (tag === 'textarea') {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    if (setter) setter.call(this, String(value));
    else this.value = String(value);
    this.dispatchEvent(new Event('input', {bubbles: true}));
    this.dispatchEvent(new Event('change', {bubbles: true}));
    return {type: 'textarea', value: this.value};
  }
  if (this.isContentEditable) {
    this.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, String(value));
    if (this.textContent !== String(value)) {
      this.textContent = String(value);
      this.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true, inputType: 'insertText', data: String(value)}));
    }
    return {type: 'contenteditable', text: this.textContent};
  }
  throw new Error('Unsupported element type: ' + tag);
}`

	if req.Ref != "" {
		objectID, release, err := c.resolveRefObject(ctx, tab.TabID, req.SnapshotID, req.Ref)
		if err != nil {
			return "", err
		}
		defer release()
		if _, err := c.callFunctionOnObject(ctx, tab.TabID, objectID, fn, []interface{}{req.Value}); err != nil {
			return "", err
		}
	} else {
		valueJSON, err := json.Marshal(req.Value)
		if err != nil {
			return "", fmt.Errorf("failed to serialize form input value: %w", err)
		}
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  return (` + fn + `).call(el, ` + string(valueJSON) + `);
})()`
		if _, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultActionTimeout, true); err != nil {
			return "", err
		}
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("form input set on %s in tabId=%d", target, tab.TabID), nil
}

func (c *Controller) ReadConsole(ctx context.Context, req tool.BrowserConsoleRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if !c.events.IsDomainEnabled(tab.TabID, "Runtime") {
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Runtime",
			Method: "enable",
			Params: json.RawMessage(`{}`),
		}, defaultReadTimeout); err != nil {
			return "", err
		}
		c.events.MarkDomainEnabled(tab.TabID, "Runtime")
	}

	filter := ConsoleFilter{
		Pattern:    req.Pattern,
		OnlyErrors: req.OnlyErrors,
		Limit:      req.Limit,
	}
	messages := c.events.GetConsoleMessages(tab.TabID, filter)
	if req.Clear {
		c.events.ClearConsole(tab.TabID)
	}

	if len(messages) == 0 {
		return "No console messages recorded", nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Console messages (%d", len(messages)))
	if req.Clear {
		sb.WriteString(", buffer cleared")
	}
	sb.WriteString("):\n\n")

	for _, msg := range messages {
		ts := time.Unix(int64(msg.Timestamp), 0).UTC().Format("15:04:05")
		sb.WriteString(fmt.Sprintf("[%s] [%-5s] %s\n", ts, strings.ToUpper(msg.Type), msg.Text))
	}
	return sb.String(), nil
}

func (c *Controller) ReadNetwork(ctx context.Context, req tool.BrowserNetworkLogRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	if !c.events.IsDomainEnabled(tab.TabID, "Network") {
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Network",
			Method: "enable",
			Params: json.RawMessage(`{}`),
		}, defaultReadTimeout); err != nil {
			return "", err
		}
		c.events.MarkDomainEnabled(tab.TabID, "Network")
	}

	filter := NetworkFilter{
		URLPattern: req.URLPattern,
		Limit:      req.Limit,
	}
	requests := c.events.GetNetworkRequests(tab.TabID, filter)
	if req.Clear {
		c.events.ClearNetwork(tab.TabID)
	}

	if len(requests) == 0 {
		return "No network requests recorded", nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Network requests (%d", len(requests)))
	if req.Clear {
		sb.WriteString(", buffer cleared")
	}
	sb.WriteString("):\n\n")

	for _, r := range requests {
		status := "pending"
		if r.StatusCode > 0 {
			status = fmt.Sprintf("%d", r.StatusCode)
		}
		duration := ""
		if r.Duration > 0 {
			duration = fmt.Sprintf(" %dms", int(r.Duration))
		}
		sb.WriteString(fmt.Sprintf("%-4s %3s %-12s [%-10s] %s%s\n", r.Method, status, r.StatusText, r.Type, r.URL, duration))
	}
	return sb.String(), nil
}

func (c *Controller) Cookies(ctx context.Context, req tool.BrowserCookiesRequest) (tool.BrowserCookiesResponse, error) {
	if strings.TrimSpace(req.Domain) == "" && strings.TrimSpace(req.URL) == "" {
		return tool.BrowserCookiesResponse{}, fmt.Errorf("domain or url is required")
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	params, _ := json.Marshal(map[string]interface{}{
		"domain":       strings.TrimSpace(req.Domain),
		"url":          strings.TrimSpace(req.URL),
		"includeValue": req.IncludeValue,
		"limit":        limit,
	})
	raw, err := c.relay.SendCommand(ctx, Command{
		Domain: "PierCode",
		Method: "cookies",
		Params: params,
	}, defaultReadTimeout)
	if err != nil {
		return tool.BrowserCookiesResponse{}, err
	}
	var resp tool.BrowserCookiesResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return tool.BrowserCookiesResponse{}, fmt.Errorf("failed to parse cookies response: %w", err)
	}
	return resp, nil
}

func findElementsExpression(query string, maxResults int) string {
	return `(function() {
  var query = ` + jsString(query) + `;
  var maxResults = ` + fmt.Sprintf("%d", maxResults) + `;
  var terms = query.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 0; });
  if (terms.length === 0) return JSON.stringify([]);

  var results = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
  var node;
  while (node = walker.nextNode()) {
    var role = node.getAttribute('role') || node.tagName.toLowerCase();
    var ariaLabel = (node.getAttribute('aria-label') || '').trim();
    var title = (node.getAttribute('title') || '').trim();
    var text = (node.textContent || '').trim().slice(0, 200);
    var placeholder = (node.getAttribute('placeholder') || '').trim();

    var score = 0;
    var textLower = text.toLowerCase();
    var ariaLower = ariaLabel.toLowerCase();
    var titleLower = title.toLowerCase();
    var roleLower = role.toLowerCase();
    var placeholderLower = placeholder.toLowerCase();

    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (ariaLower.indexOf(term) >= 0) score += 3;
      if (titleLower.indexOf(term) >= 0) score += 3;
      if (textLower.indexOf(term) >= 0) score += 1;
      if (roleLower.indexOf(term) >= 0) score += 2;
      if (placeholderLower.indexOf(term) >= 0) score += 2;
    }

    if (score > 0) {
      var displayText = ariaLabel || title || placeholder || text.slice(0, 100);
      var selector = '';
      try {
        var el = node;
        var parts = [];
        while (el && el !== document.body) {
          var part = el.tagName.toLowerCase();
          if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
          if (el.className && typeof el.className === 'string') {
            var cls = el.className.trim().split(/\s+/).slice(0, 2).map(function(c) { return CSS.escape(c); }).join('.');
            if (cls) part += '.' + cls;
          }
          parts.unshift(part);
          el = el.parentElement;
        }
        selector = parts.join(' > ');
      } catch(e) { selector = role; }

      results.push({ref: selector, role: role, text: displayText.slice(0, 200), score: score});
    }
  }

  results.sort(function(a, b) { return b.score - a.score; });
  return JSON.stringify(results.slice(0, maxResults));
})()`
}
