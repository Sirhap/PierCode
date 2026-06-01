package tool

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMoveTool(t *testing.T) {
	t.Run("renames a file", func(t *testing.T) {
		cfg := testConfig(t)
		os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte("hi"), 0644)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "a.txt", "to": "b.txt"}))
		if res.Status != "success" {
			t.Fatalf("move failed: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, "a.txt")); !os.IsNotExist(err) {
			t.Fatal("source should be gone")
		}
		if got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "b.txt")); string(got) != "hi" {
			t.Fatalf("dest content wrong: %q", got)
		}
	})

	t.Run("creates destination subdir", func(t *testing.T) {
		cfg := testConfig(t)
		os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte("hi"), 0644)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "a.txt", "to": "sub/dir/b.txt"}))
		if res.Status != "success" {
			t.Fatalf("move failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "sub/dir/b.txt")); string(got) != "hi" {
			t.Fatalf("dest content wrong: %q", got)
		}
	})

	t.Run("refuses to overwrite without flag", func(t *testing.T) {
		cfg := testConfig(t)
		os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte("a"), 0644)
		os.WriteFile(filepath.Join(cfg.RootDir, "b.txt"), []byte("b"), 0644)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "a.txt", "to": "b.txt"}))
		if res.Status != "error" {
			t.Fatalf("expected error, got %s", res.Status)
		}
		if got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "b.txt")); string(got) != "b" {
			t.Fatalf("dest must be untouched, got %q", got)
		}
	})

	t.Run("overwrite=true replaces", func(t *testing.T) {
		cfg := testConfig(t)
		os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte("a"), 0644)
		os.WriteFile(filepath.Join(cfg.RootDir, "b.txt"), []byte("b"), 0644)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "a.txt", "to": "b.txt", "overwrite": true}))
		if res.Status != "success" {
			t.Fatalf("move failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "b.txt")); string(got) != "a" {
			t.Fatalf("expected overwrite, got %q", got)
		}
	})

	t.Run("blocks traversal on from", func(t *testing.T) {
		cfg := testConfig(t)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "../escape.txt", "to": "x.txt"}))
		if res.Status != "error" {
			t.Fatalf("expected error, got %s", res.Status)
		}
	})

	t.Run("blocks traversal on to", func(t *testing.T) {
		cfg := testConfig(t)
		os.WriteFile(filepath.Join(cfg.RootDir, "a.txt"), []byte("a"), 0644)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "a.txt", "to": "../escape.txt"}))
		if res.Status != "error" {
			t.Fatalf("expected error, got %s", res.Status)
		}
	})

	t.Run("missing source errors", func(t *testing.T) {
		cfg := testConfig(t)
		res := NewMoveTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"from": "nope.txt", "to": "x.txt"}))
		if res.Status != "error" {
			t.Fatalf("expected error, got %s", res.Status)
		}
	})
}
