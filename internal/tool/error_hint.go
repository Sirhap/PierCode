package tool

import (
	"fmt"
	"strings"
)

// EnrichErrorMessage augments a raw tool error with a short, actionable hint so
// the AI can self-correct instead of repeating the same failing call. It is a
// best-effort layer applied by the executor at the error boundary: it never
// changes the meaning of the original message, only appends a "Hint:" line when
// a known failure pattern is recognized and the message does not already carry
// guidance.
//
// toolName is the failing tool's name (may be empty). raw is result.Error.
func EnrichErrorMessage(toolName, raw string) string {
	msg := strings.TrimSpace(raw)
	if msg == "" {
		return msg
	}
	// Don't double-hint: many tool errors already spell out the fix.
	if strings.Contains(msg, "Hint:") || hasInlineGuidance(msg) {
		return msg
	}
	hint := hintFor(toolName, msg)
	if hint == "" {
		return msg
	}
	return msg + "\nHint: " + hint
}

// hasInlineGuidance reports whether the message already tells the AI what to do,
// so we don't pile a redundant second instruction on top of it.
func hasInlineGuidance(msg string) bool {
	lower := strings.ToLower(msg)
	for _, marker := range []string{
		"tool_help", "use tool_help", "did you mean",
		"provide more surrounding context", "set replace_all",
		"must match exactly", "use mode=overwrite",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func hintFor(toolName, msg string) string {
	lower := strings.ToLower(msg)

	// Validation failures: the parameter shape is wrong. Point at tool_help.
	if strings.HasPrefix(lower, "validation failed") || strings.Contains(lower, "is required") ||
		strings.Contains(lower, "must be a") || strings.Contains(lower, "unknown parameter") {
		if toolName != "" {
			return fmt.Sprintf("Call tool_help with {\"tool\":\"%s\"} to see the required parameters and call format.", toolName)
		}
		return "Call tool_help with {\"tool\":\"<name>\"} to see the required parameters."
	}

	// Filesystem: missing path.
	if strings.Contains(lower, "no such file") || strings.Contains(lower, "does not exist") ||
		strings.Contains(lower, "cannot find the file") {
		return "Verify the path with list_dir or glob first; paths are relative to the workspace root."
	}

	// Filesystem: sandbox / permission.
	if strings.Contains(lower, "outside") && strings.Contains(lower, "root") ||
		strings.Contains(lower, "escapes") || strings.Contains(lower, "sandbox") {
		return "The path is outside the workspace sandbox. Use a path inside the workspace root."
	}
	if strings.Contains(lower, "permission denied") {
		return "Permission denied. Check the file is writable, or pick a different path inside the workspace."
	}

	// Read-before-edit discipline.
	if strings.Contains(lower, "could not find old_string") {
		return "read_file the target first and copy the exact text (including indentation) into old_string."
	}

	// Dangerous / blocked command.
	if strings.Contains(lower, "dangerous") || strings.Contains(lower, "blocked") || strings.Contains(lower, "not allowed") {
		return "This command is blocked by the security policy. Use a safer equivalent or a dedicated tool (e.g. read_file/glob instead of cat/find)."
	}

	// Is a directory where a file was expected.
	if strings.Contains(lower, "is a directory") {
		return "Target is a directory. Use list_dir to inspect it, or point the tool at a file."
	}

	return ""
}
