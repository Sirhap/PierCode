package tui

import (
	"os"
	"path/filepath"
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

func TestCtrlCClearsInputInInputMode(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "待清空文本"
	model.commandIdx = 2
	model.historyIdx = 1

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd != nil {
		t.Fatalf("expected ctrl+c to clear input without quitting")
	}
	updated := next.(Model)
	if updated.input != "" {
		t.Fatalf("expected input to be cleared, got %q", updated.input)
	}
	if updated.commandIdx != 0 {
		t.Fatalf("expected command index reset, got %d", updated.commandIdx)
	}
	if updated.historyIdx != -1 {
		t.Fatalf("expected history index reset, got %d", updated.historyIdx)
	}
}

func TestInputHistoryRestoresDraftAfterBrowsing(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.addInputHistory("first")
	model.addInputHistory("second")
	model.input = "draft"
	model.inputCursor = 2

	next, _ := model.Update(tea.KeyMsg{Type: tea.KeyUp})
	model = next.(Model)
	if model.input != "second" {
		t.Fatalf("expected latest history item, got %q", model.input)
	}

	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyDown})
	model = next.(Model)
	if model.input != "draft" {
		t.Fatalf("expected draft to be restored, got %q", model.input)
	}
	if model.inputCursor != 2 {
		t.Fatalf("expected draft cursor to be restored, got %d", model.inputCursor)
	}
	if model.historyIdx != -1 {
		t.Fatalf("expected history index reset after returning to draft, got %d", model.historyIdx)
	}
}

func TestCtrlCQuitsWhenInputIsEmpty(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = ""

	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatalf("expected ctrl+c with empty input to quit")
	}
}

func TestInputCursorMovesAndInsertsText(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "ac"
	model.inputCursor = 1

	next, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("b")})
	updated := next.(Model)
	if updated.input != "abc" {
		t.Fatalf("expected insert at cursor, got %q", updated.input)
	}
	if updated.inputCursor != 2 {
		t.Fatalf("expected cursor after inserted rune, got %d", updated.inputCursor)
	}

	next, _ = updated.Update(tea.KeyMsg{Type: tea.KeyLeft})
	updated = next.(Model)
	next, _ = updated.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	updated = next.(Model)
	if updated.input != "bc" {
		t.Fatalf("expected backspace before cursor, got %q", updated.input)
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
	if !strings.Contains(view, "PAGE") || !strings.Contains(view, "0") {
		t.Fatalf("expected browser page count in status strip")
	}
}

func TestBrowserConnectionCountUpdatesStatusStrip(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 30

	next, _ := model.Update(LogMsg{
		Source:   "system",
		ToolName: "BROWSER",
		Status:   "success",
		Message:  "浏览器扩展已连接 (2)",
	})
	view := next.(Model).View()
	if !strings.Contains(view, "PAGE") || !strings.Contains(view, "2") {
		t.Fatalf("expected connected browser page count in status strip, got %q", view)
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

func TestNormalAIResponseRendersInTUI(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	next, _ := model.Update(LogMsg{
		Source:  "ai",
		Status:  "info",
		Message: "这是 AI 的普通回复，不是工具调用。",
	})
	view := next.(Model).View()
	if !strings.Contains(view, "这是 AI 的普通回复") {
		t.Fatalf("expected normal AI response in view, got %q", view)
	}
	if strings.Contains(view, "MESSAGE") {
		t.Fatalf("normal AI response should not render as a tool card, got %q", view)
	}
}

func TestStreamingAIResponseUpdatesSameLogEntry(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	next, _ := model.Update(LogMsg{Key: "ai-1", Source: "ai", Status: "info", Message: "第一段"})
	model = next.(Model)
	next, _ = model.Update(LogMsg{Key: "ai-1", Source: "ai", Status: "info", Message: "第一段\n第二段"})
	model = next.(Model)

	if len(model.logs) != 1 {
		t.Fatalf("expected streaming response to update one log entry, got %d", len(model.logs))
	}
	if !strings.Contains(model.View(), "第二段") {
		t.Fatalf("expected updated streaming text in view")
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
	if !updated.inputMode {
		t.Fatalf("expected CLI prompt to remain active")
	}
	if len(updated.logs) != 0 {
		t.Fatalf("expected logs to be cleared, got %d", len(updated.logs))
	}
	if len(updated.turns) != 0 {
		t.Fatalf("expected transcript to be cleared, got %d turns", len(updated.turns))
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
	if !strings.Contains(help, "/init - 发送初始化提示词到浏览器 AI 页面") {
		t.Fatalf("expected init command in help, got %q", help)
	}
	if !strings.Contains(help, "/skills - 列出当前可用 skills") {
		t.Fatalf("expected skills command in help, got %q", help)
	}
	if !strings.Contains(help, "/skill <name> - 加载并发送指定 skill 到浏览器 AI 页面") {
		t.Fatalf("expected skill command in help, got %q", help)
	}
	if !strings.Contains(help, "Ctrl+D - 切换工具详情视图") {
		t.Fatalf("expected detail-mode shortcut in help, got %q", help)
	}
	if strings.Contains(help, " · ") {
		t.Fatalf("help text should not be joined with bullets, got %q", help)
	}
}

func TestSlashInitCommandStartsInitPromptSend(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "/init"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("expected /init to return a command")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one pending log, got %d", len(updated.logs))
	}
	if updated.logs[0].ToolName != "INIT" || updated.logs[0].Status != "pending" {
		t.Fatalf("expected pending INIT log, got %#v", updated.logs[0])
	}
	if !strings.Contains(updated.logs[0].Message, "初始化提示词") {
		t.Fatalf("expected init prompt message, got %q", updated.logs[0].Message)
	}
}

func TestSlashSkillsCommandListsLocalSkills(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills", "demo")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: demo\ndescription: demo skill\n---\ncontent"), 0644); err != nil {
		t.Fatal(err)
	}

	model := NewModel(39527, root, "qwen")
	model.inputMode = true
	model.input = "/skills"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatalf("expected /skills to stay local")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one skills log, got %d", len(updated.logs))
	}
	if updated.logs[0].ToolName != "SKILLS" || !strings.Contains(updated.logs[0].Message, "demo: demo skill") {
		t.Fatalf("expected skills listing, got %#v", updated.logs[0])
	}
}

