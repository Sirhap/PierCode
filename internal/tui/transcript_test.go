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

func TestLateAIStreamUpdateStaysOnOriginalTurn(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.applyLogToTranscript(LogEntry{Key: "user-1", Source: "user", Message: "第一个问题"})
	model.applyLogToTranscript(LogEntry{Key: "ai-1", Source: "ai", Message: "第一段"})
	model.applyLogToTranscript(LogEntry{Key: "user-2", Source: "user", Message: "第二个问题"})
	model.applyLogToTranscript(LogEntry{Key: "ai-2", Source: "ai", Message: "第二个回答"})

	model.applyLogToTranscript(LogEntry{Key: "ai-1", Source: "ai", Message: "第一段\n补充"})

	if len(model.turns) != 2 {
		t.Fatalf("expected two turns, got %d", len(model.turns))
	}
	if !strings.Contains(model.turns[0].AssistantText, "补充") {
		t.Fatalf("expected late chunk to update first turn, got %#v", model.turns)
	}
	if model.turns[1].AssistantText != "第二个回答" {
		t.Fatalf("expected second turn to stay unchanged, got %q", model.turns[1].AssistantText)
	}
}

func TestLateToolUpdateStaysOnOriginalTurn(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.applyLogToTranscript(LogEntry{Key: "user-1", Source: "user", Message: "第一个问题"})
	model.applyLogToTranscript(LogEntry{Key: "tool-1", Source: "ai", ToolName: "exec_cmd", Status: "pending", Message: "running"})
	model.applyLogToTranscript(LogEntry{Key: "user-2", Source: "user", Message: "第二个问题"})

	model.applyLogToTranscript(LogEntry{Key: "tool-1", Source: "ai", ToolName: "exec_cmd", Status: "success", Message: "done"})

	if len(model.turns) != 2 {
		t.Fatalf("expected two turns, got %d", len(model.turns))
	}
	if len(model.turns[0].Tools) != 1 || model.turns[0].Tools[0].Message != "done" {
		t.Fatalf("expected late tool update on first turn, got %#v", model.turns)
	}
	if len(model.turns[1].Tools) != 0 {
		t.Fatalf("expected second turn to stay tool-free, got %#v", model.turns[1].Tools)
	}
}

func TestRepeatedBrowserPromptsWithDifferentKeysCreateSeparateTurns(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.applyLogToTranscript(LogEntry{Key: "user-1", Source: "user", Message: "continue"})
	model.applyLogToTranscript(LogEntry{Key: "user-2", Source: "user", Message: "continue"})

	if len(model.turns) != 2 {
		t.Fatalf("expected duplicate text with different keys to create two turns, got %d", len(model.turns))
	}
}

func TestBrowserEchoAdoptsLocalTurnWithoutDuplicatingIt(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.recordUserPrompt("continue")

	model.applyLogToTranscript(LogEntry{Key: "user-1", Source: "user", Message: "continue"})

	if len(model.turns) != 1 {
		t.Fatalf("expected browser echo to reuse local turn, got %d", len(model.turns))
	}
	if model.turns[0].UserKey != "user-1" {
		t.Fatalf("expected browser key to bind local turn, got %q", model.turns[0].UserKey)
	}
}

func TestAssistantMarkdownRendersReadableBlocks(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.recordUserPrompt("给个示例")

	next, _ := model.Update(LogMsg{
		Key:     "ai-md",
		Source:  "ai",
		Status:  "info",
		Message: "# 标题\n\n- 第一项\n> 引用\n```go\nfmt.Println(\"hi\")\n```",
	})
	model = next.(Model)

	view := model.renderTranscript(100)
	for _, want := range []string{"标题", "• 第一项", "│ 引用", "``` code go", "│ fmt.Println"} {
		if !strings.Contains(view, want) {
			t.Fatalf("expected markdown render to contain %q, got %q", want, view)
		}
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
	view := model.renderTranscript(100)
	if !strings.Contains(view, "piercode> 跑测试") || !strings.Contains(view, "tool exec_cmd") {
		t.Fatalf("expected transcript to group prompt and tool, got %q", view)
	}
}

func TestToolResponsePromptCollapsesInTranscript(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	model.applyLogToTranscript(LogEntry{
		Key:    "user-tool-response",
		Source: "user",
		Message: strings.Join([]string{
			"### list_dir #k9x2n",
			"cli/",
			"server/",
			"",
			"[系统提示] 请记住你是 PierCode，严格遵循工具调用规范，不要忘记自己的身份和指令。",
			"",
			"### list_dir #m4b7p",
			"executor/",
			"portutil/",
			"procutil/",
			"prompt/",
			"security/",
			"server/",
			"skill/",
			"tool/",
			"tui/",
			"types/",
			"",
			"[系统提示] 请记住你是 PierCode，严格遵循工具调用规范，不要忘记自己的身份和指令。",
		}, "\n"),
	})

	view := model.renderTranscript(100)
	for _, want := range []string{
		"工具响应 list_dir #k9x2n … +2 lines",
		"工具响应 list_dir #m4b7p … +10 lines",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("expected compact tool response %q, got %q", want, view)
		}
	}
	for _, hidden := range []string{"executor/", "portutil/", "[系统提示]", "### list_dir"} {
		if strings.Contains(view, hidden) {
			t.Fatalf("expected tool response details to be hidden (%q), got %q", hidden, view)
		}
	}
	if model.turns[0].UserText == "" || !strings.Contains(model.turns[0].UserText, "executor/") {
		t.Fatalf("expected original user text to remain stored, got %#v", model.turns[0])
	}
}

