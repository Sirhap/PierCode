package executor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/afumu/openlink/internal/tool"
	"github.com/afumu/openlink/internal/types"
)

type mutatingArgsTool struct{}

func (mutatingArgsTool) Name() string                          { return "mutating_args" }
func (mutatingArgsTool) Description() string                   { return "mutates args during execute" }
func (mutatingArgsTool) Parameters() interface{}               { return nil }
func (mutatingArgsTool) Validate(map[string]interface{}) error { return nil }
func (mutatingArgsTool) Execute(ctx *tool.Context) *tool.Result {
	ctx.Args["mutated"] = true
	return &tool.Result{Status: "success", Output: "ok", StartTime: time.Now(), EndTime: time.Now()}
}

func testConfig(t *testing.T) *types.Config {
	t.Helper()
	// Tests exercise the exec_cmd tool, which is gated off by default in
	// production. Enable it explicitly here so the tool harness can run shell
	// commands; the security default is verified by the tool-level test that
	// constructs a Config with AllowShell=false.
	return &types.Config{RootDir: t.TempDir(), Timeout: 10, AllowShell: true}
}

func TestExecutor(t *testing.T) {
	t.Run("unknown tool returns error", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{Name: "no_such_tool", CallID: "missing1"})
		if resp.Status != "error" {
			t.Errorf("expected error, got %s", resp.Status)
		}
		if resp.Name != "no_such_tool" || resp.CallID != "missing1" {
			t.Errorf("expected response metadata to preserve request, got name=%q call_id=%q", resp.Name, resp.CallID)
		}
	})

	t.Run("validation failure returns error", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:   "exec_cmd",
			CallID: "badargs1",
			Args:   map[string]interface{}{}, // missing command
		})
		if resp.Status != "error" {
			t.Errorf("expected error, got %s", resp.Status)
		}
		if resp.Name != "exec_cmd" || resp.CallID != "badargs1" {
			t.Errorf("expected response metadata to preserve request, got name=%q call_id=%q", resp.Name, resp.CallID)
		}
	})

	t.Run("exec_cmd runs successfully", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:   "exec_cmd",
			CallID: "okargs1",
			Args:   map[string]interface{}{"command": "echo hello"},
		})
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
		if resp.Name != "exec_cmd" || resp.CallID != "okargs1" {
			t.Errorf("expected response metadata to preserve request, got name=%q call_id=%q", resp.Name, resp.CallID)
		}
	})

	t.Run("list tools returns all registered tools", func(t *testing.T) {
		e := New(testConfig(t))
		tools := e.ListTools()
		if len(tools) == 0 {
			t.Error("expected tools to be registered")
		}
	})

	t.Run("tool args are copied without call id", func(t *testing.T) {
		e := New(testConfig(t))
		if err := e.registry.Register(mutatingArgsTool{}); err != nil {
			t.Fatal(err)
		}
		args := map[string]interface{}{"value": "original"}
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name: "mutating_args",
			Args: args,
		})
		if resp.Status != "success" {
			t.Fatalf("expected success, got %s: %s", resp.Status, resp.Error)
		}
		if _, ok := args["mutated"]; ok {
			t.Fatal("tool mutation leaked into request args")
		}
	})

	t.Run("unknown tool does not mutate request args", func(t *testing.T) {
		e := New(testConfig(t))
		args := map[string]interface{}{"value": "original"}
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name: "missing_tool",
			Args: args,
		})
		if resp.Status != "error" {
			t.Fatalf("expected error, got %s", resp.Status)
		}
		if _, ok := args["tool"]; ok {
			t.Fatal("invalid tool metadata leaked into request args")
		}
	})
}

