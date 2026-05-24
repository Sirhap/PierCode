package tool

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

type browserTool struct {
	name        string
	description string
	parameters  map[string]string
	validate    func(map[string]interface{}) error
	execute     func(*Context) (string, error)
}

func (t *browserTool) Name() string                               { return t.name }
func (t *browserTool) Description() string                        { return t.description }
func (t *browserTool) Parameters() interface{}                    { return t.parameters }
func (t *browserTool) Validate(args map[string]interface{}) error { return t.validate(args) }
func (t *browserTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	if ctx.Browser == nil {
		result.Status = "error"
		result.Error = "browser relay is not configured"
		return result
	}
	out, err := t.execute(ctx)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = out
	return result
}

func NewBrowserTabsTool() Tool {
	return &browserTool{
		name:        "browser_tabs",
		description: "List browser tabs available to PierCode and show which tab is currently controlled",
		parameters: map[string]string{
			"includeAiPages": "boolean (optional, default false) - include AI conversation pages in the listing",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			tabs, err := ctx.Browser.ListTabs(ctx.Context, boolArg(ctx.Args, "includeAiPages"))
			if err != nil {
				return "", err
			}
			if len(tabs) == 0 {
				return "No browser tabs are available. Open Chrome or create one with browser_new_tab.", nil
			}
			var controlled, other []string
			for _, tab := range tabs {
				line := fmt.Sprintf("- tabId=%d title=%q url=%q controlled=%v", tab.TabID, tab.Title, tab.URL, tab.Controlled)
				if tab.Controlled {
					controlled = append(controlled, line)
				} else {
					other = append(other, line)
				}
			}
			var b strings.Builder
			b.WriteString("受控 tab:\n")
			if len(controlled) == 0 {
				b.WriteString("- (none)\n")
			} else {
				b.WriteString(strings.Join(controlled, "\n"))
				b.WriteByte('\n')
			}
			if len(other) > 0 {
				b.WriteString("\n其他可选 tab:\n")
				b.WriteString(strings.Join(other, "\n"))
			}
			return strings.TrimSpace(b.String()), nil
		},
	}
}

