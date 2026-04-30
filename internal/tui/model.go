package tui

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// LogEntry 代表一条日志记录
type LogEntry struct {
	Time        time.Time
	Source      string // "user", "ai", "system"
	ToolName    string
	Status      string // success, error, pending, info
	Message     string
	FullMessage string
}

// Model 是 TUI 的核心状态
type Model struct {
	logs       []LogEntry
	status     string
	port       int
	rootDir    string
	aiProvider string
	token      string
	width      int
	height     int
	logOffset  int
	stats      map[string]int
	input      string
	inputMode  bool
	authURL    string
	commandIdx int
	fullView   bool
}

// 样式定义
var (
	colorCanvas  = lipgloss.Color("#07111F")
	colorSurface = lipgloss.Color("#0E1726")
	colorLine    = lipgloss.Color("#25324A")
	colorAccent  = lipgloss.Color("#B38CFF")
	colorCyan    = lipgloss.Color("#6EE7F9")
	colorSuccess = lipgloss.Color("#7DD3A7")
	colorError   = lipgloss.Color("#F87171")
	colorWarning = lipgloss.Color("#FBBF77")
	colorMuted   = lipgloss.Color("#7B879C")
	colorText    = lipgloss.Color("#E7EEF9")

	// 角色区分颜色
	colorUser = lipgloss.Color("#FBBF77")
	colorAI   = lipgloss.Color("#7DD3FC")
	colorSys  = lipgloss.Color("#B38CFF")

	pageStyle     = lipgloss.NewStyle().Background(colorCanvas).Foreground(colorText)
	logoStyle     = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	subtitleStyle = lipgloss.NewStyle().Foreground(colorMuted)
	ruleStyle     = lipgloss.NewStyle().Foreground(colorLine)
	metricStyle   = lipgloss.NewStyle().Foreground(colorText).Background(colorSurface).Padding(0, 1)
	logMsgStyle   = lipgloss.NewStyle().Foreground(colorText)

	inputStyle  = lipgloss.NewStyle().Background(colorSurface).Padding(0, 1)
	cursorStyle = lipgloss.NewStyle().Background(colorAccent).Foreground(lipgloss.Color("#07111F"))
	keyStyle    = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
)

func NewModel(port int, rootDir, aiProvider string, token ...string) Model {
	authToken := ""
	if len(token) > 0 {
		authToken = token[0]
	}
	return Model{
		logs:       make([]LogEntry, 0),
		status:     "starting",
		port:       port,
		rootDir:    rootDir,
		aiProvider: aiProvider,
		token:      authToken,
		authURL:    authURLForToken(port, authToken),
		stats:      map[string]int{"success": 0, "error": 0, "pending": 0, "info": 0},
	}
}

func authURLForToken(port int, token string) string {
	if token == "" {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d/auth?token=%s", port, token)
}

func (m Model) Init() tea.Cmd { return nil }

type injectResponse struct {
	Status  string `json:"status"`
	Text    string `json:"text"`
	Clients int    `json:"clients"`
	Error   string `json:"error"`
}

type cwdResponse struct {
	RootDir string `json:"rootDir"`
	Error   string `json:"error"`
}

type cwdChangedMsg struct {
	RootDir string
}

type slashCommand struct {
	Name        string
	Usage       string
	Description string
}

var slashCommandList = []slashCommand{
	{Name: "cd", Usage: "<path>", Description: "切换 AI 工具执行目录"},
	{Name: "cwd", Usage: "", Description: "显示当前执行目录"},
	{Name: "url", Usage: "", Description: "显示认证 URL"},
	{Name: "send", Usage: "<text>", Description: "把文本发送到浏览器 AI 输入框"},
	{Name: "clear", Usage: "", Description: "清空活动区"},
	{Name: "help", Usage: "", Description: "显示 TUI 指令"},
}

func injectInputCmd(text string, port int, token string) tea.Cmd {
	return func() tea.Msg {
		payload, err := json.Marshal(map[string]string{"text": text})
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: fmt.Sprintf("编码失败: %v", err)}
		}

		client := &http.Client{Timeout: 5 * time.Second}
		url := fmt.Sprintf("http://127.0.0.1:%d/inject", port)
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: fmt.Sprintf("请求创建失败: %v", err)}
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: fmt.Sprintf("发送失败: %v", err)}
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))}
		}

		var decoded injectResponse
		if err := json.Unmarshal(body, &decoded); err != nil {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: fmt.Sprintf("响应解析失败: %v", err)}
		}
		if decoded.Clients == 0 {
			return LogMsg{Source: "system", ToolName: "INJECT", Status: "error", Message: "未连接浏览器扩展，请刷新 AI 页面或重新配置插件"}
		}
		return LogMsg{Source: "system", ToolName: "INJECT", Status: "success", Message: fmt.Sprintf("已发送到 %d 个浏览器页面", decoded.Clients)}
	}
}

