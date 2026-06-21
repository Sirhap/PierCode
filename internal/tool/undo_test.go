package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUndoRevertEdit(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "f.txt")
	os.WriteFile(p, []byte("original\n"), 0644)

	// edit 改内容(会建快照)
	er := NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "f.txt", "old_string": "original", "new_string": "changed",
	}))
	if er.Status != "success" {
		t.Fatalf("edit failed: %s", er.Error)
	}
	if got, _ := os.ReadFile(p); string(got) != "changed\n" {
		t.Fatalf("edit didn't apply: %q", got)
	}

	// undo revert 最近
	ur := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"action": "revert"}))
	if ur.Status != "success" {
		t.Fatalf("undo failed: %s", ur.Error)
	}
	if got, _ := os.ReadFile(p); string(got) != "original\n" {
		t.Fatalf("undo didn't restore: %q", got)
	}
}

func TestUndoRevertWriteNewFileDeletes(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "new.txt")
	// 覆盖写一个不存在的文件 → 快照记录 "不存在", undo 应删除
	wr := NewWriteFileTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "new.txt", "content": "hello",
	}))
	if wr.Status != "success" {
		t.Fatalf("write failed: %s", wr.Error)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("file should exist: %v", err)
	}
	ur := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"action": "revert"}))
	if ur.Status != "success" {
		t.Fatalf("undo failed: %s", ur.Error)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("undo should have removed the created file, stat err=%v", err)
	}
}

func TestUndoRevertAppendRestoresPriorContent(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "log.txt")
	os.WriteFile(p, []byte("line1\n"), 0644)

	// append mode must snapshot the prior state (like overwrite) so undo can
	// restore it — otherwise the appended content is silently kept on revert.
	wr := NewWriteFileTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "log.txt", "content": "line2\n", "mode": "append",
	}))
	if wr.Status != "success" {
		t.Fatalf("append failed: %s", wr.Error)
	}
	if got, _ := os.ReadFile(p); string(got) != "line1\nline2\n" {
		t.Fatalf("append didn't apply: %q", got)
	}

	ur := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"action": "revert"}))
	if ur.Status != "success" {
		t.Fatalf("undo failed: %s", ur.Error)
	}
	if got, _ := os.ReadFile(p); string(got) != "line1\n" {
		t.Fatalf("undo should restore pre-append content, got %q", got)
	}
}

func TestUndoList(t *testing.T) {
	cfg := testConfig(t)
	os.WriteFile(filepath.Join(cfg.RootDir, "f.txt"), []byte("a\n"), 0644)
	NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"path": "f.txt", "old_string": "a", "new_string": "b"}))

	lr := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"action": "list"}))
	if lr.Status != "success" {
		t.Fatalf("list failed: %s", lr.Error)
	}
	if !strings.Contains(lr.Output, "f.txt") || !strings.Contains(lr.Output, "edit") {
		t.Fatalf("list should mention the edit, got: %q", lr.Output)
	}
}

func TestUndoEmptyList(t *testing.T) {
	cfg := testConfig(t)
	lr := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{}))
	if lr.Status != "success" || !strings.Contains(lr.Output, "No snapshots") {
		t.Fatalf("expected empty list message, got status=%s output=%q", lr.Status, lr.Output)
	}
}

func TestUndoRevertNothing(t *testing.T) {
	cfg := testConfig(t)
	ur := NewUndoTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"action": "revert"}))
	if ur.Status != "error" {
		t.Fatalf("expected error reverting with no snapshots, got %s", ur.Status)
	}
}
