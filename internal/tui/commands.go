package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	skillpkg "github.com/sirhap/piercode/internal/skill"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type slashCommand struct {
	Name        string
	Usage       string
	Description string
}

var slashCommandList = []slashCommand{
	{Name: "init", Usage: "", Description: "发送初始化提示词到浏览器 AI 页面"},
	{Name: "skills", Usage: "", Description: "列出当前可用 skills"},
	{Name: "skill", Usage: "<name>", Description: "加载并发送指定 skill 到浏览器 AI 页面"},
	{Name: "cd", Usage: "<path>", Description: "切换 AI 工具执行目录"},
	{Name: "cwd", Usage: "", Description: "显示当前执行目录"},
	{Name: "url", Usage: "", Description: "显示认证 URL"},
	{Name: "send", Usage: "<text>", Description: "把文本发送到浏览器 AI 输入框"},
	{Name: "logs", Usage: "", Description: "切换原始诊断日志视图"},
	{Name: "mouse", Usage: "", Description: "切换鼠标滚轮捕获（关闭后可用鼠标选中复制）"},
	{Name: "clear", Usage: "", Description: "清空活动区"},
	{Name: "help", Usage: "", Description: "显示 TUI 指令"},
}

func (m Model) renderCommandSuggestions(width int) string {
	if m.hasExactSlashCommand() {
		return ""
	}
	candidates := m.commandCandidates()
	if len(candidates) == 0 {
		return lipgloss.NewStyle().Foreground(colorError).Render("  no command matches")
	}
	limit := minInt(5, len(candidates))
	lines := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		cmd := candidates[i]
		pointer := "  "
		style := subtitleStyle
		if i == m.commandIdx {
			pointer = "▸ "
			style = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
		}
		usage := ""
		if cmd.Usage != "" {
			usage = " " + cmd.Usage
		}
		text := fmt.Sprintf("%s/%s%s  %s", pointer, cmd.Name, usage, cmd.Description)
		lines = append(lines, style.Render(truncateString(text, maxInt(8, width-4))))
	}
	return strings.Join(lines, "\n")
}

func (m Model) hasExactSlashCommand() bool {
	text := strings.TrimSpace(m.input)
	if !strings.HasPrefix(text, "/") {
		return false
	}
	name, args := parseSlashCommand(text)
	if name == "" || args != "" {
		return false
	}
	cmd, ok := findSlashCommand(name)
	return ok && cmd.Usage == ""
}

func (m Model) isSlashInput() bool {
	return strings.HasPrefix(strings.TrimSpace(m.input), "/")
}

func (m Model) commandQuery() string {
	text := strings.TrimSpace(m.input)
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	text = strings.TrimLeft(text, "/")
	if idx := strings.IndexAny(text, " \t"); idx >= 0 {
		return text[:idx]
	}
	return text
}

func (m Model) commandCandidates() []slashCommand {
	query := strings.ToLower(m.commandQuery())
	if query == "" {
		return slashCommandList
	}
	var candidates []slashCommand
	for _, cmd := range slashCommandList {
		if fuzzyMatch(query, cmd.Name) || fuzzyMatch(query, cmd.Description) {
			candidates = append(candidates, cmd)
		}
	}
	return candidates
}

func (m *Model) clampCommandSelection() {
	candidates := m.commandCandidates()
	if len(candidates) == 0 {
		m.commandIdx = 0
		return
	}
	if m.commandIdx >= len(candidates) {
		m.commandIdx = len(candidates) - 1
	}
	if m.commandIdx < 0 {
		m.commandIdx = 0
	}
}

func (m *Model) moveCommandSelection(delta int) {
	candidates := m.commandCandidates()
	if len(candidates) == 0 {
		m.commandIdx = 0
		return
	}
	m.commandIdx = (m.commandIdx + delta + len(candidates)) % len(candidates)
}

func (m *Model) completeSlashInput() {
	if !m.isSlashInput() {
		return
	}
	if strings.HasPrefix(strings.TrimSpace(m.input), "/cd ") {
		if completed, ok := completeDirPath(m.rootDir, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(m.input), "/cd "))); ok {
			m.input = "/cd " + completed
			m.inputCursor = len([]rune(m.input))
		}
		return
	}
	candidates := m.commandCandidates()
	if len(candidates) == 0 {
		return
	}
	m.clampCommandSelection()
	cmd := candidates[m.commandIdx]
	m.input = "/" + cmd.Name
	if cmd.Usage != "" {
		m.input += " "
	}
	m.inputCursor = len([]rune(m.input))
}

