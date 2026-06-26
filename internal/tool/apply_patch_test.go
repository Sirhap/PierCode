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

	// A patch authored with LF context lines must apply cleanly to a CRLF file
	// and preserve the CRLF endings on write.
	t.Run("applies to a CRLF file and preserves CRLF endings", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "crlf.txt")
		if err := os.WriteFile(path, []byte("alpha\r\nbeta\r\ngamma\r\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: crlf.txt",
				"@@",
				" alpha",
				"-beta",
				"+BETA",
				" gamma",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("apply_patch failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(path); string(got) != "alpha\r\nBETA\r\ngamma\r\n" {
			t.Fatalf("CRLF endings not preserved: %q", got)
		}
	})

	t.Run("allows a blank separator after a hunk body", func(t *testing.T) {
		cfg := testConfig(t)
		path := filepath.Join(cfg.RootDir, "separator.txt")
		if err := os.WriteFile(path, []byte("old\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: separator.txt",
				"@@",
				"-old",
				"+new",
				"",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("blank separator after hunk should be accepted: %s", res.Error)
		}
		if got, _ := os.ReadFile(path); string(got) != "new\n" {
			t.Fatalf("unexpected content after separator patch: %q", got)
		}
	})
}

// TestCommitPlansRollsBackOnRuntimeFailure exercises the in-call rollback path
// (a later plan fails AFTER earlier plans wrote to disk) — distinct from the
// planning-failure cases, which abort before commitPlans ever runs. An earlier
// updated file must be restored to its original bytes, and an earlier created
// file must be removed, when a subsequent plan's write fails.
func TestCommitPlansRollsBackOnRuntimeFailure(t *testing.T) {
	dir := t.TempDir()

	// Plan 1: update an existing file (rollback = restore original content).
	existing := filepath.Join(dir, "existing.txt")
	if err := os.WriteFile(existing, []byte("ORIGINAL"), 0644); err != nil {
		t.Fatal(err)
	}
	// Plan 2: create a brand-new file (rollback = remove it).
	newFile := filepath.Join(dir, "created.txt")

	// Plan 3: make its parent a REGULAR FILE so os.MkdirAll(filepath.Dir(...))
	// fails at commit time — a deterministic runtime failure with no monkey-patching.
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	doomed := filepath.Join(blocker, "child.txt") // parent "blocker" is a file → MkdirAll fails

	plans := []patchPlan{
		{absPath: existing, content: "MODIFIED", mode: 0644},
		{absPath: newFile, content: "NEW", mode: 0644},
		{absPath: doomed, content: "WONT", mode: 0644},
	}

	err := commitPlans(plans)
	if err == nil {
		t.Fatal("expected commitPlans to fail on the unwritable third plan")
	}

	// Plan 1 must be restored to its original bytes.
	got, readErr := os.ReadFile(existing)
	if readErr != nil {
		t.Fatalf("existing file should still be present after rollback: %v", readErr)
	}
	if string(got) != "ORIGINAL" {
		t.Errorf("rollback did not restore plan-1 file: got %q, want %q", got, "ORIGINAL")
	}

	// Plan 2 (newly created) must be removed by rollback.
	if _, statErr := os.Stat(newFile); !os.IsNotExist(statErr) {
		t.Errorf("rollback should have removed the created plan-2 file %s (stat err: %v)", newFile, statErr)
	}
}

func TestSplitJoinContentLinesRoundTrip(t *testing.T) {
	cases := []string{
		// LF / no-newline
		"", "\n", "a", "a\n", "a\nb", "a\nb\n", "\na\n", "a\n\nb\n",
		// CRLF — must round-trip exactly (endings preserved)
		"a\r\n", "a\r\nb\r\n", "a\r\nb", "\r\na\r\n",
	}
	for _, in := range cases {
		lines, style := splitContentLines(in)
		if got := joinContentLines(lines, style); got != in {
			t.Errorf("round trip failed for %q: got %q (lines=%v style=%+v)", in, got, lines, style)
		}
	}
}

