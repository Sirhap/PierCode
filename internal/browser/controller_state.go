package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func (c *Controller) Storage(ctx context.Context, req tool.BrowserStorageRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	store := "localStorage"
	if strings.ToLower(req.Storage) == "session" {
		store = "sessionStorage"
	}
	action := strings.ToLower(req.Action)
	expression := storageExpression(store, action, req.Key, req.Value)
	out, err := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultReadTimeout, true)
	if err != nil {
		return "", err
	}
	value := runtimeValueString(out)
	return fmt.Sprintf("%s %s tabId=%d %s", store, action, tab.TabID, value), nil
}

func storageExpression(store, action, key, value string) string {
	switch action {
	case "set":
		return `(function(){` + store + `.setItem(` + jsString(key) + `,` + jsString(value) + `);return 'ok';})()`
	case "remove":
		return `(function(){` + store + `.removeItem(` + jsString(key) + `);return 'ok';})()`
	case "clear":
		return `(function(){var n=` + store + `.length;` + store + `.clear();return 'cleared '+n+' items';})()`
	case "keys":
		return `(function(){var out=[];for(var i=0;i<` + store + `.length;i++){out.push(` + store + `.key(i));}return JSON.stringify(out);})()`
	default: // get
		return `(function(){var v=` + store + `.getItem(` + jsString(key) + `);return v===null?'(null)':v;})()`
	}
}

func (c *Controller) SetCookie(ctx context.Context, req tool.BrowserSetCookieRequest) (string, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	scope := req.Domain
	if scope == "" {
		scope = req.URL
	}
	tab, _ := c.tabs.DefaultTab()
	target := fmt.Sprintf("%s %s @ %s", action, req.Name, scope)
	if err := c.ask(ctx, req.CallID, "写入/删除 Cookie", tab, target, "写 Cookie 可注入登录态或会话凭证，需确认后执行。"); err != nil {
		return "", err
	}
	params := map[string]interface{}{
		"action":   action,
		"name":     req.Name,
		"value":    req.Value,
		"domain":   req.Domain,
		"url":      req.URL,
		"path":     req.Path,
		"secure":   req.Secure,
		"httpOnly": req.HTTPOnly,
		"sameSite": req.SameSite,
	}
	if req.ExpirationDate > 0 {
		params["expirationDate"] = req.ExpirationDate
	}
	var out struct {
		OK     bool   `json:"ok"`
		Name   string `json:"name"`
		Domain string `json:"domain"`
	}
	if err := c.sendNative(ctx, "setCookie", params, &out); err != nil {
		return "", err
	}
	if action == "delete" {
		return fmt.Sprintf("deleted cookie %s @ %s", req.Name, scope), nil
	}
	return fmt.Sprintf("set cookie %s @ %s", out.Name, out.Domain), nil
}

func (c *Controller) WaitForNavigation(ctx context.Context, req tool.BrowserWaitForNavigationRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	waitUntil := strings.ToLower(strings.TrimSpace(req.WaitUntil))
	if waitUntil != "domcontentloaded" {
		waitUntil = "load"
	}
	expression := waitForNavigationExpression(req.URLPattern, waitUntil, timeout)
	out, err := c.runtimeEvaluate(ctx, tab.TabID, expression, true, timeout+2*time.Second, true)
	if err != nil {
		return "", err
	}
	c.tabs.MarkStale(tab.TabID)
	return fmt.Sprintf("navigation complete tabId=%d url=%s", tab.TabID, runtimeValueString(out)), nil
}

func waitForNavigationExpression(urlPattern, waitUntil string, timeout time.Duration) string {
	readyTarget := "complete"
	if waitUntil == "domcontentloaded" {
		readyTarget = "interactive"
	}
	return `(function(){
  "use strict";
  var pattern = ` + jsString(urlPattern) + `;
  var readyTarget = ` + jsString(readyTarget) + `;
  var re = null;
  if (pattern) { try { re = new RegExp(pattern); } catch(e) { re = null; } }
  function urlOk() {
    if (!pattern) return true;
    if (re && re.test(location.href)) return true;
    return location.href.indexOf(pattern) >= 0;
  }
  function readyOk() {
    if (readyTarget === 'interactive') {
      return document.readyState === 'interactive' || document.readyState === 'complete';
    }
    return document.readyState === 'complete';
  }
  return new Promise((resolve, reject) => {
    var deadline = Date.now() + ` + fmt.Sprintf("%d", timeout.Milliseconds()) + `;
    var check = () => {
      if (urlOk() && readyOk()) resolve(location.href);
      else if (Date.now() > deadline) reject(new Error('Timeout waiting for navigation; current url=' + location.href + ' readyState=' + document.readyState));
      else setTimeout(check, 100);
    };
    check();
  });
})()`
}

