package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestDirectTypingEntersInputMode(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("你")})
	if cmd != nil {
		t.Fatalf("expected no command before enter")
	}

	updated, ok := next.(Model)
	if !ok {
		t.Fatalf("expected Model, got %T", next)
	}
	if !updated.inputMode {
		t.Fatalf("expected input mode")
	}
	if updated.input != "你" {
		t.Fatalf("expected typed rune to seed input, got %q", updated.input)
	}
}

func TestSlashKeySeedsCommandInput(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	if cmd != nil {
		t.Fatalf("expected no command when opening slash input")
	}

	updated := next.(Model)
	if !updated.inputMode {
		t.Fatalf("expected input mode")
	}
	if updated.input != "/" {
		t.Fatalf("expected slash input to be seeded, got %q", updated.input)
	}
}

func TestViewRendersLogoAndStatus(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 30
	model.status = "running"

	view := model.View()
	if !strings.Contains(view, "OpenLink") && !strings.Contains(view, "OPENLINK") {
		t.Fatalf("expected OpenLink branding in view")
	}
	if !strings.Contains(view, "RUNNING") {
		t.Fatalf("expected running status in view")
	}
}

func TestAuthURLIsRenderedCompletely(t *testing.T) {
	token := "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
	authURL := "http://127.0.0.1:39527/auth?token=" + token
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 30

	next, _ := model.Update(LogMsg{
		Source:   "system",
		ToolName: "SYSTEM",
		Status:   "info",
		Message:  "认证 URL: " + authURL,
	})
	updated := next.(Model)
	view := updated.View()

	instructionIdx := strings.Index(view, "请在浏览器扩展中输入此 URL")
	if instructionIdx < 0 {
		t.Fatalf("expected auth URL instruction in dedicated block")
	}
	tokenIdx := strings.Index(view, token[len(token)-12:])
	if tokenIdx < 0 {
		t.Fatalf("expected auth URL token tail to be rendered")
	}
	if instructionIdx > tokenIdx {
		t.Fatalf("expected auth URL instruction before URL")
	}
	if strings.Contains(view, authURL[:30]+"...") {
		t.Fatalf("auth URL should wrap, not ellipsize")
	}
	if strings.Contains(view, "SYSTEM") {
		t.Fatalf("auth URL log metadata should not be rendered")
	}
}

func TestLogEntryRendersMessageWithoutMetadata(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	next, _ := model.Update(LogMsg{
		Source:   "system",
		ToolName: "SYSTEM",
		Status:   "info",
		Message:  "请在浏览器扩展中输入此 URL",
	})
	view := next.(Model).View()

	if !strings.Contains(view, "请在浏览器扩展中输入此 URL") {
		t.Fatalf("expected message in view")
	}
	if strings.Contains(view, "SYS") || strings.Contains(view, "INFO") || strings.Contains(view, "SYSTEM") {
		t.Fatalf("log metadata should not be rendered")
	}
}

func TestSlashCommandSuggestionsAndTabCompletion(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 30
	model.inputMode = true
	model.input = "/c"

	view := model.View()
	if !strings.Contains(view, "/cd <path>") {
		t.Fatalf("expected slash command suggestions, got %q", view)
	}

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyTab})
	if cmd != nil {
		t.Fatalf("expected no command on tab completion")
	}
	updated := next.(Model)
	if updated.input != "/cd " {
		t.Fatalf("expected /cd completion, got %q", updated.input)
	}
}

func TestSlashCwdCommandLogsCurrentDir(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "/cwd"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /cwd to be local")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one log, got %d", len(updated.logs))
	}
	if !strings.Contains(updated.logs[0].Message, "D:\\workspace") {
		t.Fatalf("expected cwd in log, got %q", updated.logs[0].Message)
	}
}

