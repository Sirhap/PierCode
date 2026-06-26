package executor

import (
	"context"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/types"
)

// panicTool panics during Execute. It takes the global exclusive lock (it is not
// read-only and not a special-cased name), so if the panic leaks the lock, the
// next exclusive-lock tool call blocks forever.
type panicTool struct{}

func (panicTool) Name() string                          { return "panic_tool" }
func (panicTool) Description() string                   { return "panics during execute" }
func (panicTool) Parameters() interface{}               { return nil }
func (panicTool) Validate(map[string]interface{}) error { return nil }
func (panicTool) Execute(*tool.Context) *tool.Result {
	panic("boom")
}

// A tool that panics must (1) not crash the executor — the panic is recovered
// into an error Result — and (2) not leak its execution lock, so a subsequent
// tool call of the same lock class still runs. Before the defer-unlock fix, the
// unlock ran AFTER t.Execute() returned, so a panic skipped it and the second
// call hung on toolMu.Lock() forever.
func TestToolPanicRecoversAndReleasesLock(t *testing.T) {
	e := New(testConfig(t))
	if err := e.registry.Register(panicTool{}); err != nil {
		t.Fatal(err)
	}

	// First call panics inside Execute; the executor must turn it into an error
	// response instead of propagating the panic.
	resp := e.Execute(context.Background(), &types.ToolRequest{Name: "panic_tool"})
	if resp.Status != "error" {
		t.Fatalf("expected panic to become an error response, got status %q", resp.Status)
	}

	// Second call must acquire the (global exclusive) lock and complete promptly.
	// If the panic leaked the lock, this hangs.
	done := make(chan *types.ToolResponse, 1)
	go func() {
		done <- e.Execute(context.Background(), &types.ToolRequest{
			Name: "todo_write",
			Args: map[string]interface{}{"todos": []interface{}{}},
		})
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("second tool call hung — panic leaked the execution lock")
	}
}
