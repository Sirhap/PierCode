package tool

import (
	"strings"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

func TestTodoReadTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("returns empty hint when file missing", func(t *testing.T) {
		r := NewTodoReadTool(cfg)
		res := r.Execute(testCtx(cfg, map[string]interface{}{}))
		if res.Status != "success" {
			t.Fatalf("expected success, got %s", res.Status)
		}
		if !strings.Contains(res.Output, "暂无任务") {
			t.Errorf("expected '暂无任务' hint, got %q", res.Output)
		}
	})

	t.Run("formats checklist after write", func(t *testing.T) {
		w := NewTodoWriteTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{
			"todos": []interface{}{
				"plain string task",
				map[string]interface{}{"text": "done thing", "status": "completed"},
				map[string]interface{}{"content": "in flight", "status": "in_progress"},
			},
		}))

		r := NewTodoReadTool(cfg)
		res := r.Execute(testCtx(cfg, map[string]interface{}{}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		if !strings.Contains(res.Output, "[ ] plain string task") {
			t.Errorf("missing pending marker, got %q", res.Output)
		}
		if !strings.Contains(res.Output, "[x] done thing") {
			t.Errorf("missing completed marker, got %q", res.Output)
		}
		if !strings.Contains(res.Output, "[~] in flight") {
			t.Errorf("missing in-progress marker, got %q", res.Output)
		}
	})
}

// fakeTaskRunnerFull implements tool.TaskRunner for the task_* and send_stdin
// tool tests, recording the calls and returning canned data.
type fakeTaskRunnerFull struct {
	snaps        []TaskSnapshot
	getSnap      TaskSnapshot
	getStdout    string
	getStderr    string
	getOK        bool
	stopErr      error
	stdinErr     error
	stdinReceive struct {
		id   string
		data string
	}
	stopReceive string
}

func (f *fakeTaskRunnerFull) Start(spec TaskSpec) (string, error) {
	return "fake-id", nil
}
func (f *fakeTaskRunnerFull) Snapshots() []TaskSnapshot { return f.snaps }
func (f *fakeTaskRunnerFull) GetSnapshot(id string) (TaskSnapshot, string, string, bool) {
	return f.getSnap, f.getStdout, f.getStderr, f.getOK
}
func (f *fakeTaskRunnerFull) Stop(id string) error {
	f.stopReceive = id
	return f.stopErr
}
func (f *fakeTaskRunnerFull) SendStdin(id, data string) error {
	f.stdinReceive.id = id
	f.stdinReceive.data = data
	return f.stdinErr
}

func TestTaskListTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("no tasks", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{}
		ctx := testCtx(cfg, map[string]interface{}{})
		ctx.TaskRunner = runner
		res := NewTaskListTool().Execute(ctx)
		if res.Status != "success" || !strings.Contains(res.Output, "no background tasks") {
			t.Errorf("got status=%s output=%q", res.Status, res.Output)
		}
	})

	t.Run("filters by status", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{snaps: []TaskSnapshot{
			{ID: "bg-2", Command: "echo b", Status: "done", ExitCode: 0, StartedAt: time.Now().Format(time.RFC3339)},
			{ID: "bg-1", Command: "echo a", Status: "running", StartedAt: time.Now().Format(time.RFC3339)},
		}}
		ctx := testCtx(cfg, map[string]interface{}{"status": "running"})
		ctx.TaskRunner = runner
		res := NewTaskListTool().Execute(ctx)
		if res.Status != "success" {
			t.Fatalf("status %s err=%s", res.Status, res.Error)
		}
		if !strings.Contains(res.Output, "bg-1") || strings.Contains(res.Output, "bg-2") {
			t.Errorf("expected bg-1 only when filtering running, got %q", res.Output)
		}
	})

	t.Run("missing runner errors", func(t *testing.T) {
		res := NewTaskListTool().Execute(testCtx(cfg, map[string]interface{}{}))
		if res.Status != "error" {
			t.Error("expected error when TaskRunner is nil")
		}
	})
}

func TestTaskOutputTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("returns stdout and stderr sections", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{
			getSnap:   TaskSnapshot{ID: "bg-1", Command: "echo hi", Status: "done", ExitCode: 0},
			getStdout: "hello world",
			getStderr: "a warning",
			getOK:     true,
		}
		ctx := testCtx(cfg, map[string]interface{}{"task_id": "bg-1"})
		ctx.TaskRunner = runner
		res := NewTaskOutputTool().Execute(ctx)
		if res.Status != "success" {
			t.Fatalf("status %s err=%s", res.Status, res.Error)
		}
		if !strings.Contains(res.Output, "hello world") || !strings.Contains(res.Output, "a warning") {
			t.Errorf("expected both streams, got %q", res.Output)
		}
	})

	t.Run("not found errors", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{getOK: false}
		ctx := testCtx(cfg, map[string]interface{}{"task_id": "missing"})
		ctx.TaskRunner = runner
		res := NewTaskOutputTool().Execute(ctx)
		if res.Status != "error" {
			t.Error("expected error for missing task")
		}
	})

	t.Run("validate rejects empty task_id", func(t *testing.T) {
		if err := NewTaskOutputTool().Validate(map[string]interface{}{"task_id": ""}); err == nil {
			t.Error("expected error")
		}
	})
}

func TestTaskStopTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	runner := &fakeTaskRunnerFull{}
	ctx := testCtx(cfg, map[string]interface{}{"task_id": "bg-7"})
	ctx.TaskRunner = runner
	res := NewTaskStopTool().Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("status %s err=%s", res.Status, res.Error)
	}
	if runner.stopReceive != "bg-7" {
		t.Errorf("expected runner.Stop('bg-7'), got %q", runner.stopReceive)
	}
}

func TestSendStdinTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("appends newline by default", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{}
		ctx := testCtx(cfg, map[string]interface{}{"task_id": "bg-1", "data": "hello"})
		ctx.TaskRunner = runner
		res := NewSendStdinTool().Execute(ctx)
		if res.Status != "success" {
			t.Fatalf("status %s err=%s", res.Status, res.Error)
		}
		if runner.stdinReceive.id != "bg-1" {
			t.Errorf("wrong id forwarded: %q", runner.stdinReceive.id)
		}
		if runner.stdinReceive.data != "hello\n" {
			t.Errorf("expected trailing newline appended, got %q", runner.stdinReceive.data)
		}
	})

	t.Run("opt out of newline", func(t *testing.T) {
		runner := &fakeTaskRunnerFull{}
		ctx := testCtx(cfg, map[string]interface{}{
			"task_id":        "bg-2",
			"data":           "raw",
			"append_newline": false,
		})
		ctx.TaskRunner = runner
		NewSendStdinTool().Execute(ctx)
		if runner.stdinReceive.data != "raw" {
			t.Errorf("expected raw data, got %q", runner.stdinReceive.data)
		}
	})

	t.Run("validate missing fields", func(t *testing.T) {
		tool := NewSendStdinTool()
		if err := tool.Validate(map[string]interface{}{"data": "x"}); err == nil {
			t.Error("expected error for missing task_id")
		}
		if err := tool.Validate(map[string]interface{}{"task_id": "bg-3"}); err == nil {
			t.Error("expected error for missing data")
		}
	})
}
