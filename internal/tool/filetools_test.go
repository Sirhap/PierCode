package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/sirhap/piercode/internal/types"
)

func testConfig(t *testing.T) *types.Config {
	t.Helper()
	return &types.Config{RootDir: t.TempDir(), Timeout: 10}
}

func testCtx(cfg *types.Config, args map[string]interface{}) *Context {
	return &Context{Args: args, Config: cfg}
}

func TestWriteReadFile(t *testing.T) {
	cfg := testConfig(t)

	t.Run("write then read", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)

		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "hello.txt", "content": "world"}))
		if res.Status != "success" {
			t.Fatalf("write failed: %s", res.Error)
		}

		res = r.Execute(testCtx(cfg, map[string]interface{}{"path": "hello.txt"}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		if !strings.Contains(res.Output, "world") {
			t.Errorf("expected 'world' in output, got %q", res.Output)
		}
	})

	t.Run("write creates parent dirs", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "sub/dir/file.txt", "content": "hi"}))
		if res.Status != "success" {
			t.Fatalf("write failed: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, "sub/dir/file.txt")); err != nil {
			t.Error("file not created")
		}
	})

	t.Run("write_file does not stop stream", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "nostop.txt", "content": "ok"}))
		if res.StopStream {
			t.Fatal("write_file should not force StopStream")
		}
	})

	t.Run("write append mode", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt", "content": "line1\n"}))
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt", "content": "line2\n", "mode": "append"}))

		r := NewReadFileTool(cfg)
		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "append.txt"}))
		if !strings.Contains(res.Output, "line1") || !strings.Contains(res.Output, "line2") {
			t.Errorf("expected both lines, got %q", res.Output)
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		res := w.Execute(testCtx(cfg, map[string]interface{}{"path": "../outside.txt", "content": "x"}))
		if res.Status != "error" {
			t.Error("expected error for path traversal")
		}
	})

	t.Run("read prefixes cat -n style line numbers by default", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "numbered.txt", "content": "alpha\nbeta\ngamma"}))

		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "numbered.txt"}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		want := "     1\talpha\n     2\tbeta\n     3\tgamma"
		if res.Output != want {
			t.Errorf("expected %q, got %q", want, res.Output)
		}
	})

	t.Run("line_numbers=false returns plain text", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "plain.txt", "content": "x\ny"}))

		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "plain.txt", "line_numbers": false}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		if res.Output != "x\ny" {
			t.Errorf("expected plain text without numbers, got %q", res.Output)
		}
	})

	t.Run("offset shifts line numbers", func(t *testing.T) {
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "offset.txt", "content": "a\nb\nc\nd"}))

		res := r.Execute(testCtx(cfg, map[string]interface{}{"path": "offset.txt", "offset": float64(3)}))
		if res.Status != "success" {
			t.Fatalf("read failed: %s", res.Error)
		}
		want := "     3\tc\n     4\td"
		if res.Output != want {
			t.Errorf("expected %q, got %q", want, res.Output)
		}
	})

	t.Run("long single line beyond default scanner buffer", func(t *testing.T) {
		// A minified bundle / JSON-on-one-line easily exceeds bufio's default
		// 64KB token limit. Without an enlarged Buffer this used to fail with
		// bufio.ErrTooLong — scanner.Err() would surface and the user got
		// `error` status with nothing useful. After the fix scanner can read
		// up to 1MB lines, and the read_file 50KB output cap is applied per
		// line-prefix so the user still sees the start of the long line.
		w := NewWriteFileTool(cfg)
		r := NewReadFileTool(cfg)
		long := strings.Repeat("x", 200*1024) // 200 KB on one line
		w.Execute(testCtx(cfg, map[string]interface{}{"path": "long.txt", "content": long}))

		res := r.Execute(testCtx(cfg, map[string]interface{}{
			"path":         "long.txt",
			"line_numbers": false,
		}))
		if res.Status != "success" {
			t.Fatalf("expected success (no scanner error) for 200KB single line, got %s (%s)",
				res.Status, res.Error)
		}
		if !strings.Contains(res.Output, strings.Repeat("x", 1000)) {
			t.Errorf("expected at least 1000 chars of the long line to survive, got %d bytes of output", len(res.Output))
		}
		if !strings.Contains(res.Output, "[truncated") {
			tail := res.Output
			if len(tail) > 200 {
				tail = tail[len(tail)-200:]
			}
			t.Errorf("expected truncation hint for 200KB single line, got %q", tail)
		}
	})
}

