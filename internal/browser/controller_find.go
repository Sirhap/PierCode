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

	if req.Ref != "" {
		target, err := c.tabs.ResolveRef(tab.TabID, req.SnapshotID, req.Ref)
		if err != nil {
			return tool.BrowserZoomResponse{}, err
		}
		if target.Bounds == nil && target.BackendID > 0 {
			bounds, err := c.boxModelBounds(ctx, tab.TabID, target.BackendID)
			if err != nil {
				c.tabs.MarkStale(tab.TabID)
				return tool.BrowserZoomResponse{}, fmt.Errorf("snapshot is stale; call browser_snapshot again: %w", err)
			}
			target.Bounds = bounds
		}
		if target.Bounds == nil {
			return tool.BrowserZoomResponse{}, fmt.Errorf("ref %s has no bounds; call browser_snapshot again or use selector", req.Ref)
		}
		clipX = target.Bounds.X
		clipY = target.Bounds.Y
		if clipW == 0 {
			clipW = target.Bounds.Width
		}
		if clipH == 0 {
			clipH = target.Bounds.Height
		}
	} else if req.Selector != "" {
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
	if err := c.sendNativeWithTimeout(ctx, "resizeWindow", map[string]interface{}{
		"tabId":  tab.TabID,
		"width":  req.Width,
		"height": req.Height,
	}, defaultActionTimeout, nil); err != nil {
		return "", fmt.Errorf("failed to resize browser window: %w", err)
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
	if req.RequestID != "" {
		body, err := c.FetchResponseBody(ctx, tab.TabID, req.RequestID, req.MaxBodyBytes)
		if err != nil {
			return "", fmt.Errorf("could not fetch response body for %s (request may have left the cache): %w", req.RequestID, err)
		}
		return fmt.Sprintf("Response body for %s:\n%s", req.RequestID, body), nil
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
		switch {
		case r.StatusCode > 0:
			status = fmt.Sprintf("%d", r.StatusCode)
		case r.StatusCode < 0:
			status = "ERR"
		}
		duration := ""
		if r.Duration > 0 {
			duration = fmt.Sprintf(" %dms", int(r.Duration))
		}
		sb.WriteString(fmt.Sprintf("%-4s %3s %-20s [%-10s] %s%s [id=%s]\n", r.Method, status, r.StatusText, r.Type, r.URL, duration, r.RequestID))
	}
	sb.WriteString("\nFetch a response body with browser_network requestId=<id>.\n")
	return sb.String(), nil
}

// FetchResponseBody returns the response body for a recorded request via CDP
// Network.getResponseBody, size-capped to 1 MiB. The request must still be in
// the page's resource cache (recent requests only).
func (c *Controller) FetchResponseBody(ctx context.Context, tabID int, requestID string, maxBytes int) (string, error) {
	if maxBytes <= 0 || maxBytes > 1<<20 {
		maxBytes = 1 << 20
	}
	params, _ := json.Marshal(map[string]string{"requestId": requestID})
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Network", Method: "getResponseBody", Params: params}, defaultReadTimeout)
	if err != nil {
		return "", err
	}
	var out struct {
		Body          string `json:"body"`
		Base64Encoded bool   `json:"base64Encoded"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	body := out.Body
	if out.Base64Encoded {
		body = "(base64-encoded binary body) " + body
	}
	if len(body) > maxBytes {
		body = body[:maxBytes] + "\n…(truncated)"
	}
	return body, nil
}

func (c *Controller) Cookies(ctx context.Context, req tool.BrowserCookiesRequest) (tool.BrowserCookiesResponse, error) {
	if strings.TrimSpace(req.Domain) == "" && strings.TrimSpace(req.URL) == "" {
		return tool.BrowserCookiesResponse{}, fmt.Errorf("domain or url is required")
	}
	scope := strings.TrimSpace(req.URL)
	if scope == "" {
		scope = strings.TrimSpace(req.Domain)
	}
	risk := "Cookie names and metadata may expose browser session details."
	if req.IncludeValue {
		risk = "Cookie values may include session tokens or other sensitive credentials."
	}
	if err := c.approvals.Ask(ctx, ApprovalAsk{
		Action: "read browser cookies",
		Target: scope,
		Risk:   risk,
	}); err != nil {
		return tool.BrowserCookiesResponse{}, err
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

  // Only consider elements a user could actually target. Containers (div/section)
  // are scored but heavily penalized so the labelled control wins over its wrapper.
  var INTERACTIVE = {a:1,button:1,input:1,select:1,textarea:1,summary:1,label:1,option:1};
  var INTERACTIVE_ROLES = {button:1,link:1,textbox:1,searchbox:1,checkbox:1,radio:1,combobox:1,menuitem:1,tab:1,option:1,switch:1,slider:1};

  function visible(el){
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity||'1') === 0) return false;
    if (el.closest('[aria-hidden=true]')) return false;
    return true;
  }
  // The element's OWN label text, not the whole subtree (so an ancestor that
  // merely contains a matching button does not outscore the button).
  function ownText(el){
    var t = '';
    for (var i=0;i<el.childNodes.length;i++){ var n=el.childNodes[i]; if(n.nodeType===3) t+=n.textContent; }
    t = t.trim();
    if (!t && (el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role'))) t=(el.textContent||'').trim();
    return t.slice(0,200);
  }
  function stableSelector(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    var al = el.getAttribute('aria-label');
    if (al) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(al) + '"]';
    var ph = el.getAttribute('placeholder');
    if (ph) return el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(ph) + '"]';
    // Fallback: tag + nth-of-type within parent (short, less brittle than a deep chain).
    var p = el.parentElement;
    if (p){ var same=0, idx=0; for(var i=0;i<p.children.length;i++){ if(p.children[i].tagName===el.tagName){ same++; if(p.children[i]===el) idx=same; } }
      var base=(p.id?('#'+CSS.escape(p.id)+' >'):'') ; return (base+' '+el.tagName.toLowerCase()+':nth-of-type('+idx+')').trim(); }
    return el.tagName.toLowerCase();
  }

  var results = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
  var node;
  while (node = walker.nextNode()) {
    var tag = node.tagName.toLowerCase();
    var roleAttr = (node.getAttribute('role') || '').toLowerCase();
    var role = roleAttr || tag;
    var isInteractive = INTERACTIVE[tag] || INTERACTIVE_ROLES[roleAttr] || node.tabIndex >= 0;
    var ariaLabel = (node.getAttribute('aria-label') || '').trim();
    var title = (node.getAttribute('title') || '').trim();
    var placeholder = (node.getAttribute('placeholder') || '').trim();
    var text = ownText(node);

    var hay = (ariaLabel+' '+title+' '+placeholder+' '+text+' '+role).toLowerCase();
    var score = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (ariaLabel.toLowerCase().indexOf(term) >= 0) score += 4;
      if (placeholder.toLowerCase().indexOf(term) >= 0) score += 3;
      if (title.toLowerCase().indexOf(term) >= 0) score += 3;
      if (text.toLowerCase().indexOf(term) >= 0) score += 2;
      if (role.indexOf(term) >= 0) score += 2;
      else if (hay.indexOf(term) >= 0) score += 1;
    }
    if (score === 0) continue;
    // Reward interactive leaves; penalize big containers so the control wins.
    if (isInteractive) score += 3;
    else { score -= 2; if ((node.textContent||'').length > 400) score -= 2; }
    if (score <= 0) continue;
    if (!visible(node)) continue;

    var displayText = ariaLabel || placeholder || title || text;
    results.push({ref: stableSelector(node), role: role, text: displayText.slice(0,200), score: score});
  }

  results.sort(function(a, b) { return b.score - a.score; });
  return JSON.stringify(results.slice(0, maxResults));
})()`
}
