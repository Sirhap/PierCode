package tool

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReplace(t *testing.T) {
	t.Run("exact match replace once", func(t *testing.T) {
		got, count, err := replace("hello world", "world", "go", false)
		if err != nil || got != "hello go" || count != 1 {
			t.Errorf("got %q count=%d err %v", got, count, err)
		}
	})

	t.Run("replace all occurrences", func(t *testing.T) {
		got, count, err := replace("a a a", "a", "b", true)
		if err != nil || got != "b b b" {
			t.Errorf("got %q err %v", got, err)
		}
		if count != 3 {
			t.Errorf("expected count=3, got %d", count)
		}
	})

	t.Run("old_string not found returns error", func(t *testing.T) {
		_, _, err := replace("hello", "missing", "x", false)
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("curly quotes normalize and replace", func(t *testing.T) {
		content := "const msg = \"hello\";"
		// old_string uses curly quotes “ ”
		old := "const msg = “hello”;"
		got, count, err := replace(content, old, "const msg = \"bye\";", false)
		if err != nil {
			t.Fatalf("curly-quote old_string should match ascii content, got %v", err)
		}
		if count != 1 || got != "const msg = \"bye\";" {
			t.Errorf("got %q count=%d", got, count)
		}
	})

	t.Run("en/em dash and apostrophe normalize", func(t *testing.T) {
		content := "x = a - b; // it's fine"
		// old_string uses em dash — and curly apostrophe ’
		old := "x = a — b; // it’s fine"
		got, _, err := replace(content, old, "y = a - b;", false)
		if err != nil {
			t.Fatalf("dash/apostrophe old_string should match ascii content, got %v", err)
		}
		if got != "y = a - b;" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("crlf normalized match", func(t *testing.T) {
		content := normalizeLineEndings("a\r\nb")
		_, _, err := replace(content, "a\nb", "x", false)
		if err != nil {
			t.Errorf("expected crlf-normalized match to succeed, got %v", err)
		}
	})

	t.Run("whitespace-trimmed line match", func(t *testing.T) {
		got, _, err := replace("  hello\n  world\n", "hello\nworld", "hi\nthere", false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got == "" {
			t.Error("expected non-empty result")
		}
	})

	t.Run("identical old and new returns error", func(t *testing.T) {
		_, _, err := replace("hello", "hello", "hello", false)
		if err == nil {
			t.Error("expected error for identical strings")
		}
	})

	t.Run("multiple matches returns error", func(t *testing.T) {
		_, _, err := replace("foo foo", "foo", "bar", false)
		if err == nil {
			t.Error("expected error for multiple matches")
		}
	})

	t.Run("indentation flexible match", func(t *testing.T) {
		content := "func main() {\n\t\tfmt.Println(\"hello\")\n\t}"
		find := "func main() {\n\tfmt.Println(\"hello\")\n}"
		_, _, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("IndentationFlexibleReplacer should match, got %v", err)
		}
	})

	t.Run("escape normalized match", func(t *testing.T) {
		content := "line1\nline2\nline3"
		find := "line1\\nline2\\nline3"
		_, _, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("EscapeNormalizedReplacer should match, got %v", err)
		}
	})

	t.Run("trimmed boundary match", func(t *testing.T) {
		content := "  hello world  "
		find := "  hello world  \n"
		_, _, err := replace(content, find, "replaced", false)
		if err != nil {
			t.Errorf("TrimmedBoundaryReplacer should match, got %v", err)
		}
	})

	t.Run("block anchor rejects unrelated single candidate", func(t *testing.T) {
		content := strings.Join([]string{
			"func target() {",
			"return safeValue",
			"}",
		}, "\n")
		find := strings.Join([]string{
			"func target() {",
			"deleteEverything()",
			"}",
		}, "\n")
		_, _, err := replace(content, find, "replaced", false)
		if err == nil {
			t.Fatal("expected unrelated block anchor candidate to be rejected")
		}
	})

	t.Run("block anchor rejects low-similarity multi-candidate", func(t *testing.T) {
		// Two functions share the same first/last line shape; under the old
		// 0.3 threshold BlockAnchorReplacer would pick one and silently
		// overwrite it even though the body the AI wrote does not match
		// either. The tightened threshold should reject the match.
		content := strings.Join([]string{
			"func handler() {",
			"    logRequest()",
			"    return ok",
			"}",
			"",
			"func handler() {",
			"    persistOrder()",
			"    return err",
			"}",
		}, "\n")
		find := strings.Join([]string{
			"func handler() {",
			"    unrelatedAction()",
			"    return nil",
			"}",
		}, "\n")
		_, _, err := replace(content, find, "replaced", false)
		if err == nil {
			t.Fatal("expected low-similarity multi-candidate to be rejected")
		}
	})

	t.Run("replace_all returns count", func(t *testing.T) {
		_, count, err := replace("foo bar foo baz foo", "foo", "qux", true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if count != 3 {
			t.Errorf("expected count=3, got %d", count)
		}
	})

	t.Run("replace_all replaces all line-trimmed matches", func(t *testing.T) {
		content := strings.Join([]string{
			"  hello",
			"  world",
			"",
			"\thello",
			"\tworld",
		}, "\n")
		got, count, err := replace(content, "hello\nworld", "done", true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if count != 2 {
			t.Fatalf("expected count=2, got %d", count)
		}
		if got != "done\n\ndone" {
			t.Fatalf("unexpected replacement:\n%s", got)
		}
	})

	t.Run("replace_all dedupes overlapping fuzzy spans", func(t *testing.T) {
		content := "hello world"
		searches := []string{"hello world", "hello"}
		spans := collectReplacementSpans(content, searches)
		if len(spans) != 1 {
			t.Fatalf("expected one non-overlapping span, got %#v", spans)
		}
		got := applyReplacementSpans(content, spans, "done")
		if got != "done" {
			t.Fatalf("unexpected replacement: %q", got)
		}
	})
}

func TestLevenshteinSimilarityUsesRuneLength(t *testing.T) {
	a := "删除订单状态"
	b := "保留订单状态"
	dist := levenshtein(a, b)
	byteLen := len(a)
	if len(b) > byteLen {
		byteLen = len(b)
	}
	byteSimilarity := 1 - float64(dist)/float64(byteLen)
	runeSimilarity := lineSimilarity(a, b)
	if byteSimilarity < singleCandidateSimilarityThreshold {
		t.Fatalf("test setup should demonstrate the old byte-length bug, got %.3f", byteSimilarity)
	}
	if runeSimilarity >= singleCandidateSimilarityThreshold {
		t.Fatalf("rune-length similarity should reject unrelated CJK lines: %.3f", runeSimilarity)
	}
}

func TestEditPreservesCRLFLineEndings(t *testing.T) {
	// Files authored on Windows arrive as CRLF. replace() works on
	// LF-normalized content, but the on-disk file must keep its original
	// endings — otherwise a single edit would silently rewrite every line of
	// the file (huge git diff churn, broken Windows tooling).
	cfg := testConfig(t)
	path := filepath.Join(cfg.RootDir, "crlf.txt")
	original := []byte("line one\r\nline two\r\nline three\r\n")
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatal(err)
	}

	e := NewEditTool(cfg)
	res := e.Execute(testCtx(cfg, map[string]interface{}{
		"path": "crlf.txt", "old_string": "line two", "new_string": "LINE TWO",
	}))
	if res.Status != "success" {
		t.Fatalf("edit failed: %s", res.Error)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("line one\r\nLINE TWO\r\nline three\r\n")
	if !bytes.Equal(got, want) {
		t.Errorf("CRLF endings not preserved.\n got: %q\nwant: %q", got, want)
	}
}

func TestEditPreservesLFLineEndings(t *testing.T) {
	cfg := testConfig(t)
	path := filepath.Join(cfg.RootDir, "lf.txt")
	original := []byte("a\nb\nc\n")
	if err := os.WriteFile(path, original, 0644); err != nil {
		t.Fatal(err)
	}
	e := NewEditTool(cfg)
	res := e.Execute(testCtx(cfg, map[string]interface{}{
		"path": "lf.txt", "old_string": "b", "new_string": "B",
	}))
	if res.Status != "success" {
		t.Fatalf("edit failed: %s", res.Error)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("a\nB\nc\n")
	if !bytes.Equal(got, want) {
		t.Errorf("LF file should not gain CR.\n got: %q\nwant: %q", got, want)
	}
}

func TestEditDryRunDoesNotWrite(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "dry.txt")
	original := []byte("line one\nline two\nline three\n")
	if err := os.WriteFile(p, original, 0644); err != nil {
		t.Fatal(err)
	}

	res := NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "dry.txt", "old_string": "line two", "new_string": "LINE TWO", "dry_run": true,
	}))
	if res.Status != "success" {
		t.Fatalf("dry_run edit should succeed: %s", res.Error)
	}
	// File must be byte-identical on disk.
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("dry_run must not modify the file.\n got: %q\nwant: %q", got, original)
	}
	// Output must report the would-be change and mark it as a dry run.
	if !strings.Contains(res.Output, "dry run") {
		t.Fatalf("expected dry-run marker in output, got %q", res.Output)
	}
	if !strings.Contains(res.Output, "LINE TWO") {
		t.Fatalf("expected the change to be reported, got %q", res.Output)
	}
}

func TestEditDryRunFalseStillWrites(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "wet.txt")
	if err := os.WriteFile(p, []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	res := NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "wet.txt", "old_string": "b", "new_string": "B", "dry_run": false,
	}))
	if res.Status != "success" {
		t.Fatalf("edit failed: %s", res.Error)
	}
	if got, _ := os.ReadFile(p); string(got) != "a\nB\nc\n" {
		t.Fatalf("dry_run=false must write as before, got %q", got)
	}
	if strings.Contains(res.Output, "dry run") {
		t.Fatalf("non-dry-run output must not carry the dry-run marker, got %q", res.Output)
	}
}

