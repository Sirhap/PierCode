package tool

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// TaskOutputTool fetches the stdout/stderr captured so far for a background
// task plus its current status. Read-only.
type TaskOutputTool struct{}

func NewTaskOutputTool() *TaskOutputTool { return &TaskOutputTool{} }

func (t *TaskOutputTool) Name() string { return "task_output" }
func (t *TaskOutputTool) Description() string {
	return "Read captured stdout/stderr and status of a background task"
}
func (t *TaskOutputTool) Parameters() interface{} {
	return map[string]string{
		"task_id": "string (required) - id returned by exec_cmd with background:true",
		"stream":  "string (optional) - stdout | stderr | both (default both)",
	}
}
func (t *TaskOutputTool) Validate(args map[string]interface{}) error {
	id, ok := args["task_id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return errors.New("task_id is required")
	}
	return nil
}

func (t *TaskOutputTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	if ctx.TaskRunner == nil {
		result.Status = "error"
		result.Error = "background tasks unavailable in this invocation"
		return result
	}

	id, _ := ctx.Args["task_id"].(string)
	id = strings.TrimSpace(id)

	snap, stdout, stderr, ok := ctx.TaskRunner.GetSnapshot(id)
	if !ok {
		result.Status = "error"
		result.Error = fmt.Sprintf("task %s not found", id)
		return result
	}

	which, _ := ctx.Args["stream"].(string)
	which = strings.ToLower(strings.TrimSpace(which))

	var b strings.Builder
	fmt.Fprintf(&b, "task %s [%s] exit=%d\n", snap.ID, snap.Status, snap.ExitCode)
	fmt.Fprintf(&b, "command: %s\n", snap.Command)
	if snap.ErrMsg != "" {
		fmt.Fprintf(&b, "error: %s\n", snap.ErrMsg)
	}
	b.WriteString("\n")

	switch which {
	case "stdout":
		writeStreamSection(&b, "stdout", stdout)
	case "stderr":
		writeStreamSection(&b, "stderr", stderr)
	default:
		writeStreamSection(&b, "stdout", stdout)
		b.WriteString("\n")
		writeStreamSection(&b, "stderr", stderr)
	}

	result.Status = "success"
	result.Output = b.String()
	return result
}

func writeStreamSection(b *strings.Builder, name, content string) {
	trimmed, _ := Truncate(content)
	fmt.Fprintf(b, "--- %s ---\n", name)
	if strings.TrimSpace(trimmed) == "" {
		b.WriteString("(empty)\n")
		return
	}
	b.WriteString(trimmed)
	if !strings.HasSuffix(trimmed, "\n") {
		b.WriteString("\n")
	}
}
