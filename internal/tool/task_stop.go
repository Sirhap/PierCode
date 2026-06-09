package tool

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// TaskStopTool cancels a running background task.
type TaskStopTool struct{}

func NewTaskStopTool() *TaskStopTool { return &TaskStopTool{} }

func (t *TaskStopTool) Name() string { return "task_stop" }
func (t *TaskStopTool) Description() string {
	return "Cancel a running background task by id"
}
func (t *TaskStopTool) Parameters() interface{} {
	return map[string]string{
		"task_id": "string (required) - id returned by exec_cmd with background:true",
	}
}
func (t *TaskStopTool) Validate(args map[string]interface{}) error {
	id, ok := args["task_id"].(string)
	if !ok || strings.TrimSpace(id) == "" {
		return errors.New("task_id is required")
	}
	return nil
}

func (t *TaskStopTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	if ctx.Tasks.Runner == nil {
		result.Status = "error"
		result.Error = "background tasks unavailable in this invocation"
		return result
	}

	id, _ := ctx.Args["task_id"].(string)
	id = strings.TrimSpace(id)

	if err := ctx.Tasks.Runner.Stop(id); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = fmt.Sprintf("stop signal sent to task %s", id)
	return result
}