func changeCwdCmd(path string, port int, token string) tea.Cmd {
	return func() tea.Msg {
		payload, err := json.Marshal(map[string]string{"path": path})
		if err != nil {
			return LogMsg{Source: "system", ToolName: "CWD", Status: "error", Message: fmt.Sprintf("编码失败: %v", err)}
		}

		client := &http.Client{Timeout: 5 * time.Second}
		url := fmt.Sprintf("http://127.0.0.1:%d/cwd", port)
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			return LogMsg{Source: "system", ToolName: "CWD", Status: "error", Message: fmt.Sprintf("请求创建失败: %v", err)}
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := client.Do(req)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "CWD", Status: "error", Message: fmt.Sprintf("切换目录失败: %v", err)}
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		var decoded cwdResponse
		_ = json.Unmarshal(body, &decoded)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			msg := decoded.Error
			if msg == "" {
				msg = strings.TrimSpace(string(body))
			}
			return LogMsg{Source: "system", ToolName: "CWD", Status: "error", Message: fmt.Sprintf("切换目录失败: %s", msg)}
		}
		if decoded.RootDir == "" {
			return LogMsg{Source: "system", ToolName: "CWD", Status: "error", Message: "切换目录失败: 响应缺少 rootDir"}
		}
		return cwdChangedMsg{RootDir: decoded.RootDir}
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		if m.inputMode {
			switch msg.Type {
			case tea.KeyEnter:
				if msg.Alt {
					m.input += "\n"
					m.clampCommandSelection()
					return m, nil
				}
				text := strings.TrimSpace(m.input)
				if text != "" {
					if strings.HasPrefix(text, "/") {
						return m.executeSlashCommand(text)
					}
					m.logs = append(m.logs, LogEntry{
						Time: time.Now(), Source: "user", ToolName: "INJECT", Status: "pending", Message: text,
					})
					m.stats["pending"]++
					m.input = ""
					m.inputMode = false
					m.logOffset = len(m.logs) - 1
					return m, injectInputCmd(text, m.port, m.token)
				}
				m.input = ""
				m.inputMode = false
				return m, nil
			case tea.KeyEscape:
				m.input = ""
				m.inputMode = false
				return m, nil
			case tea.KeyCtrlJ:
				m.input += "\n"
				m.clampCommandSelection()
				return m, nil
			case tea.KeyCtrlT:
				m.fullView = !m.fullView
				return m, nil
			case tea.KeyTab:
				m.completeSlashInput()
				return m, nil
			case tea.KeyUp:
				if m.isSlashInput() {
					m.moveCommandSelection(-1)
				}
				return m, nil
			case tea.KeyDown:
				if m.isSlashInput() {
					m.moveCommandSelection(1)
				}
				return m, nil
			case tea.KeyCtrlU:
				m.input = ""
				m.commandIdx = 0
				return m, nil
			case tea.KeyCtrlW:
				m.input = trimLastWord(m.input)
				m.clampCommandSelection()
				return m, nil
			case tea.KeyBackspace:
				if len(m.input) > 0 {
					runes := []rune(m.input)
					m.input = string(runes[:len(runes)-1])
				}
				m.clampCommandSelection()
				return m, nil
			case tea.KeyRunes:
				m.input += slashRunesToAppend(m.input, string(msg.Runes))
				m.clampCommandSelection()
				return m, nil
			case tea.KeySpace:
				m.input += " "
				return m, nil
			}
			return m, nil
		}

		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "ctrl+t":
			m.fullView = !m.fullView
			return m, nil
		case "i":
			m.inputMode = true
			m.input = ""
			m.commandIdx = 0
			return m, nil
		case "/":
			m.inputMode = true
			m.input = "/"
			m.commandIdx = 0
			return m, nil
		case "up", "k":
			if m.logOffset > 0 {
				m.logOffset--
			}
			return m, nil
		case "down", "j":
			if m.logOffset < len(m.logs)-1 {
				m.logOffset++
			}
			return m, nil
		case "home", "g":
			m.logOffset = 0
			return m, nil
		case "end", "G":
			if len(m.logs) > 0 {
				m.logOffset = len(m.logs) - 1
			}
			return m, nil
		}
		if msg.Type == tea.KeyRunes && len(msg.Runes) > 0 {
			m.inputMode = true
			m.input = normalizeSlashInput(string(msg.Runes))
			m.commandIdx = 0
		}
		return m, nil

	case LogMsg:
		if authURL := extractAuthURL(msg.Message); authURL != "" {
			m.authURL = authURL
			return m, nil
		}
		m.logs = append(m.logs, LogEntry{
			Time: time.Now(), Source: msg.Source, ToolName: msg.ToolName, Status: msg.Status, Message: msg.Message, FullMessage: msg.FullMessage,
		})
		m.stats[msg.Status]++
		m.logOffset = len(m.logs) - 1
		return m, nil

	case cwdChangedMsg:
		m.rootDir = msg.RootDir
		m.logs = append(m.logs, LogEntry{
			Time: time.Now(), Source: "system", ToolName: "CWD", Status: "success", Message: "工作目录已切换: " + msg.RootDir,
		})
		m.stats["success"]++
		m.logOffset = len(m.logs) - 1
		return m, nil

	case StatusMsg:
		m.status = msg.Status
		return m, nil
	}
	return m, nil
}

