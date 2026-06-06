package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveMemoryPath(t *testing.T) {
	root := t.TempDir()

	// SafePath resolves symlinks (e.g. /tmp -> /private/tmp on macOS), so derive
	// the expected path the same way rather than from the raw TempDir.
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	projectWant := filepath.Join(resolvedRoot, ".piercode", "memory.md")
	for _, scope := range []string{"", "project", "PROJECT", " Project "} {
		got, err := ResolveMemoryPath(root, scope)
		if err != nil {
			t.Fatalf("scope %q: %v", scope, err)
		}
		if got != projectWant {
			t.Fatalf("scope %q: got %q want %q", scope, got, projectWant)
		}
	}

	got, gerr := ResolveMemoryPath(root, "global")
	if gerr != nil {
		t.Fatal(gerr)
	}
	home, _ := os.UserHomeDir()
	if want := filepath.Join(home, ".piercode", "memory.md"); got != want {
		t.Fatalf("global: got %q want %q", got, want)
	}

	if _, err := ResolveMemoryPath(root, "bogus"); err == nil {
		t.Fatal("expected error for unknown scope")
	}
	if _, err := ResolveMemoryPath("", "project"); err == nil {
		t.Fatal("expected error for project scope without root")
	}
}

func TestCheckAppendSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory.md")

	// Missing file counts as size 0.
	if err := CheckAppendSize(path, MemoryMaxBytes); err != nil {
		t.Fatalf("at-limit on empty file should pass: %v", err)
	}
	if err := CheckAppendSize(path, MemoryMaxBytes+1); err == nil {
		t.Fatal("over-limit on empty file should fail")
	}

	if err := os.WriteFile(path, make([]byte, MemoryMaxBytes-10), 0644); err != nil {
		t.Fatal(err)
	}
	if err := CheckAppendSize(path, 10); err != nil {
		t.Fatalf("exact fit should pass: %v", err)
	}
	if err := CheckAppendSize(path, 11); err == nil {
		t.Fatal("one byte over should fail")
	}
}

func TestAppendMemoryDocFraming(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, ".piercode")
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "memory.md"), []byte("prefer tabs"), 0644); err != nil {
		t.Fatal(err)
	}

	out := AppendMemoryDoc("BASE", root)
	if !strings.HasPrefix(out, "BASE") {
		t.Fatal("base prompt must come first")
	}
	if !strings.Contains(out, "## PierCode Memory") {
		t.Fatal("memory section header missing")
	}
	if !strings.Contains(out, "not higher-priority instructions") {
		t.Fatal("anti-injection framing missing")
	}
	if !strings.Contains(out, "prefer tabs") {
		t.Fatal("project memory body missing")
	}
}

func TestAppendMemoryDocNoProjectSection(t *testing.T) {
	// Empty project root: a "Project memory" section must never appear. (Global
	// memory may exist on the test host's real home, so we don't assert on it.)
	out := AppendMemoryDoc("BASE", filepath.Join(t.TempDir(), "no-such"))
	if strings.Contains(out, "### Project memory") {
		t.Fatal("should not add project memory section when no project memory exists")
	}
}

func TestReadMemoryFileTruncates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory.md")
	if err := os.WriteFile(path, make([]byte, MemoryMaxBytes+100), 0644); err != nil {
		t.Fatal(err)
	}
	body := readMemoryFile(path)
	if !strings.Contains(body, "[truncated:") {
		t.Fatal("oversized file should be truncated with marker")
	}
}