func (c *Controller) Emulate(ctx context.Context, req tool.BrowserEmulateRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	type cdpCmd struct {
		method string
		params map[string]interface{}
	}
	var cmds []cdpCmd
	if req.Reset {
		cmds = []cdpCmd{
			{"setUserAgentOverride", map[string]interface{}{"userAgent": ""}},
			{"clearDeviceMetricsOverride", map[string]interface{}{}},
			{"setEmulatedMedia", map[string]interface{}{"features": []interface{}{}}},
			{"setTimezoneOverride", map[string]interface{}{"timezoneId": ""}},
			{"clearGeolocationOverride", map[string]interface{}{}},
		}
	} else {
		if req.UserAgent != "" {
			cmds = append(cmds, cdpCmd{"setUserAgentOverride", map[string]interface{}{"userAgent": req.UserAgent}})
		}
		if req.DeviceScaleFactor > 0 || req.Mobile != nil {
			mobile := false
			if req.Mobile != nil {
				mobile = *req.Mobile
			}
			dsf := req.DeviceScaleFactor
			if dsf <= 0 {
				dsf = 1
			}
			cmds = append(cmds, cdpCmd{"setDeviceMetricsOverride", map[string]interface{}{
				"width":             0,
				"height":            0,
				"deviceScaleFactor": dsf,
				"mobile":            mobile,
			}})
		}
		if req.ColorScheme != "" {
			cmds = append(cmds, cdpCmd{"setEmulatedMedia", map[string]interface{}{
				"features": []map[string]interface{}{
					{"name": "prefers-color-scheme", "value": req.ColorScheme},
				},
			}})
		}
		if req.Timezone != "" {
			cmds = append(cmds, cdpCmd{"setTimezoneOverride", map[string]interface{}{"timezoneId": req.Timezone}})
		}
		if req.Latitude != nil && req.Longitude != nil {
			accuracy := 100.0
			if req.Accuracy != nil {
				accuracy = *req.Accuracy
			}
			cmds = append(cmds, cdpCmd{"setGeolocationOverride", map[string]interface{}{
				"latitude":  *req.Latitude,
				"longitude": *req.Longitude,
				"accuracy":  accuracy,
			}})
		}
	}

	var applied []string
	for _, cmd := range cmds {
		params, _ := json.Marshal(cmd.params)
		if _, err := c.relay.SendCommand(ctx, Command{
			TabID:  &tab.TabID,
			Domain: "Emulation",
			Method: cmd.method,
			Params: params,
		}, defaultActionTimeout); err != nil {
			return "", fmt.Errorf("emulate %s failed after applying %v: %w", cmd.method, applied, err)
		}
		applied = append(applied, cmd.method)
	}
	c.tabs.MarkStale(tab.TabID)
	if req.Reset {
		return fmt.Sprintf("reset emulation overrides in tabId=%d", tab.TabID), nil
	}
	return fmt.Sprintf("applied emulation in tabId=%d: %s", tab.TabID, strings.Join(applied, ", ")), nil
}

func (c *Controller) GetAttributes(ctx context.Context, req tool.BrowserGetAttributesRequest) (string, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return "", err
	}
	attrsJSON, _ := json.Marshal(req.Attributes)
	stylesJSON, _ := json.Marshal(req.Styles)
	fn := `function(attrs, styles) {
  var out = {tag: this.tagName.toLowerCase(), attributes: {}, styles: {}};
  for (var i = 0; i < attrs.length; i++) {
    out.attributes[attrs[i]] = this.hasAttribute(attrs[i]) ? this.getAttribute(attrs[i]) : null;
  }
  if (styles.length > 0) {
    var cs = window.getComputedStyle(this);
    for (var j = 0; j < styles.length; j++) {
      out.styles[styles[j]] = cs.getPropertyValue(styles[j]);
    }
  }
  return JSON.stringify(out);
}`
	var raw string
	if req.Ref != "" {
		objectID, release, refErr := c.resolveRefObject(ctx, tab.TabID, req.SnapshotID, req.Ref)
		if refErr != nil {
			return "", refErr
		}
		defer release()
		out, callErr := c.callFunctionOnObject(ctx, tab.TabID, objectID, fn, []interface{}{req.Attributes, req.Styles})
		if callErr != nil {
			return "", callErr
		}
		raw = runtimeValueString(out)
	} else {
		expression := `(function() {
  var el = document.querySelector(` + jsString(req.Selector) + `);
  if (!el) throw new Error('Element not found: ' + ` + jsString(req.Selector) + `);
  return (` + fn + `).call(el, ` + string(attrsJSON) + `, ` + string(stylesJSON) + `);
})()`
		out, evalErr := c.runtimeEvaluate(ctx, tab.TabID, expression, false, defaultReadTimeout, true)
		if evalErr != nil {
			return "", evalErr
		}
		raw = runtimeValueString(out)
	}
	return fmt.Sprintf("attributes for %s in tabId=%d:\n%s", targetLabel(req.Ref, req.Selector), tab.TabID, raw), nil
}
