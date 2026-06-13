package tool

import (
	"encoding/json"
	"fmt"
	"strings"
)

// NewBrowserBatchTool returns the browser_batch meta-tool. Each PierCode tool
// call costs a full web-chat round trip (detect fence -> approve -> execute ->
// paste -> regenerate), so batching a predictable sequence of browser steps into
// one call is high leverage. The batch runs its actions sequentially, stops on
// the first error, and re-dispatches each item through the executor's full
// validate -> approve -> execute pipeline (so per-item gating still applies).
func NewBrowserBatchTool() Tool {
	return &browserTool{
		name:        "browser_batch",
		readOnly:    false,
		description: "Run a sequence of browser_* tool calls in ONE round trip. Use whenever you can predict 2+ browser steps ahead (e.g. click a field, type, click submit). Actions run in order and STOP at the first failure. Each action is {name, input}; name must be a browser_* tool (not browser_batch — no nesting). Coordinates/refs in later actions should come from a snapshot taken BEFORE the batch, since the page is not re-observed between actions.",
		parameters: map[string]string{
			"actions": "array (required) - list of {name: \"browser_click\", input: {ref: \"e3\", ...}} objects, executed in order, stop-on-first-error",
			"tabId":   "number (optional) - default tab id applied to actions that omit their own tabId",
		},
		validate: func(args map[string]interface{}) error {
			actions, err := parseBatchActions(args)
			if err != nil {
				return err
			}
			if len(actions) == 0 {
				return fmt.Errorf("actions must be a non-empty array")
			}
			if len(actions) > 25 {
				return fmt.Errorf("a batch may contain at most 25 actions")
			}
			for i, a := range actions {
				if a.Name == "" {
					return fmt.Errorf("action %d: missing name", i)
				}
				if !isBrowserToolNameStr(a.Name) {
					return fmt.Errorf("action %d: %q is not a browser_* tool; only browser_* tools may run in a batch", i, a.Name)
				}
				if a.Name == "browser_batch" {
					return fmt.Errorf("action %d: browser_batch cannot be nested", i)
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			if ctx.Dispatch == nil {
				return "", fmt.Errorf("browser_batch is not supported in this context (no dispatcher)")
			}
			actions, err := parseBatchActions(ctx.Args)
			if err != nil {
				return "", err
			}
			defaultTab, hasDefaultTab := batchDefaultTab(ctx.Args)

			var sb strings.Builder
			fmt.Fprintf(&sb, "browser_batch: %d actions\n", len(actions))
			for i, a := range actions {
				input := a.Input
				if input == nil {
					input = map[string]interface{}{}
				}
				// Apply the batch-level default tabId to actions that omit one, so
				// every step targets the same tab without repeating it.
				if hasDefaultTab {
					if _, present := input["tabId"]; !present {
						input["tabId"] = defaultTab
					}
				}
				res := ctx.Dispatch(a.Name, input)
				if res.Status == "error" {
					fmt.Fprintf(&sb, "%d. %s → ERROR: %s\n", i+1, a.Name, res.Error)
					fmt.Fprintf(&sb, "\nBatch stopped at action %d of %d (stop-on-first-error). Remaining actions were not run.", i+1, len(actions))
					return sb.String(), nil
				}
				out := strings.TrimSpace(res.Output)
				if len(out) > 500 {
					out = out[:500] + "…"
				}
				fmt.Fprintf(&sb, "%d. %s → %s\n", i+1, a.Name, out)
			}
			fmt.Fprintf(&sb, "\nAll %d actions completed.", len(actions))
			return sb.String(), nil
		},
	}
}

type batchAction struct {
	Name  string                 `json:"name"`
	Input map[string]interface{} `json:"input"`
}

// parseBatchActions reads the "actions" arg, tolerating both a real []any of
// maps (typical JSON decode) and a JSON-string fallback some models emit.
func parseBatchActions(args map[string]interface{}) ([]batchAction, error) {
	raw, ok := args["actions"]
	if !ok {
		return nil, fmt.Errorf("actions is required")
	}
	// Re-marshal then unmarshal into the typed slice — handles []interface{} of
	// map[string]interface{} uniformly.
	var actions []batchAction
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &actions); err != nil {
			return nil, fmt.Errorf("actions string is not valid JSON: %w", err)
		}
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("actions is not a valid array: %w", err)
		}
		if err := json.Unmarshal(b, &actions); err != nil {
			return nil, fmt.Errorf("actions must be an array of {name, input}: %w", err)
		}
	}
	return actions, nil
}

func batchDefaultTab(args map[string]interface{}) (int, bool) {
	switch n := args["tabId"].(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func isBrowserToolNameStr(name string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "browser_")
}
