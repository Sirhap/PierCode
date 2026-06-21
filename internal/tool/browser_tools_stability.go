// Deprecated: these browser_* tool definitions are superseded by the extension
// service worker (extension/src/background/browser/*). See the package note in
// browser_tools.go. Commands dispatched here reach no browser.
package tool

import (
	"fmt"
	"strings"
)

func NewBrowserFinalizeTabsTool() Tool {
	return &browserTool{
		name:        "browser_finalize_tabs",
		description: "Release tracked PierCode browser tabs or close tracked PierCode-created tabs after user approval.",
		parameters: map[string]string{
			"closeTabIds":      "array<number> (optional) - tracked tab IDs to close; claimed tabs are skipped unless closeClaimedTabs=true",
			"releaseTabIds":    "array<number> (optional) - tracked tab IDs to release without closing",
			"closeClaimedTabs": "boolean (optional, default false) - allow closing tabs claimed with browser_use_tab",
		},
		validate: func(args map[string]interface{}) error {
			closeIDs := intSliceArg(args, "closeTabIds")
			releaseIDs := intSliceArg(args, "releaseTabIds")
			if len(closeIDs) == 0 && len(releaseIDs) == 0 {
				return fmt.Errorf("provide closeTabIds or releaseTabIds")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			resp, err := ctx.Browser.FinalizeTabs(ctx.Context, BrowserFinalizeTabsRequest{
				CloseTabIDs:      intSliceArg(ctx.Args, "closeTabIds"),
				ReleaseTabIDs:    intSliceArg(ctx.Args, "releaseTabIds"),
				CloseClaimedTabs: boolArg(ctx.Args, "closeClaimedTabs"),
				CallID:           stringArg(ctx.Args, "call_id"),
			})
			if err != nil {
				return "", err
			}
			var parts []string
			parts = append(parts, fmt.Sprintf("closed=%v", resp.Closed))
			parts = append(parts, fmt.Sprintf("released=%v", resp.Released))
			if len(resp.Skipped) > 0 {
				parts = append(parts, "skipped="+strings.Join(resp.Skipped, "; "))
			}
			return "finalized browser tabs: " + strings.Join(parts, " "), nil
		},
	}
}

func NewBrowserViewportTool() Tool {
	return &browserTool{
		name:        "browser_viewport",
		description: "Set or reset a CDP viewport override for responsive browser testing.",
		parameters: map[string]string{
			"width":  "number (required unless reset=true) - viewport width in pixels (320-7680)",
			"height": "number (required unless reset=true) - viewport height in pixels (240-4320)",
			"reset":  "boolean (optional, default false) - clear the viewport override",
			"tabId":  "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if boolArg(args, "reset") {
				return nil
			}
			w := optionalFloat(args, "width")
			if w == nil {
				return fmt.Errorf("width is required unless reset=true")
			}
			if int(*w) < 320 || int(*w) > 7680 {
				return fmt.Errorf("width must be between 320 and 7680")
			}
			h := optionalFloat(args, "height")
			if h == nil {
				return fmt.Errorf("height is required unless reset=true")
			}
			if int(*h) < 240 || int(*h) > 4320 {
				return fmt.Errorf("height must be between 240 and 4320")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			var width, height int
			if w := optionalFloat(ctx.Args, "width"); w != nil {
				width = int(*w)
			}
			if h := optionalFloat(ctx.Args, "height"); h != nil {
				height = int(*h)
			}
			return ctx.Browser.Viewport(ctx.Context, BrowserViewportRequest{
				TabID:  optionalInt(ctx.Args, "tabId"),
				Width:  width,
				Height: height,
				Reset:  boolArg(ctx.Args, "reset"),
			})
		},
	}
}

func NewBrowserDownloadsTool() Tool {
	return &browserTool{
		name:        "browser_downloads",
		description: "List recent browser downloads observed by the PierCode extension.",
		parameters: map[string]string{
			"limit": "number (optional, default 20, max 100) - maximum downloads to return",
			"state": "string (optional, all|in_progress|complete|interrupted, default all) - filter by download state",
		},
		validate: func(args map[string]interface{}) error {
			state := strings.ToLower(stringArg(args, "state"))
			if state != "" && state != "all" && state != "in_progress" && state != "complete" && state != "interrupted" {
				return fmt.Errorf("state must be all, in_progress, complete, or interrupted")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			resp, err := ctx.Browser.Downloads(ctx.Context, BrowserDownloadsRequest{
				Limit: intArgDefault(ctx.Args, "limit", 20),
				State: stringArg(ctx.Args, "state"),
			})
			if err != nil {
				return "", err
			}
			if len(resp.Downloads) == 0 {
				return "No recent downloads recorded.", nil
			}
			var b strings.Builder
			b.WriteString(fmt.Sprintf("Recent downloads: count=%d total=%d truncated=%v\n", resp.Count, resp.Total, resp.Truncated))
			for _, item := range resp.Downloads {
				b.WriteString(fmt.Sprintf("- id=%s state=%s filename=%q url=%q bytes=%d/%d", item.ID, item.State, item.Filename, item.URL, item.BytesReceived, item.TotalBytes))
				if item.Error != "" {
					b.WriteString(" error=" + item.Error)
				}
				if item.StartedAt != "" {
					b.WriteString(" startedAt=" + item.StartedAt)
				}
				if item.EndedAt != "" {
					b.WriteString(" endedAt=" + item.EndedAt)
				}
				b.WriteByte('\n')
			}
			return strings.TrimSpace(b.String()), nil
		},
	}
}

func intSliceArg(args map[string]interface{}, key string) []int {
	if args == nil {
		return nil
	}
	raw, ok := args[key]
	if !ok || raw == nil {
		return nil
	}
	var values []interface{}
	switch typed := raw.(type) {
	case []interface{}:
		values = typed
	case []int:
		values = make([]interface{}, 0, len(typed))
		for _, value := range typed {
			values = append(values, value)
		}
	case []float64:
		values = make([]interface{}, 0, len(typed))
		for _, value := range typed {
			values = append(values, value)
		}
	default:
		return nil
	}
	out := make([]int, 0, len(values))
	for _, value := range values {
		switch v := value.(type) {
		case float64:
			if v > 0 {
				out = append(out, int(v))
			}
		case int:
			if v > 0 {
				out = append(out, v)
			}
		case jsonNumber:
			if f, err := v.Float64(); err == nil && f > 0 {
				out = append(out, int(f))
			}
		}
	}
	return out
}
