package tool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyPatchTool(t *testing.T) {
	t.Run("updates existing file", func(t *testing.T) {
		cfg := testConfig(t)
		if err := os.WriteFile(filepath.Join(cfg.RootDir, "main.go"), []byte("package main\n\nfunc main() {\n\tprintln(\"old\")\n}\n"), 0644); err != nil {
			t.Fatal(err)
		}

		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: main.go",
				"@@",
				" func main() {",
				"-\tprintln(\"old\")",
				"+\tprintln(\"new\")",
				" }",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "main.go"))
		if !strings.Contains(string(got), `println("new")`) || strings.Contains(string(got), `println("old")`) {
			t.Fatalf("unexpected file content:\n%s", got)
		}
	})

	t.Run("adds and deletes files", func(t *testing.T) {
		cfg := testConfig(t)
		if err := os.WriteFile(filepath.Join(cfg.RootDir, "old.txt"), []byte("remove me\n"), 0644); err != nil {
			t.Fatal(err)
		}

		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Add File: new.txt",
				"+hello",
				"+world",
				"*** Delete File: old.txt",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		got, _ := os.ReadFile(filepath.Join(cfg.RootDir, "new.txt"))
		if string(got) != "hello\nworld\n" {
			t.Fatalf("unexpected new file content: %q", got)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, "old.txt")); !os.IsNotExist(err) {
			t.Fatalf("expected old file to be deleted, stat err=%v", err)
		}
	})

	t.Run("fails atomically when one hunk does not apply", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "atomic.txt")
		if err := os.WriteFile(path, []byte("one\ntwo\nthree\n"), 0644); err != nil {
			t.Fatal(err)
		}

		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: atomic.txt",
				"@@",
				"-two",
				"+TWO",
				"@@",
				"-missing",
				"+MISSING",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" {
			t.Fatalf("expected apply_patch error, got %s (%s)", res.Status, res.Output)
		}
		got, _ := os.ReadFile(path)
		if string(got) != "one\ntwo\nthree\n" {
			t.Fatalf("file should not be partially written:\n%s", got)
		}
	})

	t.Run("blocks path traversal", func(t *testing.T) {
		cfg := testConfig(t)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Add File: ../escape.txt",
				"+nope",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" {
			t.Fatalf("expected traversal to fail, got %s", res.Status)
		}
	})

	t.Run("dry run does not write files", func(t *testing.T) {
		cfg := testConfig(t)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"dry_run": true,
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Add File: dry.txt",
				"+hello",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("dry run failed: %s", res.Error)
		}
		if _, err := os.Stat(filepath.Join(cfg.RootDir, "dry.txt")); !os.IsNotExist(err) {
			t.Fatalf("dry run should not create file, stat err=%v", err)
		}
		if !strings.Contains(res.Output, "dry run") {
			t.Fatalf("expected dry run summary, got %q", res.Output)
		}
	})

	// Regression: hunk matching must be anchored to whole lines. Previously the
	// matcher used raw substring search on newline-joined text, so a context line
	// like "lo" could match the tail of an earlier line ("hel|lo") and corrupt
	// the wrong location, especially for the final line of a file with no
	// trailing newline.
	t.Run("anchors hunks to line boundaries (no trailing newline)", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "f.txt")
		if err := os.WriteFile(path, []byte("hello\nlo"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: f.txt",
				"@@",
				"-lo",
				"+LO",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		got, _ := os.ReadFile(path)
		if string(got) != "hello\nLO" {
			t.Fatalf("expected only the final line changed, got %q", got)
		}
	})

	t.Run("does not match a context line inside a longer word", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "w.txt")
		if err := os.WriteFile(path, []byte("config\nother"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: w.txt",
				"@@",
				"-con",
				"+REPLACED",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" {
			got, _ := os.ReadFile(path)
			t.Fatalf("expected error (no whole-line match), got %s with content %q", res.Status, got)
		}
		got, _ := os.ReadFile(path)
		if string(got) != "config\nother" {
			t.Fatalf("file must be untouched on no match, got %q", got)
		}
	})

	t.Run("preserves trailing newline state", func(t *testing.T) {
		cfg := testConfig(t)
		// File WITH trailing newline stays terminated; file WITHOUT stays bare.
		withNL := filepath.Join(cfg.RootDir, "withnl.txt")
		bare := filepath.Join(cfg.RootDir, "bare.txt")
		if err := os.WriteFile(withNL, []byte("a\nb\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(bare, []byte("a\nb"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: withnl.txt",
				"@@",
				"-b",
				"+B",
				"*** Update File: bare.txt",
				"@@",
				"-b",
				"+B",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(withNL); string(got) != "a\nB\n" {
			t.Fatalf("withnl: expected trailing newline preserved, got %q", got)
		}
		if got, _ := os.ReadFile(bare); string(got) != "a\nB" {
			t.Fatalf("bare: expected no trailing newline, got %q", got)
		}
	})

	t.Run("ambiguous whole-line match is rejected", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "dup.txt")
		if err := os.WriteFile(path, []byte("x\nx\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: dup.txt",
				"@@",
				"-x",
				"+Y",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" || !strings.Contains(res.Error, "ambiguous") {
			t.Fatalf("expected ambiguous error, got %s (%s)", res.Status, res.Error)
		}
	})

	// Regression: a multi-file patch must not leave a half-written tree if a later
	// operation fails. Here the second op deletes a nonexistent file, which fails
	// during planning, so the first file's update must never be written.
	t.Run("rolls back earlier files when a later op fails", func(t *testing.T) {
		cfg := testConfig(t)
		first := filepath.Join(cfg.RootDir, "first.txt")
		if err := os.WriteFile(first, []byte("keep\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: first.txt",
				"@@",
				"-keep",
				"+CHANGED",
				"*** Delete File: missing.txt",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" {
			t.Fatalf("expected error from deleting missing file, got %s", res.Status)
		}
		if got, _ := os.ReadFile(first); string(got) != "keep\n" {
			t.Fatalf("first.txt must be unchanged after failed patch, got %q", got)
		}
	})

	t.Run("multi-line hunk replaces a contiguous block", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "block.txt")
		if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: block.txt",
				"@@",
				" one",
				"-two",
				"-three",
				"+TWO",
				" four",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(path); string(got) != "one\nTWO\nfour\n" {
			t.Fatalf("unexpected block replacement: %q", got)
		}
	})
}

func TestSplitJoinContentLinesRoundTrip(t *testing.T) {
	cases := []string{"", "\n", "a", "a\n", "a\nb", "a\nb\n", "\na\n", "a\n\nb\n"}
	for _, in := range cases {
		lines, nl := splitContentLines(in)
		if got := joinContentLines(lines, nl); got != in {
			t.Errorf("round trip failed for %q: got %q (lines=%v nl=%v)", in, got, lines, nl)
		}
	}
}
