package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPromptIsActiveByDefault(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	if !model.inputMode {
		t.Fatalf("expected prompt to be active by default")
	}
}

func TestEnterCreatesTranscriptTurn(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.input = "你好"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("expected enter to submit prompt")
	}
	updated := next.(Model)
	if len(updated.turns) != 1 {
		t.Fatalf("expected one turn, got %d", len(updated.turns))
	}
	if updated.turns[0].UserText != "你好" {
		t.Fatalf("expected user text in turn, got %q", updated.turns[0].UserText)
	}
	if !updated.inputMode {
		t.Fatalf("expected prompt to remain active after submit")
	}
	if updated.input != "" {
		t.Fatalf("expected prompt to clear after submit, got %q", updated.input)
	}
}

func TestAIStreamUpdatesAssistantBlockInLatestTurn(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.recordUserPrompt("解释一下")

	next, _ := model.Update(LogMsg{Key: "ai-1", Source: "ai", Status: "info", Message: "第一段"})
	model = next.(Model)
	next, _ = model.Update(LogMsg{Key: "ai-1", Source: "ai", Status: "info", Message: "第一段\n第二段"})
	model = next.(Model)

	if len(model.turns) != 1 {
		t.Fatalf("expected one turn, got %d", len(model.turns))
	}
	if !strings.Contains(model.turns[0].AssistantText, "第二段") {
		t.Fatalf("expected assistant stream to update latest turn, got %q", model.turns[0].AssistantText)
	}
}

func TestToolLogNestsUnderLatestTurn(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.recordUserPrompt("跑测试")

	next, _ := model.Update(LogMsg{
		Key:      "tool-1",
		Source:   "ai",
		ToolName: "exec_cmd",
		Status:   "success",
		Message:  "Ran go test ./internal/tui\nok",
	})
	model = next.(Model)

	if len(model.turns) != 1 || len(model.turns[0].Tools) != 1 {
		t.Fatalf("expected one nested tool, got %#v", model.turns)
	}
	if model.turns[0].Tools[0].Name != "exec_cmd" {
		t.Fatalf("expected exec_cmd tool, got %q", model.turns[0].Tools[0].Name)
	}
	view := model.renderTranscript(100, 20)
	if !strings.Contains(view, "openlink> 跑测试") || !strings.Contains(view, "tool exec_cmd") {
		t.Fatalf("expected transcript to group prompt and tool, got %q", view)
	}
}

func TestSlashLogsTogglesRawLogMode(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24
	model.input = "/logs"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /logs to be local")
	}
	updated := next.(Model)
	if !updated.logsMode {
		t.Fatalf("expected raw log mode after /logs")
	}
	if !strings.Contains(updated.View(), "MODE LOGS") {
		t.Fatalf("expected status strip to show log mode")
	}
}