func TestAdditionalAllowedDirsForAbsoluteFileTools(t *testing.T) {
	cfg := testConfig(t)
	extra := t.TempDir()
	cfg.AdditionalAllowedDirs = []string{extra}
	target := filepath.Join(extra, "outside.txt")

	w := NewWriteFileTool(cfg)
	res := w.Execute(testCtx(cfg, map[string]interface{}{"path": target, "content": "from extra root"}))
	if res.Status != "success" {
		t.Fatalf("write into additional allowed dir failed: %s", res.Error)
	}

	r := NewReadFileTool(cfg)
	res = r.Execute(testCtx(cfg, map[string]interface{}{"path": target, "line_numbers": false}))
	if res.Status != "success" {
		t.Fatalf("read from additional allowed dir failed: %s", res.Error)
	}
	if res.Output != "from extra root" {
		t.Fatalf("unexpected read output: %q", res.Output)
	}

	blocked := filepath.Join(t.TempDir(), "blocked.txt")
	res = w.Execute(testCtx(cfg, map[string]interface{}{"path": blocked, "content": "nope"}))
	if res.Status != "error" {
		t.Fatal("expected absolute path outside allowed roots to be blocked")
	}
}

func TestPermissionModesForAbsoluteFileTools(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "project")
	sibling := filepath.Join(parent, "sibling")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sibling, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := &types.Config{RootDir: root, InitialRootDir: root, Timeout: 10}
	w := NewWriteFileTool(cfg)

	siblingTarget := filepath.Join(sibling, "auto.txt")
	res := w.Execute(testCtx(cfg, map[string]interface{}{"path": siblingTarget, "content": "blocked"}))
	if res.Status != "error" {
		t.Fatalf("default mode should block sibling path, got %s", res.Status)
	}

	cfg.PermissionMode = "auto"
	res = w.Execute(testCtx(cfg, map[string]interface{}{"path": siblingTarget, "content": "auto"}))
	if res.Status != "success" {
		t.Fatalf("auto mode should allow sibling path: %s", res.Error)
	}

	outsideTarget := filepath.Join(t.TempDir(), "unrestricted.txt")
	res = w.Execute(testCtx(cfg, map[string]interface{}{"path": outsideTarget, "content": "still blocked"}))
	if res.Status != "error" {
		t.Fatalf("auto mode should still block unrelated path, got %s", res.Status)
	}

	cfg.PermissionMode = "unrestricted"
	res = w.Execute(testCtx(cfg, map[string]interface{}{"path": outsideTarget, "content": "unrestricted"}))
	if res.Status != "success" {
		t.Fatalf("unrestricted mode should allow unrelated path: %s", res.Error)
	}
}

func TestGlobTool(t *testing.T) {
	cfg := testConfig(t)
	os.WriteFile(filepath.Join(cfg.RootDir, "a.go"), []byte(""), 0644)
	os.WriteFile(filepath.Join(cfg.RootDir, "b.go"), []byte(""), 0644)
	os.WriteFile(filepath.Join(cfg.RootDir, "c.txt"), []byte(""), 0644)
	if err := os.MkdirAll(filepath.Join(cfg.RootDir, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(cfg.RootDir, "sub", "nested.go"), []byte(""), 0644)

	g := NewGlobTool(cfg)

	t.Run("matches go files", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "*.go"}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "a.go") || !strings.Contains(res.Output, "b.go") {
			t.Errorf("expected go files, got %q", res.Output)
		}
		if strings.Contains(res.Output, "c.txt") {
			t.Error("should not match txt file")
		}
		if strings.Contains(res.Output, "nested.go") {
			t.Error("non-recursive glob should not match nested go files")
		}
	})

	t.Run("no match returns no files found", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "*.rs"}))
		if res.Output != "No files found" {
			t.Errorf("got %q", res.Output)
		}
	})
}

func TestGrepTool(t *testing.T) {
	cfg := testConfig(t)
	os.WriteFile(filepath.Join(cfg.RootDir, "main.go"), []byte("package main\nfunc main() {}\n"), 0644)

	g := NewGrepTool(cfg)

	t.Run("finds pattern", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "func main"}))
		if res.Status != "success" {
			t.Fatal(res.Error)
		}
		if !strings.Contains(res.Output, "func main") {
			t.Errorf("expected match, got %q", res.Output)
		}
	})

	t.Run("no match", func(t *testing.T) {
		res := g.Execute(testCtx(cfg, map[string]interface{}{"pattern": "notexist"}))
		if res.Output != "No matches found" {
			t.Errorf("got %q", res.Output)
		}
	})

	t.Run("include filter with path separator blocked", func(t *testing.T) {
		g2 := NewGrepTool(cfg)
		err := g2.Validate(map[string]interface{}{"pattern": "x", "include": "../*.go"})
		if err == nil {
			t.Error("expected error for include with path separator")
		}
	})
}

