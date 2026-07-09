// Deprecated execution path: like the other browser_* definitions (see the
// package note in browser_tools.go), these tools EXECUTE inside the extension
// service worker (extension/src/background/browser/testing.ts). The Go
// definitions exist so the prompt profiles ({{TOOLS}}) advertise them and
// /exec callers get a clear redirect instead of a silent no-op.
package tool

import (
	"fmt"
	"strings"
)

const browserTestingSWOnly = "executes in the PierCode extension service worker; drive it from an AI page / the sidebar browser agent, not the /exec route"

// NewBrowserAssertTool returns browser_assert — a declarative page-state check.
// PASS returns a confirmation string; FAIL is a tool error carrying expected vs
// actual, so scripted tests (browser_test) and the model get a hard signal.
func NewBrowserAssertTool() Tool {
	kinds := []string{
		"url", "title", "element_exists", "element_not_exists", "element_visible",
		"element_text", "element_count", "attribute", "console_clean", "network_ok",
	}
	kindSet := map[string]bool{}
	for _, k := range kinds {
		kindSet[k] = true
	}
	elementKinds := map[string]bool{
		"element_exists": true, "element_not_exists": true, "element_visible": true,
		"element_text": true, "element_count": true, "attribute": true,
	}
	return &browserTool{
		name:        "browser_assert",
		readOnly:    true,
		description: "Verify page state and get PASS/FAIL with expected-vs-actual. kinds: url|title (match current tab), element_exists|element_not_exists|element_visible|element_text|element_count|attribute (CSS selector based), console_clean (no console errors since observation started), network_ok (no >=400 responses since observation started). FAIL comes back as a tool error — use it as the verification step of automated tests.",
		parameters: map[string]string{
			"kind":      "string (required) - " + strings.Join(kinds, "|"),
			"selector":  "string (required for element_* / attribute kinds) - CSS selector; first match is probed",
			"expect":    "string (required for url/title/element_text/attribute) - expected value",
			"match":     "string (optional, contains|equals|regex, default contains) - how expect is compared",
			"count":     "number (required for element_count) - expected match count",
			"op":        "string (optional, =|>=|<=, default =) - comparison for element_count",
			"attribute": "string (required for attribute kind) - attribute name to read",
			"pattern":   "string (optional) - console_clean: only errors matching this regex count; network_ok: only URLs containing this substring count",
			"tabId":     "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			kind := strings.ToLower(stringArg(args, "kind"))
			if !kindSet[kind] {
				return fmt.Errorf("kind must be one of: %s", strings.Join(kinds, ", "))
			}
			if elementKinds[kind] && strings.TrimSpace(stringArg(args, "selector")) == "" {
				return fmt.Errorf("kind=%s requires a selector", kind)
			}
			if kind == "attribute" && strings.TrimSpace(stringArg(args, "attribute")) == "" {
				return fmt.Errorf("kind=attribute requires an attribute name")
			}
			switch kind {
			case "url", "title", "element_text", "attribute":
				if stringArg(args, "expect") == "" {
					return fmt.Errorf("kind=%s requires expect", kind)
				}
			case "element_count":
				if optionalFloat(args, "count") == nil {
					return fmt.Errorf("kind=element_count requires a numeric count")
				}
			}
			if m := stringArg(args, "match"); m != "" && m != "contains" && m != "equals" && m != "regex" {
				return fmt.Errorf("match must be contains, equals, or regex")
			}
			if op := stringArg(args, "op"); op != "" && op != "=" && op != ">=" && op != "<=" {
				return fmt.Errorf("op must be =, >= or <=")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_assert %s", browserTestingSWOnly)
		},
	}
}

// NewBrowserWaitStableTool returns browser_wait_stable — wait until the DOM has
// been mutation-quiet for quietMs (cap timeoutMs). The settle primitive to run
// after actions that trigger rendering, before snapshotting/asserting.
func NewBrowserWaitStableTool() Tool {
	return &browserTool{
		name:        "browser_wait_stable",
		readOnly:    true,
		description: "Wait until the page DOM stops mutating (quiet window). Use after clicks/typing that trigger rendering, before browser_snapshot or browser_assert, to avoid reading a half-rendered page. Resolves with a note (never errors) if the page is still animating at timeout.",
		parameters: map[string]string{
			"quietMs":   "number (optional, default 300, max 2000) - how long the DOM must stay mutation-free",
			"timeoutMs": "number (optional, default 2000, max 10000) - overall cap",
			"tabId":     "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_wait_stable %s", browserTestingSWOnly)
		},
	}
}