func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "Initializing..."
	}

	width := maxInt(m.width, 20)
	hero := m.renderHero(width)
	status := m.renderStatusStrip(width)
	auth := m.renderAuthURL(width)
	composer := m.renderComposer(width)

	reservedHeight := lipgloss.Height(hero) + lipgloss.Height(status) + lipgloss.Height(auth) + lipgloss.Height(composer) + 4
	logHeight := m.height - reservedHeight
	if logHeight < 4 {
		hero = m.renderCompactHero(width)
		reservedHeight = lipgloss.Height(hero) + lipgloss.Height(status) + lipgloss.Height(auth) + lipgloss.Height(composer) + 4
		logHeight = m.height - reservedHeight
	}
	logHeight = clampInt(logHeight, 3, maxInt(3, m.height-6))

	view := lipgloss.JoinVertical(lipgloss.Left,
		hero,
		m.renderRule(width),
		status,
		auth,
		m.renderLogs(width, logHeight),
		m.renderRule(width),
		composer,
	)

	return pageStyle.Width(width).Height(m.height).Render(view)
}

func (m Model) renderLogEntry(isActive bool, entry LogEntry) string {
	messageColor := logColor(entry)
	msgWidth := maxInt(8, m.width-6)
	prefix := lipgloss.NewStyle().Foreground(messageColor).Render(" ")
	if isActive {
		prefix = lipgloss.NewStyle().Foreground(messageColor).Render("▌")
	}

	lines := logDisplayLines(entry, msgWidth, m.fullView)
	if len(lines) == 0 {
		lines = []string{""}
	}
	rendered := make([]string, 0, len(lines))
	for i, line := range lines {
		linePrefix := "  "
		if i == 0 {
			linePrefix = prefix + " "
		}
		rendered = append(rendered, linePrefix+logMsgStyle.Foreground(messageColor).Render(line))
	}
	row := strings.Join(rendered, "\n")

	if isActive {
		return lipgloss.NewStyle().Background(colorSurface).Render(row)
	}
	return row
}