func TestSlashClearCommandClearsActivity(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "/clear"
	model.logs = []LogEntry{{Message: "old activity"}}
	model.logOffset = 0

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /clear to be local")
	}
	updated := next.(Model)
	if updated.inputMode {
		t.Fatalf("expected input mode to close")
	}
	if len(updated.logs) != 0 {
		t.Fatalf("expected logs to be cleared, got %d", len(updated.logs))
	}
}

func TestSlashClearAfterSlashFocusClearsActivity(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.logs = []LogEntry{{Message: "old activity"}}

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/")})
	if cmd != nil {
		t.Fatalf("expected slash focus to be local")
	}
	next, cmd = next.(Model).Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("clear")})
	if cmd != nil {
		t.Fatalf("expected command typing to be local")
	}
	next, cmd = next.(Model).Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /clear to be local")
	}
	updated := next.(Model)
	if len(updated.logs) != 0 {
		t.Fatalf("expected logs to be cleared, got %d", len(updated.logs))
	}
}

func TestRepeatedSlashClearStillClearsActivity(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "/"
	model.logs = []LogEntry{{Message: "old activity"}}

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("/clear")})
	if cmd != nil {
		t.Fatalf("expected repeated slash typing to stay local")
	}
	updated := next.(Model)
	if updated.input != "/clear" {
		t.Fatalf("expected duplicate leading slash to normalize, got %q", updated.input)
	}
	next, cmd = updated.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /clear to be local")
	}
	if len(next.(Model).logs) != 0 {
		t.Fatalf("expected logs to be cleared")
	}
}

func TestBareSlashEnterDoesNotLogHelp(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "/"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected bare slash to be local")
	}
	updated := next.(Model)
	if len(updated.logs) != 0 {
		t.Fatalf("bare slash should not log help, got %d logs", len(updated.logs))
	}
}

func TestExactSlashCommandHidesSuggestions(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 30
	model.inputMode = true
	model.input = "/clear"

	view := model.View()
	if strings.Contains(view, "/cd <path>") || strings.Contains(view, "/help - 显示 TUI 指令") {
		t.Fatalf("exact /clear should not render command suggestion list, got %q", view)
	}
}

func TestSlashURLCommandUsesModelToken(t *testing.T) {
	token := "abc123"
	model := NewModel(39527, "D:\\workspace", "qwen", token)
	model.inputMode = true
	model.input = "/url"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /url to be local")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one log, got %d", len(updated.logs))
	}
	if !strings.Contains(updated.logs[0].Message, "http://127.0.0.1:39527/auth?token="+token) {
		t.Fatalf("expected auth URL in log, got %q", updated.logs[0].Message)
	}
}

func TestCommandHelpTextIsMultiline(t *testing.T) {
	help := commandHelpText()
	if !strings.Contains(help, "\n") {
		t.Fatalf("expected help text to be multiline, got %q", help)
	}
	if strings.Contains(help, " · ") {
		t.Fatalf("help text should not be joined with bullets, got %q", help)
	}
}

func TestInputHintDoesNotRenderShortcutHelp(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24
	model.inputMode = true
	model.input = "hello"

	view := model.View()
	if strings.Contains(view, "Ctrl+U") || strings.Contains(view, "Ctrl+W") || strings.Contains(view, "Enter send") {
		t.Fatalf("shortcut help should not be rendered, got %q", view)
	}
	if strings.Contains(view, "i//") {
		t.Fatalf("focus hint should not render malformed i// text, got %q", view)
	}
	if !strings.Contains(view, "发到浏览器") {
		t.Fatalf("expected concise Chinese input label, got %q", view)
	}
}

func TestComposerWrapsLongInputWithoutEllipsis(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 72
	model.height = 32
	model.inputMode = true
	model.input = "这是一段很长很长的输入内容，用来确认输入框不会省略用户正在输入的文本 TAIL_END"

	view := model.View()
	if !strings.Contains(view, "TAIL_END") {
		t.Fatalf("expected long input tail to remain visible, got %q", view)
	}
	if strings.Contains(view, "这是一段很长很长的输入内容...") {
		t.Fatalf("input should wrap instead of ellipsizing, got %q", view)
	}
}

