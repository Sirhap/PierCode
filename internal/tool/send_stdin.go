package tool

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// SendStdinTool writes data to a background task's stdin. Useful for driving
// REPLs, dev servers prompting for input, or interactive shells.
type SendStdinTool struct{}

func NewSendStdinTool() *SendStdinTool { return &SendStdinTool{} }

func (t *SendStdinTool) Name() string { return "send_stdin" }
func (t *SendStdinTool) Description() string {
	return "Write data to a background task's stdin (REPLs, interactive prompts)"
}
func (t *SendStdinTool) Parameters() interface{} {
	return map[string]string{
		"task_id":        "string (required) - id of the running background task",
		"data":           "string (required) - text to write to stdin",
		"append_newline": "boolean (optional, default true) - append a trailing \\n",
	}
}
func (t *SendStdinTool) Validate(args map[string]interface{}) error {
	id, ok := args["task_id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return errors.New("task_id is required")
	}
	if _, ok := args["data"].(string); !ok {
		return errors.New("data is required")
	}
	return nil
}

func (t *SendStdinTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	if ctx.TaskRunner == nil {
		result.Status = "error"
		result.Error = "background tasks unavailable in this invocation"
		return result
	}

	id, _ := ctx.Args["task_id"].(string)
	id = strings.TrimSpace(id)
	data, _ := ctx.Args["data"].(string)

	appendNewline := true
	if v, ok := ctx.Args["append_newline"].(bool); ok {
		appendNewline = v
	}
	if appendNewline && !strings.HasSuffix(data, "\n") {
		data += "\n"
	}

	if err := ctx.TaskRunner.SendStdin(id, data); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = fmt.Sprintf("wrote %d byte(s) to task %s stdin", len(data), id)
	return result
}
