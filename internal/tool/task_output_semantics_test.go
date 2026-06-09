package tool

import (
	"strings"
	"testing"
)

// snapTaskRunner returns a fixed snapshot so we can exercise task_output's
// exit-code annotation independent of a real TaskManager.
type snapTaskRunner struct {
	snap TaskSnapshot
}

func (r *snapTaskRunner) Start(spec TaskSpec) (string, error) { return r.snap.ID, nil }
func (r *snapTaskRunner) Snapshots() []TaskSnapshot           { return []TaskSnapshot{r.snap} }
func (r *snapTaskRunner) GetSnapshot(id string) (TaskSnapshot, string, string, bool) {
	return r.snap, "", "", true
}
func (r *snapTaskRunner) Stop(id string) error            { return nil }
func (r *snapTaskRunner) SendStdin(id, data string) error { return nil }

func TestTaskOutputAnnotatesBenignExitCode(t *testing.T) {
	tool := &TaskOutputTool{}

	t.Run("grep exit 1 annotated as not a failure", func(t *testing.T) {
		runner := &snapTaskRunner{snap: TaskSnapshot{
			ID: "t1", Command: "grep foo big.log", Status: "done", ExitCode: 1,
		}}
		ctx := &Context{Args: map[string]interface{}{"task_id": "t1"}, Tasks: TaskAccess{Runner: runner}}
		res := tool.Execute(ctx)
		if !strings.Contains(res.Output, "not a failure") {
			t.Errorf("expected benign-exit note, got: %s", res.Output)
		}
		if !strings.Contains(res.Output, "No matches found") {
			t.Errorf("expected grep semantic message, got: %s", res.Output)
		}
	})

	t.Run("real failure not annotated", func(t *testing.T) {
		runner := &snapTaskRunner{snap: TaskSnapshot{
			ID: "t2", Command: "go build ./...", Status: "failed", ExitCode: 1,
		}}
		ctx := &Context{Args: map[string]interface{}{"task_id": "t2"}, Tasks: TaskAccess{Runner: runner}}
		res := tool.Execute(ctx)
		if strings.Contains(res.Output, "not a failure") {
			t.Errorf("go build exit 1 is a real failure, should not be annotated: %s", res.Output)
		}
	})
}