func TestCtrlEnterAddsNewlineWithoutSubmitting(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "第一行"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	if cmd != nil {
		t.Fatalf("expected newline shortcut to stay local")
	}
	updated := next.(Model)
	if updated.input != "第一行\n" {
		t.Fatalf("expected newline in input, got %q", updated.input)
	}
	if len(updated.logs) != 0 {
		t.Fatalf("newline should not submit input, got %d logs", len(updated.logs))
	}
}

func TestMultilineInputSubmitsAsSingleLogEntry(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "第一行\n第二行"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("expected enter to submit multiline input once")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one log entry, got %d", len(updated.logs))
	}
	if updated.logs[0].Message != "第一行\n第二行" {
		t.Fatalf("expected newline-preserving message, got %q", updated.logs[0].Message)
	}
}

func TestPastedMultilineRunesStayInOneInputBuffer(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("第一行\n第二行"), Paste: true})
	if cmd != nil {
		t.Fatalf("expected paste to stay local")
	}
	updated := next.(Model)
	if updated.input != "第一行\n第二行" {
		t.Fatalf("expected pasted multiline text in one buffer, got %q", updated.input)
	}
	if len(updated.logs) != 0 {
		t.Fatalf("paste should not submit input, got %d logs", len(updated.logs))
	}
}

func TestUserLogWrapsLongMessageWithoutEllipsis(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 72
	model.height = 36

	next, _ := model.Update(LogMsg{
		Source:  "user",
		Status:  "pending",
		Message: "用户发送了一段很长很长的文本，日志里也不能省略这段用户文本 USER_TAIL",
	})
	view := next.(Model).View()
	if !strings.Contains(view, "USER_TAIL") {
		t.Fatalf("expected user log tail to remain visible, got %q", view)
	}
	if strings.Contains(view, "用户发送了一段很长很长的文本...") {
		t.Fatalf("user log should wrap instead of ellipsizing, got %q", view)
	}
}

func TestCtrlTShowsFullAITranscript(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 36

	next, _ := model.Update(LogMsg{
		Source:      "ai",
		ToolName:    "exec_cmd",
		Status:      "success",
		Message:     "Ran Get-Content file\n └ first line\n   … +3 lines (Ctrl+T 查看完整)",
		FullMessage: "Ran Get-Content file\nfirst line\nsecond line\nFULL_TRANSCRIPT_TAIL",
	})
	updated := next.(Model)
	if strings.Contains(updated.View(), "FULL_TRANSCRIPT_TAIL") {
		t.Fatalf("full transcript should stay hidden before Ctrl+T")
	}

	next, cmd := updated.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	if cmd != nil {
		t.Fatalf("expected Ctrl+T to be local")
	}
	view := next.(Model).View()
	if !strings.Contains(view, "FULL_TRANSCRIPT_TAIL") {
		t.Fatalf("expected Ctrl+T to show full transcript, got %q", view)
	}
}

func TestLogEntryRendersMultilineSummary(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	next, _ := model.Update(LogMsg{
		Source:   "ai",
		ToolName: "exec_cmd",
		Status:   "success",
		Message:  "Ran Get-Content internal\\tool\\grep.go -Encoding UTF8\n └ Name               Length LastWriteTime\n   … +3 lines",
	})
	view := next.(Model).View()

	if !strings.Contains(view, "Ran Get-Content internal\\tool\\grep.go -Encoding UTF8") {
		t.Fatalf("expected command summary in view")
	}
	if !strings.Contains(view, "… +3 lines") {
		t.Fatalf("expected folded line count in view")
	}
	if strings.Contains(view, "exec_cmd") {
		t.Fatalf("tool metadata column should not be rendered")
	}
}