func TestDetectCRLF(t *testing.T) {
	crlf := []string{"a\r\n", "a\r\nb\r\n", "a\r\nb"}
	lf := []string{"", "a", "a\n", "a\nb\n", "a\r\nb\n" /* mixed → LF */}
	for _, s := range crlf {
		if !detectCRLF(s) {
			t.Errorf("detectCRLF(%q) = false, want true", s)
		}
	}
	for _, s := range lf {
		if detectCRLF(s) {
			t.Errorf("detectCRLF(%q) = true, want false", s)
		}
	}
}

// A file that is LF-dominant but has a stray CRLF line counts as LF
// (detectCRLF == false). Patching an unrelated, LF-terminated line must leave
// the untouched CRLF line's \r intact — earlier the whole file was rebuilt from
// \r-stripped lines and rejoined with \n, silently stripping the \r.
func TestApplyPatchPreservesUntouchedCRLFInMixedFile(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "mixed.txt")
	// LF-dominant file (detectCRLF==false) with a stray CRLF line ("two\r\n")
	// that sits OUTSIDE the hunk's matched region, so it is genuinely untouched.
	// The patch edits "four" → "FOUR", far from "two".
	original := "one\ntwo\r\nthree\nfour\nfive\n"
	if err := os.WriteFile(p, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"patch": strings.Join([]string{
			"*** Begin Patch",
			"*** Update File: mixed.txt",
			"@@",
			" three",
			"-four",
			"+FOUR",
			" five",
			"*** End Patch",
		}, "\n"),
	}))
	if res.Status != "success" {
		t.Fatalf("apply_patch failed: %s", res.Error)
	}
	got, _ := os.ReadFile(p)
	// The untouched "two\r\n" (outside the hunk) must keep its \r; only the
	// edited region around four→FOUR changes.
	if string(got) != "one\ntwo\r\nthree\nFOUR\nfive\n" {
		t.Fatalf("untouched CRLF line not preserved: got %q", got)
	}
}

func TestApplyPatchFuzzyIndentFallback(t *testing.T) {
	t.Run("matches despite indentation difference", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.go")
		// 文件用 tab 缩进
		os.WriteFile(p, []byte("func f() {\n\treturn 1\n}\n"), 0644)
		// 补丁上下文用空格缩进(模型常见偏差)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: f.go",
				"@@",
				"    return 1",
				"+\t// added",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("fuzzy fallback should succeed: %s", res.Error)
		}
		got, _ := os.ReadFile(p)
		if !strings.Contains(string(got), "// added") {
			t.Fatalf("expected added line, got %q", got)
		}
	})

	t.Run("preserves unchanged context indentation when matching fuzzily", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "nested.go")
		if err := os.WriteFile(p, []byte("func f() {\n\tif ok {\n\t\treturn 1\n\t}\n}\n"), 0644); err != nil {
			t.Fatal(err)
		}
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch",
				"*** Update File: nested.go",
				"@@",
				"    if ok {",
				"-        return 1",
				"+\t\treturn 2",
				"    }",
				"*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("fuzzy fallback should succeed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "func f() {\n\tif ok {\n\t\treturn 2\n\t}\n}\n" {
			t.Fatalf("unchanged context indentation should be preserved, got %q", got)
		}
	})

	t.Run("rejects ambiguous trimmed match", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		// "x" 两处, 缩进不同但 trim 后都等于 "x"
		os.WriteFile(p, []byte("\tx\n    x\n"), 0644)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch", "*** Update File: f.txt", "@@", "x", "+y", "*** End Patch",
			}, "\n"),
		}))
		if res.Status != "error" {
			t.Fatalf("ambiguous trimmed match should fail, got %s", res.Status)
		}
	})

	t.Run("exact match still preferred and unaffected", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("alpha\nbeta\n"), 0644)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": strings.Join([]string{
				"*** Begin Patch", "*** Update File: f.txt", "@@", "-beta", "+BETA", "*** End Patch",
			}, "\n"),
		}))
		if res.Status != "success" {
			t.Fatalf("exact match failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "alpha\nBETA\n" {
			t.Fatalf("unexpected: %q", got)
		}
	})
}

