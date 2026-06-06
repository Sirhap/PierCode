package tool

import (
	"strings"
	"testing"
)

func TestEnrichErrorMessage(t *testing.T) {
	cases := []struct {
		name     string
		tool     string
		raw      string
		wantHint string // substring expected in the Hint line; "" means no hint added
	}{
		{"validation failed", "edit", "validation failed: path is required", "tool_help"},
		{"is required", "write_file", "path is required", "tool_help"},
		{"unknown param", "tool_help", "unknown parameter \"name\"", "tool_help"},
		{"missing file", "read_file", "open foo.go: no such file or directory", "list_dir or glob"},
		{"sandbox escape", "write_file", "path escapes the workspace root", "outside the workspace sandbox"},
		{"permission", "write_file", "open /etc/x: permission denied", "writable"},
		{"is a directory", "read_file", "read foo: is a directory", "directory"},
		{"dangerous cmd", "exec_cmd", "command blocked by security policy", "blocked by the security policy"},
		{"empty stays empty", "edit", "   ", ""},
		{"unknown error no hint", "edit", "some opaque failure", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EnrichErrorMessage(tc.tool, tc.raw)
			if tc.wantHint == "" {
				if strings.Contains(got, "Hint:") {
					t.Fatalf("expected no hint, got %q", got)
				}
				return
			}
			if !strings.Contains(got, "Hint:") || !strings.Contains(got, tc.wantHint) {
				t.Fatalf("expected hint %q, got %q", tc.wantHint, got)
			}
			// Original message must be preserved verbatim ahead of the hint.
			if !strings.HasPrefix(got, strings.TrimSpace(tc.raw)) {
				t.Fatalf("original message not preserved: %q", got)
			}
		})
	}
}

func TestEnrichErrorMessageNoDoubleHint(t *testing.T) {
	// Messages that already guide the AI must not get a second hint stacked on.
	already := []string{
		"Could not find old_string in the file. It must match exactly, including whitespace.",
		"Found multiple matches. Provide more surrounding context to make the match unique, or set replace_all=true.",
		"tool \"reed_file\" not found. Did you mean: read_file?",
		"memory file would exceed 24576 bytes; use mode=overwrite to compact.",
	}
	for _, msg := range already {
		got := EnrichErrorMessage("edit", msg)
		if strings.Contains(got, "Hint:") {
			t.Fatalf("should not add hint to already-guided message: %q", got)
		}
	}
}