func (m Model) executeSlashCommand(text string) (tea.Model, tea.Cmd) {
	name, args := parseSlashCommand(text)
	if name == "" {
		m.input = ""
		m.inputMode = true
		m.commandIdx = 0
		return m, nil
	}
	cmd, ok := findSlashCommand(name)
	if !ok {
		candidates := m.commandCandidates()
		if len(candidates) > 0 {
			cmd = candidates[0]
			name = cmd.Name
			ok = true
		}
	}
	if !ok {
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "COMMAND", Status: "error", Message: "未知指令: " + text})
		m.stats["error"]++
		m.input = ""
		m.inputMode = true
		m.commandIdx = 0
		m.logOffset = len(m.logs) - 1
		m.appendSystemNotice("error", "未知指令: "+text)
		return m, nil
	}

	m.input = ""
	m.inputMode = true
	m.commandIdx = 0

	switch name {
	case "init":
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "INIT", Status: "pending", Message: "正在发送初始化提示词到 AI 页面"}
		m.logs = append(m.logs, entry)
		m.stats["pending"]++
		m.logOffset = len(m.logs) - 1
		m.appendSystemNotice(entry.Status, entry.Message)
		return m, initPromptCmd(m.port, m.token)
	case "skills":
		msg := formatSkillsList(m.rootDir)
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "SKILLS", Status: "info", Message: msg}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
	case "skill":
		skillName := strings.TrimSpace(args)
		if skillName == "" {
			msg := formatSkillsList(m.rootDir)
			entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "SKILLS", Status: "info", Message: msg}
			m.logs = append(m.logs, entry)
			m.appendSystemNotice(entry.Status, entry.Message)
			break
		}
		skillName = strings.Fields(skillName)[0]
		if _, ok := skillpkg.Get(m.rootDir, skillName); !ok {
			entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("skill %q 不存在", skillName)}
			m.logs = append(m.logs, entry)
			m.stats["error"]++
			m.logOffset = len(m.logs) - 1
			m.appendSystemNotice(entry.Status, entry.Message)
			return m, nil
		}
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "SKILL", Status: "pending", Message: "正在发送 skill: " + skillName}
		m.logs = append(m.logs, entry)
		m.stats["pending"]++
		m.logOffset = len(m.logs) - 1
		m.appendSystemNotice(entry.Status, entry.Message)
		return m, skillPromptCmd(m.rootDir, skillName, m.port, m.token)
	case "clear":
		m.logs = nil
		m.turns = nil
		m.logOffset = 0
		m.transcriptOffset = -1
		// Reset counters too — leaving "OK 12 ERR 3" pinned to a now-empty
		// activity area was a constant source of "did clear actually run?"
		// confusion.
		for k := range m.stats {
			m.stats[k] = 0
		}
		// Drop cached layout lines so re-renders don't show stale state.
		m.transcriptLineCache = make(map[string]turnLinesCacheEntry)
		return m, nil
	case "mouse":
		// Toggle mouse-wheel capture at runtime. Off (default) lets the user
		// mouse-select to copy text the way every native terminal does. On
		// makes the wheel scroll the transcript inside the TUI.
		m.mouseCapture = !m.mouseCapture
		state := "OFF"
		var cmd tea.Cmd
		if m.mouseCapture {
			state = "ON"
			cmd = tea.EnableMouseCellMotion
		} else {
			cmd = tea.DisableMouse
		}
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "MOUSE", Status: "info",
			Message: fmt.Sprintf("鼠标捕获: %s（关闭时可用鼠标选中复制）", state)}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
		return m, cmd
	case "cwd":
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "info", Message: "当前工作目录: " + m.rootDir}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
	case "url":
		msg := "认证 URL 尚未生成"
		if m.authURL != "" {
			msg = "认证 URL: " + m.authURL
		}
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "AUTH", Status: "info", Message: msg}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
	case "help":
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "HELP", Status: "info", Message: commandHelpText()}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
	case "send":
		if strings.TrimSpace(args) == "" {
			entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "SEND", Status: "error", Message: "/send 需要文本"}
			m.logs = append(m.logs, entry)
			m.stats["error"]++
			m.logOffset = len(m.logs) - 1
			m.appendSystemNotice(entry.Status, entry.Message)
			return m, nil
		}
		m.recordUserPrompt(args)
		return m, injectInputCmd(args, m.port, m.token)
	case "logs":
		m.logsMode = !m.logsMode
		msg := "已切换到转录视图"
		if m.logsMode {
			msg = "已切换到原始日志视图"
		}
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "LOGS", Status: "info", Message: msg}
		m.logs = append(m.logs, entry)
		m.appendSystemNotice(entry.Status, entry.Message)
	case "cd":
		path := strings.TrimSpace(args)
		if path == "" {
			entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "error", Message: "/cd 需要目录，例如 /cd extension/dist"}
			m.logs = append(m.logs, entry)
			m.stats["error"]++
			m.logOffset = len(m.logs) - 1
			m.appendSystemNotice(entry.Status, entry.Message)
			return m, nil
		}
		entry := LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "pending", Message: "正在切换目录: " + path}
		m.logs = append(m.logs, entry)
		m.stats["pending"]++
		m.logOffset = len(m.logs) - 1
		m.appendSystemNotice(entry.Status, entry.Message)
		return m, changeCwdCmd(path, m.port, m.token)
	}

	m.stats["info"]++
	m.logOffset = len(m.logs) - 1
	return m, nil
}