func TestApplyPatchFinalNewline(t *testing.T) {
	patchFor := func(file string) string {
		return strings.Join([]string{
			"*** Begin Patch", "*** Update File: " + file, "@@", "-b", "+B", "*** End Patch",
		}, "\n")
	}

	t.Run("add ensures trailing newline", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("a\nb"), 0644) // 无尾换行
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": patchFor("f.txt"), "final_newline": "add",
		}))
		if res.Status != "success" {
			t.Fatalf("failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "a\nB\n" {
			t.Fatalf("expected trailing newline added, got %q", got)
		}
	})

	t.Run("strip removes trailing newline", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("a\nb\n"), 0644) // 有尾换行
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": patchFor("f.txt"), "final_newline": "strip",
		}))
		if res.Status != "success" {
			t.Fatalf("failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "a\nB" {
			t.Fatalf("expected trailing newline stripped, got %q", got)
		}
	})

	t.Run("keep is default and preserves state", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "f.txt")
		os.WriteFile(p, []byte("a\nb"), 0644)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": patchFor("f.txt"),
		}))
		if res.Status != "success" {
			t.Fatalf("failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "a\nB" {
			t.Fatalf("keep should preserve no-newline, got %q", got)
		}
	})

	t.Run("add uses CRLF for CRLF files", func(t *testing.T) {
		cfg := testConfig(t)
		p := filepath.Join(cfg.RootDir, "c.txt")
		os.WriteFile(p, []byte("a\r\nb"), 0644)
		res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
			"patch": patchFor("c.txt"), "final_newline": "add",
		}))
		if res.Status != "success" {
			t.Fatalf("failed: %s", res.Error)
		}
		if got, _ := os.ReadFile(p); string(got) != "a\r\nB\r\n" {
			t.Fatalf("expected CRLF trailing newline, got %q", got)
		}
	})

	t.Run("invalid final_newline rejected", func(t *testing.T) {
		cfg := testConfig(t)
		err := NewApplyPatchTool(cfg).Validate(map[string]interface{}{
			"patch": "*** Begin Patch\n*** End Patch", "final_newline": "bogus",
		})
		if err == nil {
			t.Fatal("expected validation error")
		}
	})
}

func TestApplyPatchSupportsAdditionalAllowedDir(t *testing.T) {
	cfg := testConfig(t)
	extra := t.TempDir()
	cfg.AdditionalAllowedDirs = []string{extra}
	target := filepath.Join(extra, "patched.txt")

	patch := strings.Join([]string{
		"*** Begin Patch",
		"*** Add File: " + target,
		"+hello from patch",
		"*** End Patch",
	}, "\n")
	res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"patch": patch}))
	if res.Status != "success" {
		t.Fatalf("apply_patch into additional allowed dir failed: %s", res.Error)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "hello from patch\n" {
		t.Fatalf("unexpected file content: %q", raw)
	}
}

func TestApplyPatchPermissionModes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "project")
	sibling := filepath.Join(parent, "sibling")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sibling, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.RootDir = root
	cfg.InitialRootDir = root
	target := filepath.Join(sibling, "patched-auto.txt")
	patch := strings.Join([]string{
		"*** Begin Patch",
		"*** Add File: " + target,
		"+auto patch",
		"*** End Patch",
	}, "\n")

	res := NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"patch": patch}))
	if res.Status != "error" {
		t.Fatalf("default mode should block sibling apply_patch, got %s", res.Status)
	}

	cfg.PermissionMode = "auto"
	res = NewApplyPatchTool(cfg).Execute(testCtx(cfg, map[string]interface{}{"patch": patch}))
	if res.Status != "success" {
		t.Fatalf("auto mode should allow sibling apply_patch: %s", res.Error)
	}
}