func NewBrowserNewTabTool() Tool {
	return &browserTool{
		name:        "browser_new_tab",
		description: "Create a new background tab controlled by PierCode. Use this before browser_navigate/snapshot when no controlled tab exists.",
		parameters: map[string]string{
			"url": "string (optional, default about:blank) - initial http/https URL or about:blank",
		},
		validate: func(args map[string]interface{}) error {
			if v, ok := args["url"]; ok && v != nil {
				if _, ok := v.(string); !ok {
					return fmt.Errorf("url must be a string")
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			tab, err := ctx.Browser.NewTab(ctx.Context, stringArg(ctx.Args, "url"))
			if err != nil {
				return "", err
			}
			return formatTab("created controlled tab", tab), nil
		},
	}
}

func NewBrowserUseTabTool() Tool {
	return &browserTool{
		name:        "browser_use_tab",
		description: "Select an existing browser tab as the PierCode controlled tab after user approval",
		parameters: map[string]string{
			"tabId":  "number (required) - Chrome tab id from browser_tabs",
			"reason": "string (optional) - why this tab should be controlled",
		},
		validate: func(args map[string]interface{}) error {
			if _, ok := numberArg(args, "tabId"); !ok {
				return fmt.Errorf("tabId is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			id, _ := numberArg(ctx.Args, "tabId")
			tab, err := ctx.Browser.UseTab(ctx.Context, int(id), stringArg(ctx.Args, "reason"), stringArg(ctx.Args, "call_id"))
			if err != nil {
				return "", err
			}
			return formatTab("selected controlled tab", tab), nil
		},
	}
}

func NewBrowserNavigateTool() Tool {
	return &browserTool{
		name:        "browser_navigate",
		description: "Navigate the controlled browser tab to an http/https URL. Creates a safe controlled tab if needed.",
		parameters: map[string]string{
			"url":   "string (required) - http/https URL or about:blank",
			"tabId": "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if strings.TrimSpace(stringArg(args, "url")) == "" {
				return fmt.Errorf("url is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			tabID := optionalInt(ctx.Args, "tabId")
			tab, err := ctx.Browser.Navigate(ctx.Context, tabID, stringArg(ctx.Args, "url"), stringArg(ctx.Args, "call_id"))
			if err != nil {
				return "", err
			}
			return formatTab("navigated controlled tab", tab), nil
		},
	}
}

func NewBrowserSnapshotTool() Tool {
	return &browserTool{
		name:        "browser_snapshot",
		description: "Get a compact accessibility tree snapshot of the controlled page with e0/e1 refs for later browser_click/browser_type",
		parameters: map[string]string{
			"tabId":    "number (optional) - controlled tab id",
			"maxNodes": "number (optional, default 200) - maximum compact nodes to return",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			snapshot, err := ctx.Browser.Snapshot(ctx.Context, optionalInt(ctx.Args, "tabId"), intArgDefault(ctx.Args, "maxNodes", 200))
			if err != nil {
				return "", err
			}
			suffix := fmt.Sprintf("\n\nnodeCount=%d refCount=%d", snapshot.NodeCount, snapshot.RefCount)
			if snapshot.Truncated {
				suffix += " truncated=true"
			}
			return snapshot.Text + suffix, nil
		},
	}
}

func NewBrowserClickTool() Tool {
	return &browserTool{
		name:        "browser_click",
		description: "Click a browser page target by snapshot ref, selector, or coordinates after user approval",
		parameters: map[string]string{
			"ref":        "string (optional) - e.g. e0 from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"x":          "number (optional) - x coordinate fallback",
			"y":          "number (optional) - y coordinate fallback",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: validateClickTarget,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Click(ctx.Context, BrowserClickRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				X:          optionalFloat(ctx.Args, "x"),
				Y:          optionalFloat(ctx.Args, "y"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				CallID:     stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserTypeTool() Tool {
	return &browserTool{
		name:        "browser_type",
		description: "Type text into a browser page input by snapshot ref or selector after user approval",
		parameters: map[string]string{
			"text":       "string (required) - text to type",
			"ref":        "string (optional) - e.g. e0 from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"clear":      "boolean (optional, default false) - clear existing input first",
			"submit":     "boolean (optional, default false) - press Enter after typing",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if stringArg(args, "text") == "" {
				return fmt.Errorf("text is required")
			}
			ref := stringArg(args, "ref")
			selector := stringArg(args, "selector")
			if (ref == "" && selector == "") || (ref != "" && selector != "") {
				return fmt.Errorf("provide exactly one target: ref or selector")
			}
			if ref != "" && stringArg(args, "snapshotId") == "" {
				return fmt.Errorf("snapshotId is required when using ref")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Type(ctx.Context, BrowserTypeRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Text:       stringArg(ctx.Args, "text"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Clear:      boolArg(ctx.Args, "clear"),
				Submit:     boolArg(ctx.Args, "submit"),
				CallID:     stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserScreenshotTool() Tool {
	return &browserTool{
		name:        "browser_screenshot",
		description: "Capture a screenshot of the controlled browser tab and save it under .piercode/screenshots.",
		parameters: map[string]string{
			"tabId":    "number (optional) - controlled tab id",
			"format":   "string (optional, jpeg|png, default jpeg)",
			"quality":  "number (optional, default 70) - jpeg quality",
			"fullPage": "boolean (optional, default false) - capture beyond viewport",
		},
		validate: func(args map[string]interface{}) error {
			format := strings.ToLower(stringArg(args, "format"))
			if format != "" && format != "jpeg" && format != "png" {
				return fmt.Errorf("format must be jpeg or png")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			shot, err := ctx.Browser.Screenshot(ctx.Context, BrowserScreenshotRequest{
				TabID:     optionalInt(ctx.Args, "tabId"),
				Format:    stringArg(ctx.Args, "format"),
				Quality:   intArgDefault(ctx.Args, "quality", 70),
				FullPage:  boolArg(ctx.Args, "fullPage"),
				OutputDir: filepath.Join(ctx.EffectiveRootDir(), ".piercode", "screenshots"),
			})
			if err != nil {
				return "", err
			}
			out := fmt.Sprintf("screenshot tabId=%d title=%q url=%q format=%s bytes=%d", shot.Tab.TabID, shot.Tab.Title, shot.Tab.URL, shot.Format, shot.Bytes)
			if shot.FilePath != "" {
				out += "\nSaved to: " + shot.FilePath
				out += "\nThe screenshot is saved as an image file; do not paste it inline."
			}
			return out, nil
		},
	}
}

func validateClickTarget(args map[string]interface{}) error {
	ref := stringArg(args, "ref")
	selector := stringArg(args, "selector")
	hasX := optionalFloat(args, "x") != nil
	hasY := optionalFloat(args, "y") != nil
	count := 0
	if ref != "" {
		count++
	}
	if selector != "" {
		count++
	}
	if hasX || hasY {
		if !(hasX && hasY) {
			return fmt.Errorf("both x and y are required for coordinate clicks")
		}
		count++
	}
	if count != 1 {
		return fmt.Errorf("provide exactly one target: ref, selector, or x/y")
	}
	if ref != "" && stringArg(args, "snapshotId") == "" {
		return fmt.Errorf("snapshotId is required when using ref")
	}
	return nil
}

func formatTab(prefix string, tab BrowserTab) string {
	return fmt.Sprintf("%s: tabId=%d title=%q url=%q controlled=%v", prefix, tab.TabID, tab.Title, tab.URL, tab.Controlled)
}

func stringArg(args map[string]interface{}, key string) string {
	if args == nil {
		return ""
	}
	if v, ok := args[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func boolArg(args map[string]interface{}, key string) bool {
	if args == nil {
		return false
	}
	v, _ := args[key].(bool)
	return v
}

func numberArg(args map[string]interface{}, key string) (float64, bool) {
	if args == nil {
		return 0, false
	}
	switch v := args[key].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case jsonNumber:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func optionalInt(args map[string]interface{}, key string) *int {
	n, ok := numberArg(args, key)
	if !ok || n <= 0 {
		return nil
	}
	i := int(n)
	return &i
}

func optionalFloat(args map[string]interface{}, key string) *float64 {
	n, ok := numberArg(args, key)
	if !ok {
		return nil
	}
	return &n
}

func intArgDefault(args map[string]interface{}, key string, fallback int) int {
	n, ok := numberArg(args, key)
	if !ok || n <= 0 {
		return fallback
	}
	return int(n)
}
