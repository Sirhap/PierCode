package executor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/types"
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

	t.Run("validation error adds tool_help hint for AI callers", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:           "edit",
			CallID:         "ai-badargs",
			Args:           map[string]interface{}{}, // missing path/old_string/new_string
			SourceClientID: "ai-page-1",
		})
		if resp.Status != "error" {
			t.Fatalf("expected error, got %s", resp.Status)
		}
		if !strings.Contains(resp.Error, "tool_help") {
			t.Fatalf("expected tool_help hint for AI caller, got %q", resp.Error)
		}
	})

	t.Run("validation error stays raw for direct callers", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:   "edit",
			CallID: "direct-badargs",
			Args:   map[string]interface{}{},
			// no SourceClientID -> TUI/API caller
		})
		if resp.Status != "error" {
			t.Fatalf("expected error, got %s", resp.Status)
		}
		if strings.Contains(resp.Error, "Hint:") {
			t.Fatalf("direct caller should get raw error, got %q", resp.Error)
		}
	})

	t.Run("runtime error adds path hint for AI callers", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:           "read_file",
			CallID:         "ai-missing-file",
			Args:           map[string]interface{}{"path": "definitely_not_here.go"},
			SourceClientID: "ai-page-1",
		})
		if resp.Status != "error" {
			t.Fatalf("expected error, got %s", resp.Status)
		}
		if !strings.Contains(resp.Error, "Hint:") || !strings.Contains(resp.Error, "list_dir") {
			t.Fatalf("expected list_dir hint, got %q", resp.Error)
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

	t.Run("background task user flow lists output and stops", func(t *testing.T) {
		skipOnWindows(t)
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:   "exec_cmd",
			CallID: "bg-user-flow",
			Args: map[string]interface{}{
				"command":    "printf 'server ready\\n'; sleep 30",
				"background": true,
			},
		})
		if resp.Status != "running" {
			t.Fatalf("expected running background task, got %s: %s", resp.Status, resp.Error)
		}
		taskID := extractBackgroundTaskID(t, resp.Output)

		var output *types.ToolResponse
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			output = e.Execute(context.Background(), &types.ToolRequest{
				Name: "task_output",
				Args: map[string]interface{}{"task_id": taskID, "stream": "stdout"},
			})
			if output.Status == "success" && strings.Contains(output.Output, "server ready") {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if output == nil || !strings.Contains(output.Output, "server ready") {
			t.Fatalf("expected task_output to show user-visible stdout, got %#v", output)
		}

		stop := e.Execute(context.Background(), &types.ToolRequest{
			Name: "task_stop",
			Args: map[string]interface{}{"task_id": taskID},
		})
		if stop.Status != "success" {
			t.Fatalf("expected task_stop success, got %s: %s", stop.Status, stop.Error)
		}

		select {
		case <-e.Tasks().Get(taskID).Done():
		case <-time.After(3 * time.Second):
			t.Fatal("background task did not stop")
		}

		list := e.Execute(context.Background(), &types.ToolRequest{
			Name: "task_list",
			Args: map[string]interface{}{},
		})
		if list.Status != "success" {
			t.Fatalf("expected task_list success, got %s: %s", list.Status, list.Error)
		}
		if !strings.Contains(list.Output, taskID) {
			t.Fatalf("expected stopped task in task_list output, got %q", list.Output)
		}
		if strings.Contains(list.Output, "["+taskID+"]  [running]") {
			t.Fatalf("expected task to no longer be running after task_stop, got %q", list.Output)
		}
	})

	t.Run("list tools returns all registered tools", func(t *testing.T) {
		e := New(testConfig(t))
		tools := e.ListTools()
		if len(tools) == 0 {
			t.Error("expected tools to be registered")
		}
		seen := map[string]bool{}
		for _, info := range tools {
			seen[info.Name] = true
		}
		for _, want := range []string{"browser_finalize_tabs", "browser_viewport", "browser_downloads",
			"browser_storage", "browser_set_cookie", "browser_wait_for_navigation", "browser_emulate", "browser_get_attributes", "tool_help"} {
			if !seen[want] {
				t.Fatalf("expected %s to be registered", want)
			}
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

func extractBackgroundTaskID(t *testing.T, output string) string {
	t.Helper()
	const marker = "backgrounded as task "
	start := strings.Index(output, marker)
	if start < 0 {
		t.Fatalf("background task marker missing from output: %q", output)
	}
	rest := output[start+len(marker):]
	end := strings.Index(rest, " ")
	if end < 0 {
		t.Fatalf("background task id terminator missing from output: %q", output)
	}
	return strings.TrimSpace(rest[:end])
}

func TestExecutorPromptGuidance(t *testing.T) {
	t.Run("tool responses include operating reminder when called from AI client", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:           "list_dir",
			CallID:         "list1a",
			Args:           map[string]interface{}{"path": "."},
			SourceClientID: "ai-page-1",
		})
		for _, want := range []string{"[系统提示]", "piercode-tool", "sandbox", "piercode-*", "测试或明确证据"} {
			if !strings.Contains(resp.Output, want) {
				t.Fatalf("expected reminder to contain %q, got %q", want, resp.Output)
			}
		}
	})

	t.Run("every fifth tool response asks for task checkpoint when called from AI client", func(t *testing.T) {
		e := New(testConfig(t))
		var resp *types.ToolResponse
		for i := 0; i < 5; i++ {
			resp = e.Execute(context.Background(), &types.ToolRequest{
				Name:           "list_dir",
				CallID:         "list5a",
				Args:           map[string]interface{}{"path": "."},
				SourceClientID: "ai-page-1",
			})
		}
		for _, want := range []string{"[任务状态快照提示]", "已改文件", "验证结果", "todo_write"} {
			if !strings.Contains(resp.Output, want) {
				t.Fatalf("expected checkpoint reminder to contain %q, got %q", want, resp.Output)
			}
		}
	})

	t.Run("qwen tool responses include context packet reminder", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:           "list_dir",
			CallID:         "qwen1a",
			Args:           map[string]interface{}{"path": "."},
			SourceClientID: "ai-page-1",
			Profile:        "qwen",
		})
		for _, want := range []string{"[Qwen 上下文迁移提示]", "```piercode-context", "不要输出 XML wrapper", "不要输出 `piercode-tool`"} {
			if !strings.Contains(resp.Output, want) {
				t.Fatalf("expected qwen context packet reminder to contain %q, got %q", want, resp.Output)
			}
		}
	})

	t.Run("direct API calls get clean output without prompt guidance", func(t *testing.T) {
		e := New(testConfig(t))
		resp := e.Execute(context.Background(), &types.ToolRequest{
			Name:   "list_dir",
			CallID: "direct1",
			Args:   map[string]interface{}{"path": "."},
		})
		if strings.Contains(resp.Output, "[系统提示]") {
			t.Fatalf("direct API call should not have operating reminder, got %q", resp.Output)
		}
		if strings.Contains(resp.Output, "[任务状态快照提示]") {
			t.Fatalf("direct API call should not have checkpoint reminder, got %q", resp.Output)
		}
	})

	t.Run("every twentieth tool response reinjects embedded prompt when called from AI client", func(t *testing.T) {
		cfg := testConfig(t)
		cfg.DefaultPrompt = []byte("system {{SYSTEM_INFO}}\noperations {{TOOLS}}")
		e := New(cfg)
		var resp *types.ToolResponse
		for i := 0; i < 20; i++ {
			resp = e.Execute(context.Background(), &types.ToolRequest{
				Name:           "list_dir",
				CallID:         "list20a",
				Args:           map[string]interface{}{"path": "."},
				SourceClientID: "ai-page-1",
			})
		}
		for _, want := range []string{"[系统重新注入提示词]", "system - 操作系统:", "operations This is a compact route index", "`tool_help`", "[任务状态快照提示]"} {
			if !strings.Contains(resp.Output, want) {
				t.Fatalf("expected reinjected prompt to contain %q, got %q", want, resp.Output)
			}
		}
		for _, forbidden := range []string{"{{SYSTEM_INFO}}", "{{TOOLS}}"} {
			if strings.Contains(resp.Output, forbidden) {
				t.Fatalf("expected placeholder %q to be rendered, got %q", forbidden, resp.Output)
			}
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

	t.Run("edit command keeps a folded preview for larger edits", func(t *testing.T) {
		req := &types.ToolRequest{
			Name: "edit",
			Args: map[string]interface{}{
				"path":       "internal\\server\\server.go",
				"old_string": strings.Join([]string{"old1", "old2", "old3", "old4", "old5"}, "\n"),
				"new_string": strings.Join([]string{"new1", "new2", "new3", "new4"}, "\n"),
			},
		}
		resp := &types.ToolResponse{Status: "success", Output: "ok"}

		summary := summarizeToolLog(req, resp)
		if !strings.Contains(summary, "Edited internal\\server\\server.go (+4 -5)") {
			t.Fatalf("expected edited summary, got %q", summary)
		}
		if !strings.Contains(summary, "- old1") || !strings.Contains(summary, "+ new1") {
			t.Fatalf("expected folded preview to keep first changed lines, got %q", summary)
		}
		if !strings.Contains(summary, "… +3 lines") || !strings.Contains(summary, "Ctrl+T 查看完整") {
			t.Fatalf("expected hidden-line hint, got %q", summary)
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