func TestSlashSkillCommandStartsSkillSend(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills", "demo")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: demo\ndescription: demo skill\n---\ncontent"), 0644); err != nil {
		t.Fatal(err)
	}

	model := NewModel(39527, root, "qwen")
	model.inputMode = true
	model.input = "/skill demo"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("expected /skill to return a command")
	}
	updated := next.(Model)
	if len(updated.logs) != 1 {
		t.Fatalf("expected one pending skill log, got %d", len(updated.logs))
	}
	if updated.logs[0].ToolName != "SKILL" || updated.logs[0].Status != "pending" {
		t.Fatalf("expected pending SKILL log, got %#v", updated.logs[0])
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
	if !strings.Contains(view, "openlink> hello") {
		t.Fatalf("expected shell-like input label, got %q", view)
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

func TestInjectInputDropsLeadingInvisiblePrefix(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.inputMode = true
	model.input = "\u200b\uFFFC\u25A1你好"

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatalf("expected sanitized input to submit")
	}
	updated := next.(Model)
	if updated.logs[0].Message != "你好" {
		t.Fatalf("expected invisible prefix to be removed, got %q", updated.logs[0].Message)
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

func TestUserTurnWrapsLongMessageWithoutEllipsis(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 72
	model.height = 36
	model.recordUserPrompt("用户发送了一段很长很长的文本，日志里也不能省略这段用户文本 USER_TAIL")

	view := model.View()
	if !strings.Contains(view, "USER_TAIL") {
		t.Fatalf("expected user turn tail to remain visible, got %q", view)
	}
	if strings.Contains(view, "用户发送了一段很长很长的文本...") {
		t.Fatalf("user turn should wrap instead of ellipsizing, got %q", view)
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

func TestFullAITranscriptCanScroll(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 18

	next, _ := model.Update(LogMsg{
		Source:   "ai",
		ToolName: "exec_cmd",
		Status:   "success",
		Message:  "Ran command\n   … +10 lines (Ctrl+T 查看完整)",
		FullMessage: strings.Join([]string{
			"line-01", "line-02", "line-03", "line-04", "line-05",
			"line-06", "line-07", "line-08", "line-09", "FULL_SCROLL_TAIL",
		}, "\n"),
	})
	model = next.(Model)
	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	model = next.(Model)
	if strings.Contains(model.renderLogs(80, 4), "FULL_SCROLL_TAIL") {
		t.Fatalf("tail should not be visible before scrolling")
	}

	for i := 0; i < 8; i++ {
		next, _ = model.Update(tea.KeyMsg{Type: tea.KeyDown})
		model = next.(Model)
	}
	if !strings.Contains(model.renderLogs(80, 4), "FULL_SCROLL_TAIL") {
		t.Fatalf("expected full transcript tail after scrolling")
	}
}

func TestMouseWheelScrollsFullTranscript(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 18

	next, _ := model.Update(LogMsg{
		Source:   "ai",
		ToolName: "exec_cmd",
		Status:   "success",
		Message:  "Ran command\n   … +10 lines (Ctrl+T 查看完整)",
		FullMessage: strings.Join([]string{
			"line-01", "line-02", "line-03", "line-04", "line-05",
			"line-06", "line-07", "line-08", "line-09", "FULL_MOUSE_TAIL",
		}, "\n"),
	})
	model = next.(Model)
	next, _ = model.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	model = next.(Model)
	next, _ = model.Update(tea.MouseMsg{Type: tea.MouseWheelDown})
	model = next.(Model)

	if model.fullOffset == 0 {
		t.Fatalf("expected mouse wheel to move full transcript offset")
	}
}

func TestMouseWheelScrollsLogSelection(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.logsMode = true
	for i := 0; i < 5; i++ {
		next, _ := model.Update(LogMsg{Source: "ai", Status: "info", Message: "line"})
		model = next.(Model)
	}
	if model.logOffset != 4 {
		t.Fatalf("expected latest log selected")
	}
	next, _ := model.Update(tea.MouseMsg{Type: tea.MouseWheelUp})
	model = next.(Model)
	if model.logOffset >= 4 {
		t.Fatalf("expected mouse wheel up to move log selection, got %d", model.logOffset)
	}
}

func TestLogsAutoScrollByRenderedLines(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 80
	model.height = 18

	large := strings.Join([]string{
		"line-01", "line-02", "line-03", "line-04", "line-05",
		"line-06", "line-07", "line-08", "line-09", "line-10",
	}, "\n")
	next, _ := model.Update(LogMsg{Source: "ai", Status: "info", Message: large})
	model = next.(Model)
	next, _ = model.Update(LogMsg{Source: "ai", Status: "info", Message: "LATEST_VISIBLE_LINE"})
	model = next.(Model)

	view := model.renderLogs(80, 4)
	if !strings.Contains(view, "LATEST_VISIBLE_LINE") {
		t.Fatalf("expected newest log to remain visible after a tall previous log, got %q", view)
	}
}

func TestLogLineClassificationForCommandSummary(t *testing.T) {
	entry := LogEntry{Source: "ai", ToolName: "exec_cmd", Message: "Ran command\n   … +3 lines"}
	if !isCommandLog(entry) {
		t.Fatalf("expected exec_cmd AI entry to be command-like")
	}
	if !isFoldedSummaryLine("   … +3 lines") {
		t.Fatalf("expected folded summary line")
	}
	if !isOutputDetailLine(" └ output") {
		t.Fatalf("expected output detail line")
	}
	if !isCommandLine("> go test ./...") {
		t.Fatalf("expected command line")
	}
	if !isDiffAddLine("+ added") || isDiffAddLine("+++ new") {
		t.Fatalf("expected diff add classification to skip diff header")
	}
	if !isDiffDeleteLine("- removed") || isDiffDeleteLine("--- old") {
		t.Fatalf("expected diff delete classification to skip diff header")
	}
	if !isDiffHunkLine("@@ context") {
		t.Fatalf("expected diff hunk classification")
	}
	if !isCodeFenceLine("```go") {
		t.Fatalf("expected code fence classification")
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

	if !strings.Contains(view, "… +3 lines") {
		t.Fatalf("expected folded line count in view")
	}
	if !strings.Contains(view, "exec_cmd") {
		t.Fatalf("tool card header should include tool name")
	}
	if !strings.Contains(view, "> Get-Content internal\\tool\\grep.go -Encoding UTF8") {
		t.Fatalf("tool card should render command line, got %q", view)
	}
}

func TestCtrlDTogglesToolDetailMode(t *testing.T) {
	model := NewModel(39527, "D:\\workspace", "qwen")
	model.width = 100
	model.height = 24

	next, _ := model.Update(LogMsg{
		Source:      "ai",
		ToolName:    "exec_cmd",
		Status:      "success",
		Message:     "Ran command\n └ preview",
		FullMessage: "Ran command\nfull output",
	})
	model = next.(Model)
	if strings.Contains(model.View(), "VIEW DETAIL") {
		t.Fatalf("detail mode should be off by default")
	}

	next, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if cmd != nil {
		t.Fatalf("expected Ctrl+D to be local")
	}
	model = next.(Model)
	view := model.View()
	if !strings.Contains(view, "VIEW DETAIL") {
		t.Fatalf("expected status strip to show detail mode, got %q", view)
	}
	if !strings.Contains(view, "detail  Ctrl+T 查看完整输出") {
		t.Fatalf("expected selected tool to show detail hint, got %q", view)
	}
}
