package tool

import (
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/types"
)

// Tests for Name/Description/Parameters/Validate methods that have 0% coverage

func TestToolMeta(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	tools := []interface {
		Name() string
		Description() string
		Parameters() interface{}
	}{
		NewEditTool(cfg),
		NewApplyPatchTool(cfg),
		NewExecCmdTool(cfg),
		NewGlobTool(cfg),
		NewGrepTool(cfg),
		NewListDirTool(cfg),
		NewQuestionTool(),
		NewReadFileTool(cfg),
		NewWriteFileTool(cfg),
		NewSkillTool(cfg),
		NewTodoWriteTool(cfg),
		NewMemoryReadTool(cfg),
		NewMemoryWriteTool(cfg),
		NewMemoryForgetTool(cfg),
		NewWebFetchTool(),
		NewToolHelpTool(NewRegistry()),
	}

	for _, tool := range tools {
		if tool.Name() == "" {
			t.Errorf("%T: Name() returned empty string", tool)
		}
		if tool.Description() == "" {
			t.Errorf("%T: Description() returned empty string", tool)
		}
		if tool.Parameters() == nil {
			t.Errorf("%T: Parameters() returned nil", tool)
		}
	}
}

func TestValidateMethods(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("EditTool validate missing path", func(t *testing.T) {
		if err := NewEditTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("ApplyPatchTool validate missing patch", func(t *testing.T) {
		if err := NewApplyPatchTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("GlobTool validate missing pattern", func(t *testing.T) {
		if err := NewGlobTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("ReadFileTool validate missing path", func(t *testing.T) {
		if err := NewReadFileTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("WriteFileTool validate missing path", func(t *testing.T) {
		if err := NewWriteFileTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("MemoryWriteTool validate missing content", func(t *testing.T) {
		if err := NewMemoryWriteTool(cfg).Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("Memory tools validate scope", func(t *testing.T) {
		if err := NewMemoryReadTool(cfg).Validate(map[string]interface{}{"scope": "all"}); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if err := NewMemoryWriteTool(cfg).Validate(map[string]interface{}{"scope": "all", "content": "x"}); err == nil {
			t.Error("expected error")
		}
	})

	t.Run("SkillTool validate arguments", func(t *testing.T) {
		tool := NewSkillTool(cfg)
		if err := tool.Validate(map[string]interface{}{}); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if err := tool.Validate(map[string]interface{}{"skill": "caveman"}); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if err := tool.Validate(map[string]interface{}{"skill": 1}); err == nil {
			t.Error("expected error")
		}
		if err := tool.Validate(map[string]interface{}{"name": "caveman"}); err == nil || !strings.Contains(err.Error(), "skill") {
			t.Fatalf("expected helpful name error, got %v", err)
		}
	})

	t.Run("ToolHelpTool validate optional strings", func(t *testing.T) {
		tool := NewToolHelpTool(NewRegistry())
		if err := tool.Validate(map[string]interface{}{"tool": "browser_snapshot"}); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if err := tool.Validate(map[string]interface{}{"tool": 1}); err == nil {
			t.Error("expected error")
		}
		if err := tool.Validate(map[string]interface{}{"name": "read_file"}); err == nil || !strings.Contains(err.Error(), "tool") {
			t.Fatalf("expected helpful name error, got %v", err)
		}
	})
}

func TestToolHelpTool(t *testing.T) {
	reg := NewRegistry()
	if err := reg.Register(NewReadFileTool(&types.Config{RootDir: t.TempDir(), Timeout: 10})); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(NewToolHelpTool(reg)); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(NewMemoryReadTool(&types.Config{})); err != nil {
		t.Fatal(err)
	}

	t.Run("returns detailed parameters for exact tool", func(t *testing.T) {
		tool := NewToolHelpTool(reg)
		res := tool.Execute(&Context{Args: map[string]interface{}{"tool": "read_file"}})
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "### read_file") || !strings.Contains(res.Output, "Parameters:") || !strings.Contains(res.Output, "path") {
			t.Fatalf("expected detailed read_file docs, got %q", res.Output)
		}
	})

	t.Run("lists matching tools", func(t *testing.T) {
		tool := NewToolHelpTool(reg)
		res := tool.Execute(&Context{Args: map[string]interface{}{"query": "read"}})
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "read_file") || !strings.Contains(res.Output, "Call tool_help") {
			t.Fatalf("expected filtered tool list, got %q", res.Output)
		}
	})

	t.Run("tags read-only tools in the list", func(t *testing.T) {
		tool := NewToolHelpTool(reg)
		res := tool.Execute(&Context{Args: map[string]interface{}{}})
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "memory_read [read-only]") {
			t.Fatalf("expected read-only tag on memory_read, got %q", res.Output)
		}
	})

	t.Run("suggests near matches when tool not found", func(t *testing.T) {
		tool := NewToolHelpTool(reg)
		res := tool.Execute(&Context{Args: map[string]interface{}{"tool": "read"}})
		if res.Status != "error" {
			t.Fatal("expected error for non-exact name")
		}
		if !strings.Contains(res.Error, "Did you mean") || !strings.Contains(res.Error, "read_file") {
			t.Fatalf("expected read_file suggestion, got %q", res.Error)
		}
	})

	t.Run("no suggestion for totally unknown tool", func(t *testing.T) {
		tool := NewToolHelpTool(reg)
		res := tool.Execute(&Context{Args: map[string]interface{}{"tool": "zzz_nope"}})
		if res.Status != "error" || strings.Contains(res.Error, "Did you mean") {
			t.Fatalf("expected plain not-found error, got %q", res.Error)
		}
	})
}

func TestReadFileOffsetLimit(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewWriteFileTool(cfg)
	r := NewReadFileTool(cfg)

	// Write 10 lines
	var sb strings.Builder
	for i := 1; i <= 10; i++ {
		sb.WriteString("line\n")
	}
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "content": sb.String()}))

	t.Run("offset skips lines", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "offset": float64(5)}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
	})

	t.Run("limit restricts lines", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "lines.txt", "limit": float64(2)}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "truncated") {
			t.Errorf("expected truncation notice, got %q", res.Output)
		}
	})

	t.Run("nonexistent file returns error", func(t *testing.T) {
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "nope.txt"}))
		if res.Status != "error" {
			t.Error("expected error for missing file")
		}
	})
}

func TestExecCmdGetShell(t *testing.T) {
	shell, flag := getShell()
	if shell == "" || flag == "" {
		t.Error("getShell returned empty values")
	}
}

func TestGrepWithInclude(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewWriteFileTool(cfg)
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "foo.go", "content": "package main\n"}))
	w.Execute(testCtx(cfg, map[string]interface{}{"path": "foo.txt", "content": "package main\n"}))

	g := NewGrepTool(cfg)
	res := g.Execute(testCtx(cfg, map[string]interface{}{
		"pattern": "package",
		"include": "*.go",
	}))
	if res.Status != "success" {
		t.Fatal(res.Error)
	}
	if !strings.Contains(res.Output, "foo.go") {
		t.Errorf("expected foo.go in output, got %q", res.Output)
	}
}
