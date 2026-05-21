package tool

import (
	"errors"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncate(t *testing.T) {
	t.Run("short output not truncated", func(t *testing.T) {
		out, truncated := Truncate("hello")
		if truncated {
			t.Error("expected not truncated")
		}
		if out != "hello" {
			t.Errorf("got %q", out)
		}
	})

	t.Run("many lines triggers truncation", func(t *testing.T) {
		lines := strings.Repeat("line\n", MaxLines+10)
		out, truncated := Truncate(lines)
		if !truncated {
			t.Error("expected truncated")
		}
		if !strings.Contains(out, "截断") {
			t.Error("expected truncation hint in output")
		}
	})

	t.Run("large bytes triggers truncation", func(t *testing.T) {
		big := strings.Repeat("x", MaxBytes+1)
		_, truncated := Truncate(big)
		if !truncated {
			t.Error("expected truncated")
		}
	})

	t.Run("large multibyte output keeps valid UTF-8", func(t *testing.T) {
		big := strings.Repeat("中", MaxBytes)
		out, truncated := Truncate(big)
		if !truncated {
			t.Fatal("expected truncated")
		}
		preview := out
		if idx := strings.Index(preview, "\n\n..."); idx >= 0 {
			preview = preview[:idx]
		}
		if !utf8.ValidString(preview) {
			t.Fatalf("preview is not valid UTF-8")
		}
	})

	t.Run("save failure is reported instead of returning a fake path", func(t *testing.T) {
		oldWriteFile := truncateWriteFile
		truncateWriteFile = func(string, []byte, os.FileMode) error {
			return errors.New("disk full")
		}
		t.Cleanup(func() {
			truncateWriteFile = oldWriteFile
		})

		out, truncated := Truncate(strings.Repeat("x", MaxBytes+1))
		if !truncated {
			t.Fatal("expected truncated")
		}
		if !strings.Contains(out, "完整内容保存失败") || !strings.Contains(out, "disk full") {
			t.Fatalf("expected save failure in hint, got %q", out)
		}
		if strings.Contains(out, "完整内容保存至") {
			t.Fatalf("must not return a saved-file hint on write failure: %q", out)
		}
	})
}
