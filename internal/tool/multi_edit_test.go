package tool

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMultiEditTool(t *testing.T) {
	t.Run("applies edits in order atomically", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("alpha\nbeta\ngamma\n"), 0644)
		res := NewMultiEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"path": "f.txt",
			"edits": []interface{}{
				map[string]interface{}{"old_string": "alpha", "new_string": "A"},
				map[string]interface{}{"old_string": "gamma", "new_string": "G"},
			},
		}))
		if res.Status != "success" {
			t.Fatalf("multi_edit failed: %s", res.Error)
		}
		got, _ := os.ReadFile(p)
		if string(got) != "A\nbeta\nG\n" {
			t.Fatalf("unexpected content: %q", got)
		}
	})

	t.Run("fails atomically when one edit does not match", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("alpha\nbeta\n"), 0644)
		res := NewMultiEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"path": "f.txt",
			"edits": []interface{}{
				map[string]interface{}{"old_string": "alpha", "new_string": "A"},
				map[string]interface{}{"old_string": "MISSING", "new_string": "X"},
			},
		}))
		if res.Status != "error" {
			t.Fatalf("expected error, got %s", res.Status)
		}
		if got, _ := os.ReadFile(p); string(got) != "alpha\nbeta\n" {
			t.Fatalf("file must be unchanged on failure, got %q", got)
		}
	})

	t.Run("replace_all in one edit", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("x x x\n"), 0644)
		res := NewMultiEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"path": "f.txt",
			"edits": []interface{}{
				map[string]interface{}{"old_string": "x", "new_string": "y", "replace_all": true},
			},
		}))
		if res.Status != "success" {
			t.Fatalf("multi_edit failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "y y y\n" {
			t.Fatalf("unexpected: %q", got)
		}
	})

	t.Run("preserves CRLF", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "c.txt")
		os.WriteFile(p, []byte("a\r\nb\r\n"), 0644)
		res := NewMultiEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"path": "c.txt",
			"edits": []interface{}{
				map[string]interface{}{"old_string": "b", "new_string": "B"},
			},
		}))
		if res.Status != "success" {
			t.Fatalf("failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "a\r\nB\r\n" {
			t.Fatalf("CRLF not preserved: %q", got)
		}
	})

	t.Run("rejects empty edits", func(t *testing.T) {
		cfg := testConfig(t)
		err := NewMultiEditTool(cfg).Validate(map[string]interface{}{"path": "f.txt", "edits": []interface{}{}})
		if err == nil {
			t.Fatal("expected validation error for empty edits")
		}
	})
}