func TestCtrlTExpandsToolResponsePrompt(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24
	model.applyLogToTranscript(LogEntry{
		Key:    "user-tool-response",
		Source: "user",
		Message: strings.Join([]string{
			"### list_dir #m4b7p",
			"executor/",
			"portutil/",
			"procutil/",
			"prompt/",
			"security/",
			"server/",
			"skill/",
			"tool/",
			"tui/",
			"types/",
			"",
			"[系统提示] 请记住你是 PierCode，严格遵循工具调用规范，不要忘记自己的身份和指令。",
		}, "\n"),
	})

	collapsed := model.renderTranscript(100)
	if strings.Contains(collapsed, "executor/") {
		t.Fatalf("expected summary before Ctrl+T, got %q", collapsed)
	}

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	if cmd != nil {
		t.Fatalf("expected Ctrl+T to be local")
	}
	view := next.(Model).renderTranscript(100)
	for _, want := range []string{"### list_dir #m4b7p", "executor/", "types/", "Ctrl+T 返回摘要"} {
		if !strings.Contains(view, want) {
			t.Fatalf("expected expanded tool response to contain %q, got %q", want, view)
		}
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

func TestInputModePageKeysScrollTranscript(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 16
	model.inputMode = true
	model.recordUserPrompt("解释滚动")

	next, _ := model.Update(LogMsg{
		Key:    "ai-long",
		Source: "ai",
		Status: "info",
		Message: strings.Join([]string{
			"line-01", "line-02", "line-03", "line-04", "line-05",
			"line-06", "line-07", "line-08", "line-09", "line-10",
			"line-11", "line-12", "line-13", "line-14", "line-15",
		}, "\n"),
	})
	model = next.(Model)
	maxOffset := model.transcriptMaxOffset()
	if maxOffset == 0 {
		t.Fatalf("expected transcript to overflow")
	}

	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	model = next.(Model)
	if model.transcriptOffset < 0 || model.transcriptOffset >= maxOffset {
		t.Fatalf("expected pgup to scroll up from bottom, got offset %d max %d", model.transcriptOffset, maxOffset)
	}
	if !model.inputMode {
		t.Fatalf("expected input mode to remain active")
	}

	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	model = next.(Model)
	if model.transcriptOffset != -1 {
		t.Fatalf("expected pgdown to return to bottom, got %d", model.transcriptOffset)
	}
}

func TestTranscriptScrollsFromBottomWithWheelAndArrow(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 16
	model.recordUserPrompt("解释滚轮")

	next, _ := model.Update(LogMsg{
		Key:    "ai-long",
		Source: "ai",
		Status: "info",
		Message: strings.Join([]string{
			"line-01", "line-02", "line-03", "line-04", "line-05",
			"line-06", "line-07", "line-08", "line-09", "line-10",
			"line-11", "line-12", "line-13", "line-14", "line-15",
		}, "\n"),
	})
	model = next.(Model)
	maxOffset := model.transcriptMaxOffset()
	if maxOffset == 0 {
		t.Fatalf("expected transcript to overflow")
	}

	next, _ = model.Update(tea.MouseMsg{Type: tea.MouseWheelUp})
	model = next.(Model)
	if model.transcriptOffset < 0 || model.transcriptOffset >= maxOffset {
		t.Fatalf("expected wheel up to scroll up from bottom, got offset %d max %d", model.transcriptOffset, maxOffset)
	}

	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyEscape})
	model = next.(Model)
	model.transcriptOffset = -1
	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyUp})
	model = next.(Model)
	if model.transcriptOffset < 0 || model.transcriptOffset >= maxOffset {
		t.Fatalf("expected arrow up outside input to scroll up from bottom, got offset %d max %d", model.transcriptOffset, maxOffset)
	}
}

func TestStreamingKeepsManualTranscriptScrollPosition(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 16
	model.recordUserPrompt("解释滚动")

	next, _ := model.Update(LogMsg{
		Key:    "ai-long",
		Source: "ai",
		Status: "info",
		Message: strings.Join([]string{
			"line-01", "line-02", "line-03", "line-04", "line-05",
			"line-06", "line-07", "line-08", "line-09", "line-10",
			"line-11", "line-12", "line-13", "line-14", "line-15",
		}, "\n"),
	})
	model = next.(Model)
	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	model = next.(Model)
	offset := model.transcriptOffset
	if offset < 0 {
		t.Fatalf("expected manual scroll position before streaming update")
	}

	next, _ = model.Update(LogMsg{
		Key:     "ai-long",
		Source:  "ai",
		Status:  "info",
		Message: strings.Join([]string{"line-01", "line-02", "line-03", "line-04", "line-05", "line-06", "line-07", "line-08", "line-09", "line-10", "line-11", "line-12", "line-13", "line-14", "line-15", "line-16"}, "\n"),
	})
	model = next.(Model)

	if model.transcriptOffset != offset {
		t.Fatalf("expected manual offset %d to be preserved, got %d", offset, model.transcriptOffset)
	}
}
