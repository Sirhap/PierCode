package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

func TestListDirTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte(""), 0644)
	os.MkdirAll(filepath.Join(cfg.RootDir, "subdir"), 0755)
	tool := NewListDirTool(cfg)

	t.Run("lists files and dirs", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "."}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "a.txt") || !strings.Contains(res.Output, "subdir/") {
			t.Errorf("unexpected output: %q", res.Output)
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "../outside"}))
		if res.Status != "error" {
			t.Error("expected error")
		}
	})

	t.Run("empty dir returns empty", func(t *testing.T) {
		empty := filepath.Join(cfg.RootDir, "empty")
		os.MkdirAll(empty, 0755)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"path": "empty"}))
		if res.Output != "empty" {
			t.Errorf("got %q", res.Output)
		}
	})
}

func TestQuestionTool(t *testing.T) {
	tool := NewQuestionTool()

	t.Run("blocks until Deliver is called and includes answer in output", func(t *testing.T) {
		callID := "test-q-1"
		go func() {
			// Give Execute a moment to register on PendingQuestions.
			time.Sleep(50 * time.Millisecond)
			PendingQuestions.Deliver(callID, "Alice")
		}()
		res := tool.Execute(&Context{
			Args: map[string]interface{}{
				"question": "What is your name?",
				"call_id":  callID,
			},
		})
		if res.Status != "success" {
			t.Fatalf("expected success, got %s (%s)", res.Status, res.Error)
		}
		if !strings.Contains(res.Output, "What is your name?") || !strings.Contains(res.Output, "Alice") {
			t.Errorf("expected both question and answer in output, got %q", res.Output)
		}
	})

	t.Run("includes options when provided", func(t *testing.T) {
		callID := "test-q-2"
		go func() {
			time.Sleep(30 * time.Millisecond)
			PendingQuestions.Deliver(callID, "A")
		}()
		res := tool.Execute(&Context{
			Args: map[string]interface{}{
				"question": "Pick one",
				"options":  []interface{}{"A", "B"},
				"call_id":  callID,
			},
		})
		if !strings.Contains(res.Output, "A") || !strings.Contains(res.Output, "B") {
			t.Errorf("got %q", res.Output)
		}
	})

	t.Run("missing call_id errors", func(t *testing.T) {
		res := tool.Execute(&Context{Args: map[string]interface{}{"question": "no id?"}})
		if res.Status != "error" {
			t.Errorf("expected error when call_id is missing, got %s", res.Status)
		}
	})

	t.Run("timeout returns error", func(t *testing.T) {
		callID := "test-q-timeout"
		res := tool.Execute(&Context{
			Args: map[string]interface{}{
				"question":    "no one will answer",
				"call_id":     callID,
				"timeout_sec": float64(0.1), // 100ms
			},
		})
		if res.Status != "error" {
			t.Errorf("expected error on timeout, got %s", res.Status)
		}
		if !strings.Contains(res.Error, "no answer received") {
			t.Errorf("expected timeout message, got %q", res.Error)
		}
	})

	t.Run("cancel returns error immediately", func(t *testing.T) {
		callID := "test-q-cancel"
		go func() {
			time.Sleep(30 * time.Millisecond)
			PendingQuestions.Cancel(callID, "user_cancelled")
		}()
		start := time.Now()
		res := tool.Execute(&Context{
			Args: map[string]interface{}{
				"question":    "cancel me",
				"call_id":     callID,
				"timeout_sec": float64(30),
			},
		})
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("cancel should not wait for timeout, elapsed=%s", elapsed)
		}
		if res.Status != "error" {
			t.Fatalf("expected error on cancel, got %s", res.Status)
		}
		if !strings.Contains(res.Error, "question canceled") {
			t.Errorf("expected cancel message, got %q", res.Error)
		}
	})

	t.Run("validate rejects missing question", func(t *testing.T) {
		if err := tool.Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})
}

func TestInvalidTool(t *testing.T) {
	tool := &InvalidTool{}
	res := tool.Execute(&Context{Args: map[string]interface{}{"tool": "foo_bar"}})
	if res.Status != "error" || !strings.Contains(res.Error, "foo_bar") {
		t.Errorf("got status=%s error=%q", res.Status, res.Error)
	}
}

func TestTodoWriteTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewTodoWriteTool(cfg)

	t.Run("writes todos to file", func(t *testing.T) {
		todos := []interface{}{"task1", "task2"}
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"todos": todos}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, ".todos.json")); err != nil {
			t.Error("expected .todos.json to exist")
		}
	})

	t.Run("validate rejects missing todos", func(t *testing.T) {
		if err := tool.Validate(map[string]interface{}{}); err == nil {
			t.Error("expected error")
		}
	})
}

func TestSkillTool(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	t.Run("lists skills when no name given", func(t *testing.T) {
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
	})

	t.Run("returns error for unknown skill", func(t *testing.T) {
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"skill": "nonexistent"}))
		if res.Status != "error" {
			t.Error("expected error for unknown skill")
		}
	})

	t.Run("loads existing skill", func(t *testing.T) {
		sub := filepath.Join(cfg.RootDir, ".skills", "mything")
		os.MkdirAll(sub, 0755)
		os.WriteFile(filepath.Join(sub, "SKILL.md"), []byte("---\nname: mything\ndescription: test\n---\nskill content"), 0644)
		tool := NewSkillTool(cfg)
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"skill": "mything"}))
		if res.Status != "success" || !strings.Contains(res.Output, "skill content") {
			t.Errorf("got status=%s output=%q", res.Status, res.Output)
		}
	})
}