// NewBrowserTestTool returns browser_test — a scripted test runner. Steps run in
// order through the same gated dispatch as browser_batch, browser_assert steps
// provide the verification, and the result is a structured TEST REPORT (per-step
// pass/fail + one machine-readable JSON line) with console-tail artifacts on
// failure.
func NewBrowserTestTool() Tool {
	return &browserTool{
		name:        "browser_test",
		readOnly:    false,
		description: "Run a scripted browser test in ONE round trip: {name, steps:[{name, input}]} where each step is a browser_* tool (browser_assert for checks; browser_test itself cannot nest). Steps run in order; by default the run stops at the first failure and later steps are reported as skipped. The page is auto-settled (DOM-quiet) between mutating steps. Returns a TEST REPORT: per-step ✓/✗ with timings, page URL + console tail on failure, and a final machine-readable `JSON: {...}` line.",
		parameters: map[string]string{
			"name":          "string (optional) - test case name shown in the report",
			"steps":         "array (required, max 50) - list of {name: \"browser_click\", input: {...}} steps, executed in order",
			"stopOnFailure": "boolean (optional, default true) - stop at the first failed step",
			"settle":        "boolean (optional, default true) - auto browser_wait_stable between mutating steps",
			"tabId":         "number (optional) - default tab id applied to steps that omit their own",
		},
		validate: func(args map[string]interface{}) error {
			steps, err := parseTestSteps(args)
			if err != nil {
				return err
			}
			if len(steps) == 0 {
				return fmt.Errorf("steps must be a non-empty array")
			}
			if len(steps) > 50 {
				return fmt.Errorf("a test may contain at most 50 steps")
			}
			for i, s := range steps {
				if s.Name == "" {
					return fmt.Errorf("step %d: missing name", i+1)
				}
				if !isBrowserToolNameStr(s.Name) {
					return fmt.Errorf("step %d: %q is not a browser_* tool", i+1, s.Name)
				}
				if s.Name == "browser_test" {
					return fmt.Errorf("step %d: browser_test cannot be nested", i+1)
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return "", fmt.Errorf("browser_test %s", browserTestingSWOnly)
		},
	}
}

// parseTestSteps reads the "steps" arg with the same tolerance as
// parseBatchActions: a real array of {name,input} maps or a JSON-string
// fallback, plus the {tool,args} alias shape some models emit.
func parseTestSteps(args map[string]interface{}) ([]batchAction, error) {
	raw, ok := args["steps"]
	if !ok {
		return nil, fmt.Errorf("steps is required")
	}
	// Reuse the batch action decoding by aliasing: steps share the {name,input}
	// shape. The {tool,args} alias is normalized first.
	normalized := normalizeStepAliases(raw)
	tmp := map[string]interface{}{"actions": normalized}
	steps, err := parseBatchActions(tmp)
	if err != nil {
		return nil, fmt.Errorf("steps must be an array of {name, input}: %w", err)
	}
	return steps, nil
}

// normalizeStepAliases maps {tool, args} entries onto {name, input} so both
// spellings validate identically (mirrors the SW-side parseTestSteps).
func normalizeStepAliases(raw interface{}) interface{} {
	list, ok := raw.([]interface{})
	if !ok {
		return raw
	}
	out := make([]interface{}, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			out = append(out, item)
			continue
		}
		if _, has := m["name"]; !has {
			if tool, has := m["tool"]; has {
				m2 := map[string]interface{}{"name": tool}
				if in, has := m["input"]; has {
					m2["input"] = in
				} else if in, has := m["args"]; has {
					m2["input"] = in
				}
				out = append(out, m2)
				continue
			}
		}
		if _, has := m["input"]; !has {
			if in, has := m["args"]; has {
				m2 := map[string]interface{}{}
				for k, v := range m {
					m2[k] = v
				}
				m2["input"] = in
				out = append(out, m2)
				continue
			}
		}
		out = append(out, m)
	}
	return out
}
