package tool

import (
	"fmt"
	"regexp"
	"strings"
)

func NewBrowserFindTool() Tool {
	return &browserTool{
		name:        "browser_find",
		description: "Search page elements by keyword matching against text, aria-label, title, and role. Returns scored results.",
		parameters: map[string]string{
			"query":      "string (required) - keywords to search for",
			"maxResults": "number (optional, default 20) - maximum results to return",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if strings.TrimSpace(stringArg(args, "query")) == "" {
				return fmt.Errorf("query is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			results, err := ctx.Browser.Find(ctx.Context, BrowserFindRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Query:      stringArg(ctx.Args, "query"),
				MaxResults: intArgDefault(ctx.Args, "maxResults", 20),
			})
			if err != nil {
				return "", err
			}
			if len(results) == 0 {
				return "No elements found matching: " + stringArg(ctx.Args, "query"), nil
			}
			var sb strings.Builder
			sb.WriteString(fmt.Sprintf("Found %d matching elements:\n\n", len(results)))
			for i, r := range results {
				sb.WriteString(fmt.Sprintf("%d. [%s] %s - %q (score: %d)\n", i+1, r.Ref, r.Role, r.Text, r.Score))
			}
			return sb.String(), nil
		},
	}
}

func NewBrowserZoomTool() Tool {
	return &browserTool{
		name:        "browser_zoom",
		description: "Capture a screenshot of a specific region of the page for closer inspection.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector of target element",
			"x":          "number (optional) - x coordinate of region top-left",
			"y":          "number (optional) - y coordinate of region top-left",
			"width":      "number (required) - region width in pixels",
			"height":     "number (required) - region height in pixels",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if optionalFloat(args, "width") == nil || optionalFloat(args, "height") == nil {
				return fmt.Errorf("width and height are required")
			}
			ref := stringArg(args, "ref")
			selector := stringArg(args, "selector")
			hasX := optionalFloat(args, "x") != nil
			hasY := optionalFloat(args, "y") != nil
			if ref == "" && selector == "" && !(hasX && hasY) {
				return fmt.Errorf("provide a target: ref+snapshotId, selector, or x+y coordinates")
			}
			if ref != "" && stringArg(args, "snapshotId") == "" {
				return fmt.Errorf("snapshotId is required when using ref")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			resp, err := ctx.Browser.Zoom(ctx.Context, BrowserZoomRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				X:          optionalFloat(ctx.Args, "x"),
				Y:          optionalFloat(ctx.Args, "y"),
				Width:      optionalFloat(ctx.Args, "width"),
				Height:     optionalFloat(ctx.Args, "height"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				CallID:     stringArg(ctx.Args, "call_id"),
			})
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("zoom screenshot saved: %s (%d bytes)", resp.FilePath, resp.Bytes), nil
		},
	}
}

func NewBrowserResizeTool() Tool {
	return &browserTool{
		name:        "browser_resize",
		description: "Resize the browser window to specified dimensions.",
		parameters: map[string]string{
			"width":  "number (required) - window width in pixels (400-7680)",
			"height": "number (required) - window height in pixels (300-4320)",
			"tabId":  "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			w := optionalFloat(args, "width")
			if w == nil {
				return fmt.Errorf("width is required")
			}
			if int(*w) < 400 || int(*w) > 7680 {
				return fmt.Errorf("width must be between 400 and 7680")
			}
			h := optionalFloat(args, "height")
			if h == nil {
				return fmt.Errorf("height is required")
			}
			if int(*h) < 300 || int(*h) > 4320 {
				return fmt.Errorf("height must be between 300 and 4320")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			w := optionalFloat(ctx.Args, "width")
			h := optionalFloat(ctx.Args, "height")
			return ctx.Browser.Resize(ctx.Context, BrowserResizeRequest{
				TabID:  optionalInt(ctx.Args, "tabId"),
				Width:  int(*w),
				Height: int(*h),
			})
		},
	}
}

func NewBrowserFormInputTool() Tool {
	return &browserTool{
		name:        "browser_form_input",
		description: "Set values in form elements including checkbox, radio, and contenteditable. Uses native setter pattern for React compatibility.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"value":      "required - boolean for checkbox, string for others",
			"tabId":      "number (optional) - controlled tab id",
			"call_id":    "string (optional) - call id for approval flow",
		},
		validate: func(args map[string]interface{}) error {
			if _, ok := args["value"]; !ok {
				return fmt.Errorf("value is required")
			}
			return validateElementTarget(args)
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.FormInput(ctx.Context, BrowserFormInputRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Value:      ctx.Args["value"],
				CallID:     stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserConsoleTool() Tool {
	return &browserTool{
		name:        "browser_console",
		description: "Read browser console messages (log, error, warn, etc.) from the controlled tab. Supports pattern filtering.",
		parameters: map[string]string{
			"pattern":    "string (optional) - regex pattern to filter messages",
			"onlyErrors": "boolean (optional, default false) - only return error/exception messages",
			"clear":      "boolean (optional, default false) - clear buffer after reading",
			"limit":      "number (optional, default 100) - max messages to return",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			pattern := stringArg(args, "pattern")
			if pattern != "" {
				if _, err := regexp.Compile(pattern); err != nil {
					return fmt.Errorf("invalid regex pattern: %w", err)
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.ReadConsole(ctx.Context, BrowserConsoleRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Pattern:    stringArg(ctx.Args, "pattern"),
				OnlyErrors: boolArg(ctx.Args, "onlyErrors"),
				Clear:      boolArg(ctx.Args, "clear"),
				Limit:      intArgDefault(ctx.Args, "limit", 100),
			})
		},
	}
}

func NewBrowserNetworkTool() Tool {
	return &browserTool{
		name:        "browser_network",
		description: "Read HTTP network requests from the controlled tab. Supports URL pattern filtering.",
		parameters: map[string]string{
			"urlPattern": "string (optional) - URL substring to filter requests",
			"clear":      "boolean (optional, default false) - clear buffer after reading",
			"limit":      "number (optional, default 100) - max requests to return",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.ReadNetwork(ctx.Context, BrowserNetworkLogRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				URLPattern: stringArg(ctx.Args, "urlPattern"),
				Clear:      boolArg(ctx.Args, "clear"),
				Limit:      intArgDefault(ctx.Args, "limit", 100),
			})
		},
	}
}
