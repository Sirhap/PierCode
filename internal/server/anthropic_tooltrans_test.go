package server

import (
	"strings"
	"testing"
)

func TestBuildToolProtocolPreamble(t *testing.T) {
	if got := buildToolProtocolPreamble(nil); got != "" {
		t.Fatalf("no tools should give empty preamble, got %q", got)
	}
	tools := []anthropicToolDef{{Name: "Read"}, {Name: "Bash"}}
	got := buildToolProtocolPreamble(tools)
	for _, want := range []string{"Read", "Bash", toolCallFence, `"tool"`, "input"} {
		if !strings.Contains(got, want) {
			t.Fatalf("preamble missing %q\n%s", want, got)
		}
	}
}

func TestParseToolCallsFenced(t *testing.T) {
	text := "I'll read it.\n\n```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	calls, lead, found := parseToolCalls(text)
	if !found {
		t.Fatal("expected a tool call")
	}
	if lead != "I'll read it." {
		t.Fatalf("leading text = %q", lead)
	}
	if len(calls) != 1 || calls[0].Name != "Read" {
		t.Fatalf("calls = %+v", calls)
	}
	if calls[0].Input["file_path"] != "go.mod" {
		t.Fatalf("input = %+v", calls[0].Input)
	}
}

func TestParseToolCallsMultiple(t *testing.T) {
	text := "```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"a\"}}\n```\n" +
		"```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"b\"}}\n```"
	calls, _, found := parseToolCalls(text)
	if !found || len(calls) != 2 {
		t.Fatalf("expected 2 calls, got %d found=%v", len(calls), found)
	}
	if calls[1].Input["file_path"] != "b" {
		t.Fatalf("second call input = %+v", calls[1].Input)
	}
}

func TestParseToolCallsBareJSON(t *testing.T) {
	// No fence; page emitted a bare object (with a nested brace to test the
	// balanced scanner).
	text := `Sure: {"tool":"Edit","input":{"file_path":"x","replacements":{"a":"b"}}}`
	calls, lead, found := parseToolCalls(text)
	if !found || len(calls) != 1 || calls[0].Name != "Edit" {
		t.Fatalf("bare JSON not recovered: %+v found=%v", calls, found)
	}
	if lead != "Sure:" {
		t.Fatalf("leading text = %q", lead)
	}
}

func TestParseToolCallsNone(t *testing.T) {
	if _, _, found := parseToolCalls("just a normal chat reply, no tools here"); found {
		t.Fatal("should not find a tool call in plain prose")
	}
	// A code block that is not our fence must not be mistaken for a call.
	if _, _, found := parseToolCalls("```python\nprint(1)\n```"); found {
		t.Fatal("ordinary code fence should not parse as a tool call")
	}
}

func TestParseToolCallsRejectsMissingName(t *testing.T) {
	text := "```" + toolCallFence + "\n{\"input\":{\"file_path\":\"x\"}}\n```"
	if _, _, found := parseToolCalls(text); found {
		t.Fatal("a block with no tool name must not count as a call")
	}
}

func TestMatchingBrace(t *testing.T) {
	// A "}" inside a string literal must not close the object early.
	s := `{"a":"}","b":{"c":1}}`
	end := matchingBrace(s, 0)
	if end != len(s)-1 {
		t.Fatalf("matchingBrace = %d, want %d (string-aware)", end, len(s)-1)
	}
}