func TestEditDryRunReportsErrorWithoutWriting(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "nomatch.txt")
	original := []byte("only this\n")
	if err := os.WriteFile(p, original, 0644); err != nil {
		t.Fatal(err)
	}
	res := NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "nomatch.txt", "old_string": "MISSING", "new_string": "X", "dry_run": true,
	}))
	if res.Status != "error" {
		t.Fatalf("expected error for unmatched old_string, got %s", res.Status)
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, original) {
		t.Fatalf("dry_run error must not modify the file, got %q", got)
	}
}

func TestEditCRLFReplaceAllCount(t *testing.T) {
	cfg := testConfig(t)
	p := filepath.Join(cfg.RootDir, "c.txt")
	// CRLF 文件, "x" 出现 3 次
	if err := os.WriteFile(p, []byte("x\r\ny\r\nx\r\nx\r\n"), 0644); err != nil {
		t.Fatal(err)
	}
	res := NewEditTool(cfg).Execute(testCtx(cfg, map[string]interface{}{
		"path": "c.txt", "old_string": "x", "new_string": "Z", "replace_all": true,
	}))
	if res.Status != "success" {
		t.Fatalf("edit failed: %s", res.Error)
	}
	got, _ := os.ReadFile(p)
	if string(got) != "Z\r\ny\r\nZ\r\nZ\r\n" {
		t.Fatalf("CRLF replaceAll wrong content: %q", got)
	}
	// 报告应为 3 处, 来自实际写入运行
	if !strings.Contains(res.Output, "3") {
		t.Fatalf("expected count 3 in output, got %q", res.Output)
	}
}