func formatSkillsList(rootDir string) string {
	infos := skillpkg.LoadInfos(rootDir)
	if len(infos) == 0 {
		return "没有找到可用 skills。可在 .skills/<name>/SKILL.md 中添加。"
	}
	lines := make([]string, 0, len(infos)+1)
	lines = append(lines, "可用 skills:")
	for _, info := range infos {
		desc := strings.TrimSpace(info.Description)
		if desc == "" {
			desc = "无描述"
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", info.Name, desc))
	}
	return strings.Join(lines, "\n")
}

func parseSlashCommand(text string) (string, string) {
	text = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(text), "/"))
	if text == "" {
		return "", ""
	}
	parts := strings.Fields(text)
	name := strings.ToLower(parts[0])
	args := strings.TrimSpace(strings.TrimPrefix(text, parts[0]))
	return name, args
}

func findSlashCommand(name string) (slashCommand, bool) {
	for _, cmd := range slashCommandList {
		if cmd.Name == name {
			return cmd, true
		}
	}
	return slashCommand{}, false
}

func commandHelpText() string {
	lines := []string{
		"输入模式（光标在 piercode> 后）：",
		"  Enter           提交（中文输入法用户：连按两次确认）",
		"  Alt+Enter / Ctrl+J  插入换行",
		"  Tab             slash 指令补全 / 路径补全",
		"  ↑ / ↓           历史命令；slash 模式下选指令；fullView 内滚动",
		"  ←/→ Home/End    光标移动 / 跳行首行尾",
		"  Ctrl+U          清空当前输入",
		"  Ctrl+W          删除前一个词",
		"  Ctrl+C          首次清空输入；输入为空时退出",
		"  Esc             分层关闭：fullView → slash 提示 → 切到浏览模式",
		"",
		"浏览模式（Esc 后）：",
		"  i 或 字符       回到输入模式",
		"  /               回到输入并起始一条 slash 指令",
		"  q / Ctrl+C      退出",
		"  ↑ ↓ / k j       滚动转录或日志",
		"  PgUp / PgDn     翻页",
		"  Ctrl+↑ / Ctrl+↓ 翻页（兼容部分终端）",
		"  Home / g        回到顶部",
		"  End / G         跟随到底部",
		"",
		"通用：",
		"  Ctrl+T - 展开/收起当前条目完整输出",
		"  Ctrl+D - 切换工具详情视图",
		"",
		"指令：",
	}
	for _, cmd := range slashCommandList {
		usage := ""
		if cmd.Usage != "" {
			usage = " " + cmd.Usage
		}
		lines = append(lines, fmt.Sprintf("  /%s%s - %s", cmd.Name, usage, cmd.Description))
	}
	lines = append(lines,
		"",
		"提示：默认鼠标滚轮 不 捕获，方便鼠标选中复制；用 /mouse 打开滚轮滚动。",
	)
	return strings.Join(lines, "\n")
}

func fuzzyMatch(query, value string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	value = strings.ToLower(value)
	if query == "" {
		return true
	}
	if strings.Contains(value, query) {
		return true
	}
	queryRunes := []rune(query)
	idx := 0
	for _, r := range value {
		if idx < len(queryRunes) && r == queryRunes[idx] {
			idx++
		}
	}
	return idx == len(queryRunes)
}

func completeDirPath(rootDir, raw string) (string, bool) {
	if raw == "" {
		raw = "."
	}
	raw = strings.Trim(raw, `"`)
	baseDir := rootDir
	prefix := raw
	if filepath.IsAbs(raw) {
		baseDir = filepath.Dir(raw)
		prefix = filepath.Base(raw)
	} else if dir := filepath.Dir(raw); dir != "." {
		baseDir = filepath.Join(rootDir, dir)
		prefix = filepath.Base(raw)
	}

	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return "", false
	}
	// 如果 raw 以 / 结尾，说明路径已完整，直接返回
	if prefix == "" {
		return raw, true
	}
	prefixLower := strings.ToLower(prefix)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(entry.Name()), prefixLower) {
			continue
		}
		if filepath.IsAbs(raw) {
			return filepath.Join(baseDir, entry.Name()), true
		}
		dir := filepath.Dir(raw)
		if dir == "." {
			return entry.Name(), true
		}
		return filepath.Join(dir, entry.Name()), true
	}
	return "", false
}
