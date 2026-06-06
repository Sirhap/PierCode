package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/memory"
	"github.com/sirhap/piercode/internal/types"
)

func TestMemoryWriteReadForgetProject(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	ctx := testCtx(cfg, map[string]interface{}{"content": "Remember project convention."})

	writeRes := NewMemoryWriteTool(cfg).Execute(ctx)
	if writeRes.Status != "success" {
		t.Fatal(writeRes.Error)
	}

	path := filepath.Join(cfg.RootDir, ".piercode", "memory.md")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "Remember project convention.\n" {
		t.Fatalf("unexpected memory content %q", string(data))
	}

	readRes := NewMemoryReadTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "project"}))
	if readRes.Status != "success" {
		t.Fatal(readRes.Error)
	}
	if !strings.Contains(readRes.Output, "Remember project convention.") {
		t.Fatalf("expected memory output, got %q", readRes.Output)
	}

	forgetRes := NewMemoryForgetTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "project"}))
	if forgetRes.Status != "success" {
		t.Fatal(forgetRes.Error)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected memory file to be deleted, err=%v", err)
	}
}

func TestMemoryReadIsReadOnly(t *testing.T) {
	if !NewMemoryReadTool(&types.Config{}).Metadata().ReadOnly {
		t.Fatal("memory_read must report ReadOnly so the executor does not serialize it under a write lock")
	}
}

func TestMemoryAppendSeparatorAndAccumulate(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewMemoryWriteTool(cfg)
	path := filepath.Join(cfg.RootDir, ".piercode", "memory.md")

	// First append (no trailing newline on input) -> normalized with newline.
	if res := w.Execute(testCtx(cfg, map[string]interface{}{"content": "line one"})); res.Status != "success" {
		t.Fatal(res.Error)
	}
	// Second append must not glue onto the first line.
	if res := w.Execute(testCtx(cfg, map[string]interface{}{"content": "line two"})); res.Status != "success" {
		t.Fatal(res.Error)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "line one\nline two\n" {
		t.Fatalf("unexpected accumulated content %q", string(data))
	}
}

func TestMemoryOverwriteReplaces(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewMemoryWriteTool(cfg)
	path := filepath.Join(cfg.RootDir, ".piercode", "memory.md")

	w.Execute(testCtx(cfg, map[string]interface{}{"content": "old note"}))
	if res := w.Execute(testCtx(cfg, map[string]interface{}{"content": "new note", "mode": "overwrite"})); res.Status != "success" {
		t.Fatal(res.Error)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "new note\n" {
		t.Fatalf("overwrite should replace whole file, got %q", string(data))
	}
}

func TestMemoryAppendRejectsOversize(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	w := NewMemoryWriteTool(cfg)
	big := strings.Repeat("x", memory.MemoryMaxBytes+1)
	res := w.Execute(testCtx(cfg, map[string]interface{}{"content": big}))
	if res.Status != "error" {
		t.Fatal("oversize append must be rejected")
	}
	if !strings.Contains(res.Error, "exceed") {
		t.Fatalf("expected size error, got %q", res.Error)
	}
}

func TestMemoryGlobalScope(t *testing.T) {
	// Redirect HOME so the global file lands in a temp dir we can clean up.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}

	if res := NewMemoryWriteTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "global", "content": "global pref"})); res.Status != "success" {
		t.Fatal(res.Error)
	}
	globalPath := filepath.Join(tmp, ".piercode", "memory.md")
	if _, err := os.Stat(globalPath); err != nil {
		t.Fatalf("global memory file not written: %v", err)
	}

	readRes := NewMemoryReadTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "global"}))
	if readRes.Status != "success" || !strings.Contains(readRes.Output, "global pref") {
		t.Fatalf("global read failed: %v / %q", readRes.Error, readRes.Output)
	}

	if res := NewMemoryForgetTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "global"})); res.Status != "success" {
		t.Fatal(res.Error)
	}
	if _, err := os.Stat(globalPath); !os.IsNotExist(err) {
		t.Fatalf("global memory should be deleted, err=%v", err)
	}
}

func TestMemoryForgetMissingIsSuccess(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	if res := NewMemoryForgetTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"scope": "project"})); res.Status != "success" {
		t.Fatalf("forget on missing file should succeed, got %q / %s", res.Status, res.Error)
	}
}

func TestMemoryScopeValidation(t *testing.T) {
	if err := NewMemoryReadTool(&types.Config{}).Validate(map[string]interface{}{"scope": "all"}); err != nil {
		t.Fatalf("read allows scope=all: %v", err)
	}
	if err := NewMemoryWriteTool(&types.Config{}).Validate(map[string]interface{}{"scope": "all", "content": "x"}); err == nil {
		t.Fatal("write must reject scope=all")
	}
	if err := NewMemoryWriteTool(&types.Config{}).Validate(map[string]interface{}{"content": " "}); err == nil {
		t.Fatal("write must reject blank content")
	}
	if err := NewMemoryWriteTool(&types.Config{}).Validate(map[string]interface{}{"content": "x", "mode": "nuke"}); err == nil {
		t.Fatal("write must reject bad mode")
	}
}