func TestEditTool(t *testing.T) {
	cfg := testConfig(t)

	t.Run("replaces string in file", func(t *testing.T) {
		path := filepath.Join(cfg.RootDir, "edit.txt")
		os.WriteFile(path, []byte("hello world"), 0644)

		e := NewEditTool(cfg)
		res := e.Execute(testCtx(cfg, map[string]interface{}{
			"path": "edit.txt", "old_string": "world", "new_string": "go",
		}))
		if res.Status != "success" {
			t.Fatalf("edit failed: %s", res.Error)
		}
		got, _ := os.ReadFile(path)
		if string(got) != "hello go" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("old_string not found returns error", func(t *testing.T) {
		os.WriteFile(filepath.Join(cfg.RootDir, "nope.txt"), []byte("abc"), 0644)
		e := NewEditTool(cfg)
		res := e.Execute(testCtx(cfg, map[string]interface{}{
			"path": "nope.txt", "old_string": "xyz", "new_string": "q",
		}))
		if res.Status != "error" {
			t.Error("expected error")
		}
	})
}

// TestReadFileTruncationRespectsUTF8 verifies that when a single very long
// line is truncated to fit the MaxBytes budget, the cut lands on a UTF-8 rune
// boundary instead of slicing through a CJK or emoji byte sequence.
func TestReadFileTruncationRespectsUTF8(t *testing.T) {
	cfg := testConfig(t)

	// Build a single-line payload whose byte length comfortably exceeds
	// MaxBytes. The line is "中" (3 bytes) repeated — every prefix that ends
	// mid-rune is invalid UTF-8, so any byte-level cut has a 2/3 chance of
	// producing a malformed string under the old code.
	const rune3byte = "中"      // e4 b8 ad
	const lineRepeats = 25_000 // 25k repeats → ~75 KB, beyond 50 KB MaxBytes
	payload := strings.Repeat(rune3byte, lineRepeats)
	if err := os.WriteFile(filepath.Join(cfg.RootDir, "wide.txt"), []byte(payload), 0644); err != nil {
		t.Fatal(err)
	}

	r := NewReadFileTool(cfg)
	res := r.Execute(testCtx(cfg, map[string]interface{}{
		"path":         "wide.txt",
		"line_numbers": false,
	}))
	if res.Status != "success" {
		t.Fatalf("read failed: %s", res.Error)
	}

	// Strip the truncation marker the tool appends so we only validate the
	// actual file content portion.
	body := res.Output
	if idx := strings.Index(body, "\n[truncated"); idx >= 0 {
		body = body[:idx]
	}
	if !strings.HasPrefix(body, rune3byte+rune3byte) {
		preview := body
		if len(preview) > 20 {
			preview = preview[:20]
		}
		t.Errorf("expected truncated body to start with valid CJK runes, got %q…", preview)
	}
	if !utf8.ValidString(body) {
		t.Fatalf("truncated body is not valid UTF-8 (len=%d)", len(body))
	}
}

func TestGlobGrepExcludeDirs(t *testing.T) {
	cfg := testConfig(t)
	root := cfg.RootDir
	// 正常文件
	mustWrite(t, filepath.Join(root, "main.go"), "package main // needle")
	// 应被排除的目录
	for _, dir := range []string{"node_modules", ".git", "dist", ".idea"} {
		sub := filepath.Join(root, dir)
		if err := os.MkdirAll(sub, 0755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, filepath.Join(sub, "junk.go"), "package x // needle")
	}

	t.Run("glob skips excluded dirs", func(t *testing.T) {
		res := NewGlobTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"pattern": "**/*.go"}))
		if res.Status != "success" {
			t.Fatalf("glob failed: %s", res.Error)
		}
		if !strings.Contains(res.Output, "main.go") {
			t.Fatalf("expected main.go, got %q", res.Output)
		}
		for _, bad := range []string{"node_modules", "/.git/", "dist", ".idea"} {
			if strings.Contains(res.Output, bad) {
				t.Fatalf("excluded dir leaked into glob output: %q in %q", bad, res.Output)
			}
		}
	})

	t.Run("grep native skips excluded dirs", func(t *testing.T) {
		// 直接测 native 路径, 不依赖系统是否装了 rg
		out, err := grepNative("needle", root, "")
		if err != nil {
			t.Fatalf("grepNative failed: %v", err)
		}
		if !strings.Contains(out, "main.go") {
			t.Fatalf("expected main.go match, got %q", out)
		}
		for _, bad := range []string{"node_modules", "/.git/", "dist", ".idea"} {
			if strings.Contains(out, bad) {
				t.Fatalf("excluded dir leaked into grep output: %q in %q", bad, out)
			}
		}
	})
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestGrepInvalidPatternErrors(t *testing.T) {
	cfg := testConfig(t)
	mustWrite(t, filepath.Join(cfg.RootDir, "a.txt"), "hello")
	// 无效正则: 缺右括号。rg(exit 2) 与 native 都应报错, 不再静默返回无匹配。
	res := NewGrepTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"pattern": "("}))
	if res.Status != "error" {
		t.Fatalf("invalid regex should error, got status=%s output=%q", res.Status, res.Output)
	}
}