func (m Model) renderHero(width int) string {
	if width < 72 || m.height < 18 {
		return m.renderCompactHero(width)
	}

	logo := []string{
		"   ____                  __    _       __  ",
		"  / __ \\____  ___  ____ / /   (_)___  / /__",
		" / / / / __ \\/ _ \\/ __ `/ /   / / __ \\/ //_/",
		"/ /_/ / /_/ /  __/ /_/ / /___/ / / / / ,<   ",
		"\\____/ .___/\\___/\\__,_/_____/_/_/ /_/_/|_|  ",
		"    /_/                                      ",
	}

	lines := make([]string, 0, len(logo)+2)
	for _, line := range logo {
		lines = append(lines, lipgloss.PlaceHorizontal(width, lipgloss.Center, logoStyle.Render(line)))
	}
	lines = append(lines,
		lipgloss.PlaceHorizontal(width, lipgloss.Center, subtitleStyle.Render("OpenLink local AI bridge · browser extension · sandboxed tools")),
		lipgloss.PlaceHorizontal(width, lipgloss.Center, subtitleStyle.Render("Type a message to send it to the active AI page")),
	)
	return strings.Join(lines, "\n")
}

func (m Model) renderCompactHero(width int) string {
	title := logoStyle.Render("OPENLINK")
	meta := subtitleStyle.Render(" local AI bridge")
	return lipgloss.NewStyle().Width(width).Padding(1, 1).Render(title + meta)
}

func (m Model) renderStatusStrip(width int) string {
	statusLabel, statusColor := m.statusLabel()
	dirWidth := clampInt(width-58, 8, 36)
	items := []string{
		m.metric("STATE", statusLabel, statusColor),
		m.metric("PORT", fmt.Sprintf("%d", m.port), colorCyan),
		m.metric("OK", fmt.Sprintf("%d", m.stats["success"]), colorSuccess),
		m.metric("ERR", fmt.Sprintf("%d", m.stats["error"]), colorError),
		m.metric("SENT", fmt.Sprintf("%d", m.stats["pending"]), colorWarning),
	}
	if width >= 82 {
		items = append(items, m.metric("DIR", truncateString(m.rootDir, dirWidth), colorMuted))
	}
	if width >= 104 {
		items = append(items, m.metric("AI", truncateString(m.aiProvider, 22), colorSys))
	}

	line := strings.Join(items, " ")
	return lipgloss.PlaceHorizontal(width, lipgloss.Center, line)
}

func (m Model) metric(label, value string, valueColor lipgloss.Color) string {
	return metricStyle.Render(
		lipgloss.NewStyle().Foreground(colorMuted).Render(label) +
			" " +
			lipgloss.NewStyle().Foreground(valueColor).Bold(true).Render(value),
	)
}

func (m Model) renderAuthURL(width int) string {
	boxWidth := maxInt(12, width-4)
	instruction := "请在浏览器扩展中输入此 URL"
	if m.authURL == "" {
		content := lipgloss.JoinVertical(lipgloss.Left,
			lipgloss.NewStyle().Foreground(colorAccent).Render(strings.Join(wrapString(instruction, boxWidth), "\n")),
			subtitleStyle.Render("认证 URL 生成中..."),
		)
		return lipgloss.NewStyle().Width(width).Background(colorSurface).Padding(0, 1).Render(content)
	}

	body := strings.Join(wrapString(m.authURL, boxWidth), "\n")
	content := lipgloss.JoinVertical(lipgloss.Left,
		lipgloss.NewStyle().Foreground(colorAccent).Render(strings.Join(wrapString(instruction, boxWidth), "\n")),
		lipgloss.NewStyle().Foreground(colorAccent).Render(body),
	)
	return lipgloss.NewStyle().Width(width).Background(colorSurface).Padding(0, 1).Render(content)
}