func TestSummarizeToolLog(t *testing.T) {
	t.Run("exec command folds long output", func(t *testing.T) {
		var output strings.Builder
		output.WriteString("command: Get-Content internal\\tool\\grep.go -Encoding UTF8\n\n")
		for i := 1; i <= 52; i++ {
			output.WriteString("line ")
			output.WriteString(strings.Repeat("x", i%3))
			output.WriteString("\n")
		}
		req := &types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "Get-Content internal\\tool\\grep.go -Encoding UTF8"},
		}
		resp := &types.ToolResponse{
			Status: "success",
			Output: output.String(),
		}

		summary := summarizeToolLog(req, resp)
		if !strings.Contains(summary, "Ran Get-Content internal\\tool\\grep.go -Encoding UTF8") {
			t.Fatalf("expected command header, got %q", summary)
		}
		if !strings.Contains(summary, "└ line") {
			t.Fatalf("expected first output line, got %q", summary)
		}
		if !strings.Contains(summary, "… +2 lines") {
			t.Fatalf("expected folded line count, got %q", summary)
		}
		if !strings.Contains(summary, "Ctrl+T 查看完整") {
			t.Fatalf("expected transcript shortcut hint, got %q", summary)
		}
	})

	t.Run("exec command error keeps useful output visible", func(t *testing.T) {
		req := &types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "some-command"},
		}
		resp := &types.ToolResponse{
			Status: "error",
			Output: "operation completed\nwarning emitted\n",
			Error:  "exit status 1",
		}

		summary := summarizeToolLog(req, resp)
		if strings.Contains(summary, "Failed exec_cmd") {
			t.Fatalf("expected command summary instead of generic failure, got %q", summary)
		}
		if !strings.Contains(summary, "Ran some-command (exit status 1)") {
			t.Fatalf("expected command and exit status, got %q", summary)
		}
		if !strings.Contains(summary, "operation completed") {
			t.Fatalf("expected output preview, got %q", summary)
		}
	})

	t.Run("edit command summarizes changed lines", func(t *testing.T) {
		req := &types.ToolRequest{
			Name: "edit",
			Args: map[string]interface{}{
				"path":       "internal\\server\\server.go",
				"old_string": "\"net/http\"\n\"opweqe\"",
				"new_string": "\"net/http\"\n\"os\"\n\"path/filepath\"",
			},
		}
		resp := &types.ToolResponse{Status: "success", Output: "ok"}

		summary := summarizeToolLog(req, resp)
		if !strings.Contains(summary, "Edited internal\\server\\server.go (+3 -2)") {
			t.Fatalf("expected edited summary, got %q", summary)
		}
		if !strings.Contains(summary, "+ \"os\"") {
			t.Fatalf("expected small edit preview, got %q", summary)
		}
	})

	t.Run("full tool log preserves hidden output", func(t *testing.T) {
		req := &types.ToolRequest{
			Name: "exec_cmd",
			Args: map[string]interface{}{"command": "Get-Content big.txt"},
		}
		resp := &types.ToolResponse{
			Status: "success",
			Output: "command: Get-Content big.txt\n\nfirst\nsecond\nFULL_OUTPUT_TAIL\n",
		}

		full := fullToolLog(req, resp)
		if !strings.Contains(full, "Ran Get-Content big.txt") {
			t.Fatalf("expected full command header, got %q", full)
		}
		if !strings.Contains(full, "FULL_OUTPUT_TAIL") {
			t.Fatalf("expected full output tail, got %q", full)
		}
	})
}

// TestListToolsHidesExecCmdWhenShellDisabled pins the prompt-rendering behavior:
// when AllowShell=false the AI must not see exec_cmd in the rendered tools doc
// — otherwise it tries the call, gets "exec_cmd is disabled", and burns a turn
// every time. The security gate in exec_cmd.Validate is the second line of
// defense, but the prompt-side hide is the cheap fast path.
func TestListToolsHidesExecCmdWhenShellDisabled(t *testing.T) {
	t.Run("AllowShell true exposes exec_cmd", func(t *testing.T) {
		cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10, AllowShell: true}
		ex := New(cfg)
		if !containsTool(ex.ListTools(), "exec_cmd") {
			t.Error("expected exec_cmd to be listed when AllowShell=true")
		}
	})
	t.Run("AllowShell false hides exec_cmd", func(t *testing.T) {
		cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10, AllowShell: false}
		ex := New(cfg)
		if containsTool(ex.ListTools(), "exec_cmd") {
			t.Error("expected exec_cmd to be hidden when AllowShell=false")
		}
		// Other tools must still be present — we're not nuking the registry.
		if !containsTool(ex.ListTools(), "read_file") {
			t.Error("expected read_file to still be listed")
		}
	})
}

func containsTool(tools []tool.ToolInfo, name string) bool {
	for _, t := range tools {
		if t.Name == name {
			return true
		}
	}
	return false
}
