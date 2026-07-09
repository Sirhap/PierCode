// Deprecated execution path (like the other browser_* definitions — see the
// package note in browser_tools.go): browser_intercept and browser_reset
// EXECUTE in the extension service worker (extension/src/background/browser/
// intercept.ts + controller.ts). The Go definitions exist so the prompt
// profiles ({{TOOLS}}) advertise them and /exec callers get a clear redirect.
package tool

import (
	"fmt"
	"strings"
)

// CDP Network.ErrorReason values accepted for browser_intercept fail. Mirrors
// FAIL_REASONS in intercept.ts.
var interceptFailReasons = map[string]bool{
	"Failed": true, "Aborted": true, "TimedOut": true, "AccessDenied": true,
	"ConnectionClosed": true, "ConnectionReset": true, "ConnectionRefused": true,
	"ConnectionAborted": true, "ConnectionFailed": true, "NameNotResolved": true,
	"InternetDisconnected": true, "AddressUnreachable": true, "BlockedByClient": true,
	"BlockedByResponse": true,
}

// NewBrowserInterceptTool returns browser_intercept — network mock / stub / block
// for deterministic testing. action=add stubs (fulfill) or blocks (fail) requests
// matching a URL pattern; action=clear removes all rules; action=list shows them.
func NewBrowserInterceptTool() Tool {
	return &browserTool{
		name:        "browser_intercept",
		readOnly:    false,
		description: "Mock or block network requests for deterministic tests. action=add: stub matching requests with a canned response (status/body/contentType) OR block them (fail with a CDP errorReason); url is a substring or a *glob*, optional method filter and times cap. action=clear: remove all rules and stop intercepting. action=list: show active rules. Use before the navigation/interaction that triggers the request.",
		parameters: map[string]string{
			"action":      "string (optional, add|clear|list, default add)",
			"url":         "string (required for add) - URL substring, or a pattern with * wildcards",
			"method":      "string (optional) - only intercept this HTTP method (GET/POST/…)",
			"status":      "number (optional, default 200) - fulfilled response status code",
			"body":        "string (optional) - fulfilled response body",
			"contentType": "string (optional) - fulfilled response Content-Type header",
			"fail":        "string (optional) - block instead of fulfilling; a CDP errorReason (Failed|Aborted|ConnectionRefused|BlockedByClient|…)",
			"times":       "number (optional) - apply at most N times, then let matching requests through",
			"tabId":       "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			action := strings.ToLower(stringArg(args, "action"))
			if action == "" {
				action = "add"
			}
			if action != "add" && action != "clear" && action != "list" {
				return fmt.Errorf("action must be add, clear, or list")
			}
			if action == "add" {
				if strings.TrimSpace(stringArg(args, "url")) == "" {
					return fmt.Errorf("action=add requires a url pattern")
				}
				if fail := stringArg(args, "fail"); fail != "" && !interceptFailReasons[fail] {
					return fmt.Errorf("fail must be a CDP errorReason (e.g. Failed, Aborted, ConnectionRefused, BlockedByClient)")
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_intercept %s", browserTestingSWOnly)
		},
	}
}

// NewBrowserResetTool returns browser_reset — clear page state for test isolation
// (cookies, cache, per-origin storage, emulation overrides). Each part is opt-out.
func NewBrowserResetTool() Tool {
	return &browserTool{
		name:        "browser_reset",
		readOnly:    false,
		description: "Reset browser state for a clean test run: clears cookies, cache, the controlled tab's origin storage (local/session), and any emulation overrides. Each part is opt-out via a false flag. Run at the start of a test case to isolate it from prior state. Note: clearing cookies can log the user out of the site.",
		parameters: map[string]string{
			"cookies":   "boolean (optional, default true) - clear browser cookies",
			"cache":     "boolean (optional, default true) - clear browser cache",
			"storage":   "boolean (optional, default true) - clear local/session storage for the tab's origin",
			"emulation": "boolean (optional, default true) - clear device/UA/network emulation overrides",
			"tabId":     "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_reset %s", browserTestingSWOnly)
		},
	}
}

// NewBrowserVisualDiffTool returns browser_visual_diff — screenshot-baseline
// visual regression. baseline stores a reference shot; compare screenshots again
// and FAILS (tool error) when the changed-pixel ratio exceeds the threshold.
func NewBrowserVisualDiffTool() Tool {
	return &browserTool{
		name:        "browser_visual_diff",
		readOnly:    true,
		description: "Visual regression check. {action:\"baseline\", key} stores a reference screenshot of the controlled tab; {action:\"compare\", key, threshold?} screenshots again and PASSes when the changed-pixel ratio is within threshold (default 0.01 = 1%), FAILing as a tool error otherwise (usable as a browser_test step). {action:\"clear\", key?} removes one/all baselines; {action:\"list\"} shows them. Keep the viewport identical between baseline and compare.",
		parameters: map[string]string{
			"action":    "string (optional, baseline|compare|clear|list, default compare)",
			"key":       "string (required for baseline/compare) - baseline name, e.g. \"home-page\"",
			"threshold": "number (optional, default 0.01) - max allowed changed-pixel ratio (0..1)",
			"maxDim":    "number (optional, default 800) - longest side the shots are scaled to before comparing",
			"tolerance": "number (optional, default 16) - per-channel delta (0-255) a pixel may drift before it counts as changed",
			"tabId":     "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			action := strings.ToLower(stringArg(args, "action"))
			if action == "" {
				action = "compare"
			}
			if action != "baseline" && action != "compare" && action != "clear" && action != "list" {
				return fmt.Errorf("action must be baseline, compare, clear, or list")
			}
			if (action == "baseline" || action == "compare") && strings.TrimSpace(stringArg(args, "key")) == "" {
				return fmt.Errorf("action=%s requires a key", action)
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_visual_diff %s", browserTestingSWOnly)
		},
	}
}
