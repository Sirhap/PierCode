package tool

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func NewBrowserWaitTool() Tool {
	return &browserTool{
		name:        "browser_wait",
		readOnly:    true,
		description: "Wait for a selector state or document load state in the controlled browser tab.",
		parameters: map[string]string{
			"selector":  "string (optional) - CSS selector to wait for",
			"state":     "string (optional, visible|hidden|attached|detached, default visible)",
			"loadState": "string (optional, domcontentloaded|load) - wait for document ready state",
			"timeout":   "number (optional, default 10, max 60) - seconds",
			"tabId":     "number (optional) - controlled tab id",
		},
		validate: validateBrowserWait,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Wait(ctx.Context, BrowserWaitRequest{
				TabID:          optionalInt(ctx.Args, "tabId"),
				Selector:       stringArg(ctx.Args, "selector"),
				State:          stringArg(ctx.Args, "state"),
				LoadState:      stringArg(ctx.Args, "loadState"),
				TimeoutSeconds: intArgDefault(ctx.Args, "timeout", 10),
			})
		},
	}
}

func NewBrowserWaitForFunctionTool() Tool {
	return &browserTool{
		name:        "browser_wait_for_function",
		readOnly:    true,
		description: "Wait until a JavaScript expression returns a truthy value in the controlled browser tab.",
		parameters: map[string]string{
			"expression": "string (required, max 10000 chars) - JS expression evaluated until truthy",
			"timeout":    "number (optional, default 10, max 60) - seconds",
			"polling":    "string (optional, rAF|mutation, accepted for compatibility; uses timer polling)",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			expr := stringArg(args, "expression")
			if expr == "" {
				return fmt.Errorf("expression is required")
			}
			if len(expr) > 10000 {
				return fmt.Errorf("expression exceeds 10000 characters")
			}
			polling := strings.ToLower(stringArg(args, "polling"))
			if polling != "" && polling != "raf" && polling != "rAF" && polling != "mutation" {
				return fmt.Errorf("polling must be rAF or mutation")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.WaitForFunction(ctx.Context, BrowserWaitForFunctionRequest{
				TabID:          optionalInt(ctx.Args, "tabId"),
				Expression:     stringArg(ctx.Args, "expression"),
				TimeoutSeconds: intArgDefault(ctx.Args, "timeout", 10),
				Polling:        stringArg(ctx.Args, "polling"),
			})
		},
	}
}

func NewBrowserHoverTool() Tool {
	return &browserTool{
		name:        "browser_hover",
		description: "Hover over a browser page target by snapshot ref, selector, or coordinates after user approval.",
		parameters: map[string]string{
			"ref":            "string (optional) - e.g. e0 from browser_snapshot",
			"snapshotId":     "string (required with ref) - snapshot id from browser_snapshot",
			"selector":       "string (optional) - CSS selector fallback",
			"x":              "number (optional) - x coordinate fallback",
			"y":              "number (optional) - y coordinate fallback",
			"waitAfterHover": "number (optional, default 0, max 5000) - milliseconds to wait after hover",
			"tabId":          "number (optional) - controlled tab id",
		},
		validate: validateClickTarget,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Hover(ctx.Context, BrowserHoverRequest{
				TabID:            optionalInt(ctx.Args, "tabId"),
				Ref:              stringArg(ctx.Args, "ref"),
				Selector:         stringArg(ctx.Args, "selector"),
				X:                optionalFloat(ctx.Args, "x"),
				Y:                optionalFloat(ctx.Args, "y"),
				SnapshotID:       stringArg(ctx.Args, "snapshotId"),
				WaitAfterHoverMS: intArgDefault(ctx.Args, "waitAfterHover", 0),
				CallID:           stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserScrollTool() Tool {
	return &browserTool{
		name:        "browser_scroll",
		description: "Scroll the controlled browser tab by direction or scroll a target into view.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector to scroll into view",
			"direction":  "string (optional, up|down|left|right, default down)",
			"amount":     "number (optional, default 500) - scroll pixels",
			"method":     "string (optional, auto|scrollBy|mouseWheel, default auto)",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: validateBrowserScroll,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Scroll(ctx.Context, BrowserScrollRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Direction:  stringArg(ctx.Args, "direction"),
				Amount:     intArgDefault(ctx.Args, "amount", 500),
				Method:     stringArg(ctx.Args, "method"),
			})
		},
	}
}

func NewBrowserEvaluateTool() Tool {
	return &browserTool{
		name:        "browser_evaluate",
		description: "Evaluate a JavaScript expression in the controlled browser tab after user approval.",
		parameters: map[string]string{
			"expression":    "string (required, max 10000 chars) - JS expression",
			"returnByValue": "boolean (optional, default true) - serialize result by value",
			"tabId":         "number (optional) - controlled tab id",
			"timeoutMs":     "number (optional, default 10000) - max time to wait for async evaluation",
		},
		validate: func(args map[string]interface{}) error {
			expr := stringArg(args, "expression")
			if expr == "" {
				return fmt.Errorf("expression is required")
			}
			if len(expr) > 10000 {
				return fmt.Errorf("expression exceeds 10000 characters")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			resp, err := ctx.Browser.Evaluate(ctx.Context, BrowserEvaluateRequest{
				TabID:         optionalInt(ctx.Args, "tabId"),
				Expression:    stringArg(ctx.Args, "expression"),
				ReturnByValue: !hasBoolArg(ctx.Args, "returnByValue") || boolArg(ctx.Args, "returnByValue"),
				CallID:        stringArg(ctx.Args, "call_id"),
				TimeoutMS:     intArgDefault(ctx.Args, "timeoutMs", 0),
			})
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("evaluated in tabId=%d type=%s value=%s", resp.Tab.TabID, resp.Type, resp.Value), nil
		},
	}
}

func NewBrowserGetContentTool() Tool {
	return &browserTool{
		name:        "browser_get_content",
		readOnly:    true,
		description: "Extract text, HTML, or structured page content from the controlled browser tab.",
		parameters: map[string]string{
			"format":   "string (optional, text|html|structured, default text)",
			"selector": "string (optional) - restrict extraction to a CSS selector",
			"tabId":    "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			format := strings.ToLower(stringArg(args, "format"))
			if format != "" && format != "text" && format != "html" && format != "structured" {
				return fmt.Errorf("format must be text, html, or structured")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.GetContent(ctx.Context, BrowserGetContentRequest{
				TabID:    optionalInt(ctx.Args, "tabId"),
				Format:   stringArg(ctx.Args, "format"),
				Selector: stringArg(ctx.Args, "selector"),
			})
		},
	}
}

func NewBrowserSelectTool() Tool {
	return &browserTool{
		name:        "browser_select",
		description: "Select an option in a browser <select> element after user approval. Supports selection by value, label (visible text), or index.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"value":      "string (required) - option value, label text, or index to select",
			"by":         "string (optional, value|label|index, default value) - how to match the option",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if stringArg(args, "value") == "" {
				return fmt.Errorf("value is required")
			}
			by := strings.ToLower(stringArg(args, "by"))
			if by != "" && by != "value" && by != "label" && by != "index" {
				return fmt.Errorf("by must be value, label, or index")
			}
			return validateElementTarget(args)
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Select(ctx.Context, BrowserSelectRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Value:      stringArg(ctx.Args, "value"),
				By:         stringArg(ctx.Args, "by"),
				CallID:     stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserGoBackTool() Tool {
	return &browserTool{
		name:        "browser_go_back",
		description: "Navigate the controlled browser tab one history entry back.",
		parameters: map[string]string{
			"tabId": "number (optional) - controlled tab id",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			tab, err := ctx.Browser.GoBack(ctx.Context, optionalInt(ctx.Args, "tabId"), stringArg(ctx.Args, "call_id"))
			if err != nil {
				return "", err
			}
			return formatTab("went back", tab), nil
		},
	}
}

func NewBrowserGoForwardTool() Tool {
	return &browserTool{
		name:        "browser_go_forward",
		description: "Navigate the controlled browser tab one history entry forward.",
		parameters: map[string]string{
			"tabId": "number (optional) - controlled tab id",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			tab, err := ctx.Browser.GoForward(ctx.Context, optionalInt(ctx.Args, "tabId"), stringArg(ctx.Args, "call_id"))
			if err != nil {
				return "", err
			}
			return formatTab("went forward", tab), nil
		},
	}
}

func NewBrowserReloadTool() Tool {
	return &browserTool{
		name:        "browser_reload",
		description: "Reload the controlled browser tab.",
		parameters: map[string]string{
			"ignoreCache": "boolean (optional, default false) - bypass cache",
			"tabId":       "number (optional) - controlled tab id",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			tab, err := ctx.Browser.Reload(ctx.Context, BrowserReloadRequest{
				TabID:       optionalInt(ctx.Args, "tabId"),
				IgnoreCache: boolArg(ctx.Args, "ignoreCache"),
			})
			if err != nil {
				return "", err
			}
			return formatTab("reloaded", tab), nil
		},
	}
}

func NewBrowserFocusTool() Tool {
	return &browserTool{
		name:        "browser_focus",
		description: "Focus a browser page element by snapshot ref or selector.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: validateElementTarget,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Focus(ctx.Context, BrowserFocusRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
			})
		},
	}
}

func NewBrowserPressKeyTool() Tool {
	return &browserTool{
		name:        "browser_press_key",
		description: "Press a key or shortcut in the controlled browser tab after user approval.",
		parameters: map[string]string{
			"key":   "string (required) - key or shortcut, e.g. Enter, Escape, Ctrl+S",
			"tabId": "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if stringArg(args, "key") == "" {
				return fmt.Errorf("key is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.PressKey(ctx.Context, BrowserPressKeyRequest{
				TabID:  optionalInt(ctx.Args, "tabId"),
				Key:    stringArg(ctx.Args, "key"),
				CallID: stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserDragTool() Tool {
	return &browserTool{
		name:        "browser_drag",
		description: "Drag from one browser page target or coordinate to another after user approval.",
		parameters: map[string]string{
			"fromRef":      "string (optional) - drag source ref from browser_snapshot",
			"fromSelector": "string (optional) - drag source CSS selector",
			"fromX":        "number (optional) - drag source x coordinate",
			"fromY":        "number (optional) - drag source y coordinate",
			"toRef":        "string (optional) - drop target ref from browser_snapshot",
			"toSelector":   "string (optional) - drop target CSS selector",
			"toX":          "number (optional) - drop target x coordinate",
			"toY":          "number (optional) - drop target y coordinate",
			"snapshotId":   "string (required with refs) - snapshot id from browser_snapshot",
			"mode":         "string (optional, default html5) - 'html5' fires dragstart/dragover/drop events for DnD libraries (react-dnd, SortableJS); 'mouse' sends raw mouse drag for native pointer UIs (canvas, sliders, map panning)",
			"tabId":        "number (optional) - controlled tab id",
		},
		validate: validateBrowserDrag,
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.Drag(ctx.Context, BrowserDragRequest{
				TabID:        optionalInt(ctx.Args, "tabId"),
				FromRef:      stringArg(ctx.Args, "fromRef"),
				FromSelector: stringArg(ctx.Args, "fromSelector"),
				FromX:        optionalFloat(ctx.Args, "fromX"),
				FromY:        optionalFloat(ctx.Args, "fromY"),
				ToRef:        stringArg(ctx.Args, "toRef"),
				ToSelector:   stringArg(ctx.Args, "toSelector"),
				ToX:          optionalFloat(ctx.Args, "toX"),
				ToY:          optionalFloat(ctx.Args, "toY"),
				SnapshotID:   stringArg(ctx.Args, "snapshotId"),
				Mode:         stringArg(ctx.Args, "mode"),
				CallID:       stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserPDFTool() Tool {
	return &browserTool{
		name:        "browser_pdf",
		readOnly:    true,
		description: "Print the controlled browser tab to a PDF file under the workspace.",
		parameters: map[string]string{
			"outputPath": "string (optional) - absolute path under workspace or ~/.claude/.piercode/.agent; defaults to .piercode/pdfs",
			"format":     "string (optional, default A4) - PDF paper format",
			"landscape":  "boolean (optional, default false)",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			outputPath := stringArg(ctx.Args, "outputPath")
			if outputPath == "" {
				outputPath = filepath.Join(ctx.EffectiveRootDir(), ".piercode", "pdfs")
			} else {
				var err error
				outputPath, err = ctx.ResolvePath(outputPath)
				if err != nil {
					return "", err
				}
			}
			pdf, err := ctx.Browser.PDF(ctx.Context, BrowserPDFRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				OutputPath: outputPath,
				Format:     stringArg(ctx.Args, "format"),
				Landscape:  boolArg(ctx.Args, "landscape"),
			})
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("pdf tabId=%d title=%q url=%q bytes=%d\nSaved to: %s", pdf.Tab.TabID, pdf.Tab.SafeTitle(), pdf.Tab.URL, pdf.Bytes, pdf.FilePath), nil
		},
	}
}

func NewBrowserUploadTool() Tool {
	return &browserTool{
		name:        "browser_upload",
		description: "Attach one or more local files to a browser <input type=file> after user approval.",
		parameters: map[string]string{
			"ref":        "string (optional) - target file input ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback for the file input",
			"paths":      "array (required) - local file paths under workspace, ~/.claude, ~/.piercode, or ~/.agent",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: validateBrowserUpload,
		execute: func(ctx *Context) (string, error) {
			paths, err := resolveUploadPaths(ctx, ctx.Args)
			if err != nil {
				return "", err
			}
			return ctx.Browser.Upload(ctx.Context, BrowserUploadRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Paths:      paths,
				CallID:     stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserHandleDialogTool() Tool {
	return &browserTool{
		name:        "browser_handle_dialog",
		description: "Accept or dismiss the next JavaScript alert/confirm/prompt dialog after user approval.",
		parameters: map[string]string{
			"action":     "string (required, accept|dismiss)",
			"promptText": "string (optional) - text for prompt dialogs",
			"timeout":    "number (optional, default 5, max 60) - seconds to wait for a dialog",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			action := strings.ToLower(stringArg(args, "action"))
			if action != "accept" && action != "dismiss" {
				return fmt.Errorf("action must be accept or dismiss")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.HandleDialog(ctx.Context, BrowserHandleDialogRequest{
				TabID:          optionalInt(ctx.Args, "tabId"),
				Action:         stringArg(ctx.Args, "action"),
				PromptText:     stringArg(ctx.Args, "promptText"),
				TimeoutSeconds: intArgDefault(ctx.Args, "timeout", 5),
				CallID:         stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func validateBrowserWait(args map[string]interface{}) error {
	selector := stringArg(args, "selector")
	loadState := stringArg(args, "loadState")
	if (selector == "" && loadState == "") || (selector != "" && loadState != "") {
		return fmt.Errorf("provide exactly one wait target: selector or loadState")
	}
	state := strings.ToLower(stringArg(args, "state"))
	if state != "" && state != "visible" && state != "hidden" && state != "attached" && state != "detached" {
		return fmt.Errorf("state must be visible, hidden, attached, or detached")
	}
	loadState = strings.ToLower(loadState)
	if loadState != "" && loadState != "domcontentloaded" && loadState != "load" {
		return fmt.Errorf("loadState must be domcontentloaded or load")
	}
	return nil
}

func validateBrowserScroll(args map[string]interface{}) error {
	ref := stringArg(args, "ref")
	selector := stringArg(args, "selector")
	if ref != "" && selector != "" {
		return fmt.Errorf("provide at most one target: ref or selector")
	}
	if ref != "" && stringArg(args, "snapshotId") == "" {
		return fmt.Errorf("snapshotId is required when using ref")
	}
	direction := strings.ToLower(stringArg(args, "direction"))
	if direction != "" && direction != "up" && direction != "down" && direction != "left" && direction != "right" {
		return fmt.Errorf("direction must be up, down, left, or right")
	}
	method := strings.ToLower(stringArg(args, "method"))
	if method != "" && method != "auto" && method != "scrollby" && method != "mousewheel" {
		return fmt.Errorf("method must be auto, scrollBy, or mouseWheel")
	}
	return nil
}

func validateElementTarget(args map[string]interface{}) error {
	ref := stringArg(args, "ref")
	selector := stringArg(args, "selector")
	if (ref == "" && selector == "") || (ref != "" && selector != "") {
		return fmt.Errorf("provide exactly one target: ref or selector")
	}
	if ref != "" && stringArg(args, "snapshotId") == "" {
		return fmt.Errorf("snapshotId is required when using ref")
	}
	return nil
}

func validateBrowserDrag(args map[string]interface{}) error {
	if err := validateDragEndpoint(args, "from"); err != nil {
		return err
	}
	if err := validateDragEndpoint(args, "to"); err != nil {
		return err
	}
	if (stringArg(args, "fromRef") != "" || stringArg(args, "toRef") != "") && stringArg(args, "snapshotId") == "" {
		return fmt.Errorf("snapshotId is required when using refs")
	}
	return nil
}

func validateBrowserUpload(args map[string]interface{}) error {
	if err := validateElementTarget(args); err != nil {
		return err
	}
	paths := stringListArg(args, "paths")
	if len(paths) == 0 {
		return fmt.Errorf("paths is required")
	}
	if len(paths) > 20 {
		return fmt.Errorf("paths may contain at most 20 files")
	}
	return nil
}

func validateDragEndpoint(args map[string]interface{}, prefix string) error {
	ref := stringArg(args, prefix+"Ref")
	selector := stringArg(args, prefix+"Selector")
	hasX := optionalFloat(args, prefix+"X") != nil
	hasY := optionalFloat(args, prefix+"Y") != nil
	count := 0
	if ref != "" {
		count++
	}
	if selector != "" {
		count++
	}
	if hasX || hasY {
		if !(hasX && hasY) {
			return fmt.Errorf("both %sX and %sY are required for coordinate drag endpoints", prefix, prefix)
		}
		count++
	}
	if count != 1 {
		return fmt.Errorf("provide exactly one %s target: %sRef, %sSelector, or %sX/%sY", prefix, prefix, prefix, prefix, prefix)
	}
	return nil
}

func resolveUploadPaths(ctx *Context, args map[string]interface{}) ([]string, error) {
	paths := stringListArg(args, "paths")
	if len(paths) == 0 {
		return nil, fmt.Errorf("paths is required")
	}
	resolved := make([]string, 0, len(paths))
	for _, path := range paths {
		safePath, err := ctx.ResolvePath(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(safePath)
		if err != nil {
			return nil, fmt.Errorf("upload file is not readable: %s: %w", safePath, err)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("upload path is a directory: %s", safePath)
		}
		resolved = append(resolved, safePath)
	}
	return resolved, nil
}

func stringListArg(args map[string]interface{}, key string) []string {
	if args == nil {
		return nil
	}
	raw, ok := args[key]
	if !ok || raw == nil {
		return nil
	}
	switch values := raw.(type) {
	case []string:
		out := make([]string, 0, len(values))
		for _, value := range values {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out
	case []interface{}:
		out := make([]string, 0, len(values))
		for _, value := range values {
			s, ok := value.(string)
			if !ok {
				continue
			}
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		return out
	default:
		return nil
	}
}

func hasBoolArg(args map[string]interface{}, key string) bool {
	if args == nil {
		return false
	}
	_, ok := args[key].(bool)
	return ok
}
