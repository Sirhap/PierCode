package tui

import (
	"testing"
)

func TestAssistantDeltaUsesSuffixForPrefixUpdates(t *testing.T) {
	delta := assistantPrintDelta("hello", "hello world")
	if delta != " world" {
		t.Fatalf("expected suffix delta, got %q", delta)
	}
}

func TestAssistantDeltaMarksNonPrefixUpdates(t *testing.T) {
	delta := assistantPrintDelta("hello world", "rewritten")
	if delta != "[updated]\nrewritten" {
		t.Fatalf("expected updated block, got %q", delta)
	}
}
