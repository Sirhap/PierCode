package tui

import (
	"testing"
)

func TestFormatTranscriptToolLineFallsBackToStatus(t *testing.T) {
	line := formatTranscriptToolLine("exec_cmd", "success", "")
	if line != "tool[exec_cmd] success: success" {
		t.Fatalf("expected status fallback, got %q", line)
	}
}
