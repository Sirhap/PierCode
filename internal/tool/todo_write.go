package tool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type TodoWriteTool struct {
	config *types.Config
}

func NewTodoWriteTool(config *types.Config) *TodoWriteTool {
	return &TodoWriteTool{config: config}
}

func (t *TodoWriteTool) Name() string { return "todo_write" }
func (t *TodoWriteTool) Description() string {
	return `Create and manage a structured task list for the current session. Pass the FULL list every call — it replaces the stored list.

When to use:
- Tasks with 3+ distinct steps, or non-trivial work needing planning.
- The user provides multiple work items (a numbered or comma-separated list).
- Mark a task in_progress BEFORE starting it; mark it completed IMMEDIATELY after finishing (do not batch completions).

When NOT to use:
- A single straightforward task, or anything completable in under 3 trivial steps. Just do it directly.
- Purely conversational or informational requests.

Each item is an object with:
- content: imperative description of the task (e.g. "Run tests").
- status: one of "pending", "in_progress", "completed".

Rules:
- Keep exactly ONE task in_progress at a time — not zero, not more.
- Only mark completed when FULLY done. If tests fail, the implementation is partial, or you hit an unresolved error, keep it in_progress and add a new task for the blocker.
- Remove tasks that are no longer relevant from the list entirely.`
}
func (t *TodoWriteTool) Parameters() interface{} {
	return map[string]string{
		"todos": "array (required) - full list of todo items to save",
	}
}

func (t *TodoWriteTool) Validate(args map[string]interface{}) error {
	if _, ok := args["todos"]; !ok {
		return errors.New("todos is required")
	}
	return nil
}

func (t *TodoWriteTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	todos := ctx.Args["todos"]
	data, err := json.MarshalIndent(todos, "", "  ")
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	p := filepath.Join(ctx.EffectiveRootDir(), ".todos.json")
	if err := os.WriteFile(p, data, 0644); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	items, _ := todos.([]interface{})
	result.Status = "success"
	result.Output = fmt.Sprintf("已保存 %d 个任务\n\n%s", len(items), formatTodoChecklist(items))
	result.EndTime = time.Now()
	return result
}

// formatTodoChecklist renders the todo array as a human-readable checklist so
// the AI gets a textual confirmation of what it just wrote, instead of having
// to re-read the file. Accepts the same item shapes as JSON.Marshal handles:
// plain strings, or objects with text/content/title + status fields.
func formatTodoChecklist(items []interface{}) string {
	if len(items) == 0 {
		return "(列表为空)"
	}
	var b strings.Builder
	for i, raw := range items {
		text, status := todoFields(raw)
		marker := "[ ]"
		switch strings.ToLower(status) {
		case "completed", "done":
			marker = "[x]"
		case "in_progress", "in-progress", "running":
			marker = "[~]"
		case "blocked":
			marker = "[!]"
		}
		fmt.Fprintf(&b, "%d. %s %s\n", i+1, marker, text)
	}
	return strings.TrimRight(b.String(), "\n")
}

// todoFields extracts a display string and status from a raw todo item.
// Tolerates: string, map[string]interface{} with text/content/title/description
// fields and an optional status field.
func todoFields(raw interface{}) (text, status string) {
	switch v := raw.(type) {
	case string:
		return v, ""
	case map[string]interface{}:
		for _, key := range []string{"text", "content", "title", "description", "name", "task"} {
			if s, ok := v[key].(string); ok && s != "" {
				text = s
				break
			}
		}
		if s, ok := v["status"].(string); ok {
			status = s
		}
		if text == "" {
			// Fall back to a JSON representation so the user still sees
			// something instead of "<unknown>".
			b, _ := json.Marshal(v)
			text = string(b)
		}
		return text, status
	default:
		b, _ := json.Marshal(raw)
		return string(b), ""
	}
}