func (m Model) renderLogs(width, height int) string {
	startIdx := len(m.logs) - height
	if startIdx < 0 {
		startIdx = 0
	}
	if m.logOffset >= 0 && m.logOffset < len(m.logs) {
		targetStart := m.logOffset - height + 1
		if targetStart < 0 {
			targetStart = 0
		}
		if targetStart < startIdx {
			startIdx = targetStart
		}
	}

	lines := make([]string, 0, height)
	if len(m.logs) == 0 {
		empty := "No activity yet. Paste the auth URL in the extension, then type here to send text to the browser."
		lines = append(lines, lipgloss.NewStyle().PaddingLeft(1).Render(subtitleStyle.Render(truncateString(empty, maxInt(10, width-4)))))
	} else {
		for i := startIdx; i < len(m.logs) && len(lines) < height; i++ {
			for _, line := range strings.Split(m.renderLogEntry(i == m.logOffset, m.logs[i]), "\n") {
				if len(lines) >= height {
					break
				}
				lines = append(lines, line)
			}
		}
	}
	for len(lines) < height {
		lines = append(lines, "")
	}

	return lipgloss.NewStyle().Width(width).Height(height).Padding(0, 1).Render(strings.Join(lines, "\n"))
}

func (m Model) renderComposer(width int) string {
	innerWidth := maxInt(12, width-4)
	if m.inputMode {
		cursor := cursorStyle.Render(" ")
		label := lipgloss.NewStyle().Foreground(colorAccent).Render("▌") + " " +
			lipgloss.NewStyle().Foreground(colorText).Bold(true).Render("发到浏览器") + " "
		continuation := strings.Repeat(" ", len([]rune("▌ 发到浏览器 ")))
		inputLines := wrapTextLines(m.input, maxInt(8, innerWidth-len([]rune("▌ 发到浏览器 "))))
		if len(inputLines) == 0 {
			inputLines = []string{""}
		}
		parts := make([]string, 0, len(inputLines)+1)
		for i, line := range inputLines {
			prefix := continuation
			if i == 0 {
				prefix = label
			}
			if i == len(inputLines)-1 {
				line += cursor
			}
			parts = append(parts, prefix+line)
		}
		if m.isSlashInput() {
			if suggestions := m.renderCommandSuggestions(width); suggestions != "" {
				parts = append(parts, suggestions)
			}
		}
		return inputStyle.Width(width).Render(lipgloss.JoinVertical(lipgloss.Left, parts...))
	}

	line := lipgloss.JoinHorizontal(lipgloss.Top,
		lipgloss.NewStyle().Foreground(colorAccent).Render("▌"),
		" ",
		subtitleStyle.Render("输入消息发送到浏览器 · / 指令"),
	)
	return inputStyle.Width(width).Render(line)
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

func (m Model) renderRule(width int) string {
	return ruleStyle.Render(strings.Repeat("─", maxInt(1, width)))
}

func (m Model) statusLabel() (string, lipgloss.Color) {
	switch m.status {
	case "running":
		return "RUNNING", colorSuccess
	case "stopped":
		return "STOPPED", colorError
	default:
		return "STARTING", colorWarning
	}
}

func logColor(entry LogEntry) lipgloss.Color {
	switch entry.Status {
	case "error":
		return colorError
	case "success":
		return colorSuccess
	case "pending":
		return colorWarning
	}

	switch entry.Source {
	case "user":
		return colorUser
	case "ai":
		return colorAI
	default:
		return colorSys
	}
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
}

func (m Model) executeSlashCommand(text string) (tea.Model, tea.Cmd) {
	name, args := parseSlashCommand(text)
	if name == "" {
		m.input = ""
		m.inputMode = false
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
		m.inputMode = false
		m.commandIdx = 0
		m.logOffset = len(m.logs) - 1
		return m, nil
	}

	m.input = ""
	m.inputMode = false
	m.commandIdx = 0

	switch name {
	case "clear":
		m.logs = nil
		m.logOffset = 0
		return m, nil
	case "cwd":
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "info", Message: "当前工作目录: " + m.rootDir})
	case "url":
		msg := "认证 URL 尚未生成"
		if m.authURL != "" {
			msg = "认证 URL: " + m.authURL
		}
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "AUTH", Status: "info", Message: msg})
	case "help":
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "HELP", Status: "info", Message: commandHelpText()})
	case "send":
		if strings.TrimSpace(args) == "" {
			m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "SEND", Status: "error", Message: "/send 需要文本"})
			m.stats["error"]++
			m.logOffset = len(m.logs) - 1
			return m, nil
		}
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "user", ToolName: "INJECT", Status: "pending", Message: args})
		m.stats["pending"]++
		m.logOffset = len(m.logs) - 1
		return m, injectInputCmd(args, m.port, m.token)
	case "cd":
		path := strings.TrimSpace(args)
		if path == "" {
			m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "error", Message: "/cd 需要目录，例如 /cd extension/dist"})
			m.stats["error"]++
			m.logOffset = len(m.logs) - 1
			return m, nil
		}
		m.logs = append(m.logs, LogEntry{Time: time.Now(), Source: "system", ToolName: "CWD", Status: "pending", Message: "正在切换目录: " + path})
		m.stats["pending"]++
		m.logOffset = len(m.logs) - 1
		return m, changeCwdCmd(path, m.port, m.token)
	}

	m.stats["info"]++
	m.logOffset = len(m.logs) - 1
	return m, nil
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
	var lines []string
	for _, cmd := range slashCommandList {
		usage := ""
		if cmd.Usage != "" {
			usage = " " + cmd.Usage
		}
		lines = append(lines, fmt.Sprintf("/%s%s - %s", cmd.Name, usage, cmd.Description))
	}
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
	idx := 0
	for _, r := range value {
		if idx < len(query) && byte(r) == query[idx] {
			idx++
		}
	}
	return idx == len(query)
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

func singleLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

func extractAuthURL(message string) string {
	const marker = "认证 URL:"
	idx := strings.Index(message, marker)
	if idx < 0 {
		return ""
	}
	return strings.TrimSpace(message[idx+len(marker):])
}

func slashRunesToAppend(current, typed string) string {
	if strings.TrimSpace(current) == "/" && strings.HasPrefix(typed, "/") {
		return strings.TrimLeft(typed, "/")
	}
	return typed
}

func normalizeSlashInput(input string) string {
	if strings.HasPrefix(input, "//") {
		return "/" + strings.TrimLeft(input, "/")
	}
	return input
}

func logDisplayLines(entry LogEntry, width int, fullView bool) []string {
	message := entry.Message
	wrap := entry.Source != "ai"
	if fullView && entry.FullMessage != "" {
		message = entry.FullMessage
		wrap = true
	}
	if wrap {
		return wrapTextLines(message, width)
	}

	raw := strings.Split(strings.ReplaceAll(message, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		lines = append(lines, truncateString(line, width))
	}
	return lines
}

func wrapTextLines(s string, width int) []string {
	raw := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		lines = append(lines, wrapString(line, width)...)
	}
	return lines
}

func wrapString(s string, width int) []string {
	if width <= 0 {
		return []string{s}
	}
	runes := []rune(s)
	if len(runes) == 0 {
		return []string{""}
	}
	lines := make([]string, 0, (len(runes)/width)+1)
	for len(runes) > width {
		lines = append(lines, string(runes[:width]))
		runes = runes[width:]
	}
	lines = append(lines, string(runes))
	return lines
}

func trimLastWord(s string) string {
	trimmed := strings.TrimRight(s, " \t")
	if trimmed == "" {
		return ""
	}
	runes := []rune(trimmed)
	for len(runes) > 0 && runes[len(runes)-1] != ' ' && runes[len(runes)-1] != '\t' {
		runes = runes[:len(runes)-1]
	}
	return string(runes)
}

func truncateString(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return string(runes[:maxLen])
	}
	return string(runes[:maxLen-3]) + "..."
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type LogMsg struct {
	Source      string
	ToolName    string
	Status      string
	Message     string
	FullMessage string
}

type StatusMsg struct {
	Status string
}
