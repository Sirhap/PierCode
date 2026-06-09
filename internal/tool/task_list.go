package tool

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// TaskListTool returns a summary of every background task the executor has
// launched in this server session. Read-only.
type TaskListTool struct{}

func NewTaskListTool() *TaskListTool { return &TaskListTool{} }

func (t *TaskListTool) Name() string { return "task_list" }
func (t *TaskListTool) Description() string {
	return "List background tasks started via exec_cmd with background:true"
}
func (t *TaskListTool) Parameters() interface{} {
	return map[string]string{
		"status": "string (optional) - filter by status: running, done, failed, canceled, timed_out",
	}
}
func (t *TaskListTool) Validate(args map[string]interface{}) error { return nil }

func (t *TaskListTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	if ctx.Tasks.Runner == nil {
		result.Status = "error"
		result.Error = "background tasks unavailable in this invocation"
		return result
	}

	filter, _ := ctx.Args["status"].(string)
	filter = strings.ToLower(strings.TrimSpace(filter))

	snaps := ctx.Tasks.Runner.Snapshots()
	if filter != "" {
		filtered := snaps[:0]
		for _, s := range snaps {
			if strings.EqualFold(s.Status, filter) {
				filtered = append(filtered, s)
			}
		}
		snaps = filtered
	}

	// Newest first — bg-<unixnano>-<seq> sorts lexicographically by start time.
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].ID > snaps[j].ID })

	if len(snaps) == 0 {
		result.Status = "success"
		if filter != "" {
			result.Output = fmt.Sprintf("no tasks with status=%s", filter)
		} else {
			result.Output = "no background tasks"
		}
		return result
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%d task(s):\n", len(snaps))
	for _, s := range snaps {
		cmd := s.Command
		if len(cmd) > 80 {
			cmd = cmd[:77] + "..."
		}
		fmt.Fprintf(&b, "\n%s  [%s]  exit=%d  out=%dB err=%dB\n  %s\n  started=%s",
			s.ID, s.Status, s.ExitCode, s.StdoutSize, s.StderrSize, cmd, s.StartedAt)
		if s.EndedAt != "" {
			fmt.Fprintf(&b, "  ended=%s", s.EndedAt)
		}
		if s.ErrMsg != "" {
			fmt.Fprintf(&b, "\n  error: %s", s.ErrMsg)
		}
	}
	result.Status = "success"
	result.Output = b.String()
	return result
}
