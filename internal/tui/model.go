package tui

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"

	skillpkg "github.com/sirhap/piercode/internal/skill"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// LogEntry 代表一条日志记录
type LogEntry struct {
	Key         string
	Time        time.Time
	Source      string // "user", "ai", "system"
	ToolName    string
	Status      string // success, error, pending, info
	Message     string
	FullMessage string
}

// Model 是 TUI 的核心状态
type Model struct {
	logs             []LogEntry
	turns            []Turn
	status           string
	port             int
	rootDir          string
	aiProvider       string
	token            string
	width            int
	height           int
	logOffset        int
	stats            map[string]int
	input            string
	inputCursor      int
	inputMode        bool
	authURL          string
	commandIdx       int
	fullView         bool
	fullOffset       int
	detailMode       bool
	browserClients   int
	logsMode         bool
	turnSeq          int
	transcriptOffset int
	inputHistory     []string
	historyIdx       int
	historyDraft     string
	historyDraftPos  int

	// mouseCapture 控制是否在 bubbletea 层吃掉鼠标事件用来滚动。
	// 默认关闭，因为开启后用户用鼠标选中复制时会被 TUI 拦截，不知道按 Option
	// 才能 escape 是常见踩坑。需要鼠标滚动滚 transcript 时，用 /mouse 切换。
	mouseCapture bool

	// lastEnter records the timestamp of the previous Enter press for IME
	// confirmation: when CJK input is detected, an Enter that lands within
	// 80ms of a real character keypress is treated as candidate-word
	// confirmation and silently absorbed. The next Enter (or any Enter > 80ms
	// after the last char) submits normally.
	lastEnter   time.Time
	lastKeyRune time.Time

	// transcriptLineCache 缓存 renderTurnLines 的结果，按 (turnID,UpdatedAt,width)
	// 失效。避免 PgUp/PgDn 每按一次都全量重渲染所有 turn × markdown。
	transcriptLineCache map[string]turnLinesCacheEntry
}

type turnLinesCacheEntry struct {
	updatedAt  time.Time
	width      int
	detailMode bool
	lines      []string
}

// 样式定义
var (
	colorCanvas  = lipgloss.Color("#FFFFFF")
	colorSurface = lipgloss.Color("#FFFFFF")
	colorLine    = lipgloss.Color("#CBD5E1")
	colorAccent  = lipgloss.Color("#6D28D9")
	colorCyan    = lipgloss.Color("#0369A1")
	colorSuccess = lipgloss.Color("#166534")
	colorError   = lipgloss.Color("#B91C1C")
	colorWarning = lipgloss.Color("#9A3412")
	colorMuted   = lipgloss.Color("#475569")
	colorText    = lipgloss.Color("#111827")

	// 角色区分颜色
	colorUser = lipgloss.Color("#92400E")
	colorAI   = lipgloss.Color("#075985")
	colorSys  = lipgloss.Color("#6D28D9")

	pageStyle     = lipgloss.NewStyle().Foreground(colorText)
	canvasStyle   = lipgloss.NewStyle().Background(colorCanvas).Foreground(colorText)
	logoStyle     = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	subtitleStyle = lipgloss.NewStyle().Foreground(colorMuted)
	ruleStyle     = lipgloss.NewStyle().Foreground(colorLine)
	metricStyle   = lipgloss.NewStyle().Foreground(colorText).Padding(0, 1)
	logMsgStyle   = lipgloss.NewStyle().Foreground(colorText)

	inputStyle  = lipgloss.NewStyle().Padding(0, 1)
	cursorStyle = lipgloss.NewStyle().Background(colorAccent).Foreground(lipgloss.Color("#FFFFFF"))
	keyStyle    = lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
)

func NewModel(port int, rootDir, aiProvider string, token ...string) Model {
	authToken := ""
	if len(token) > 0 {
		authToken = token[0]
	}
	return Model{
		logs:                make([]LogEntry, 0),
		turns:               make([]Turn, 0),
		status:              "starting",
		port:                port,
		rootDir:             rootDir,
		aiProvider:          aiProvider,
		token:               authToken,
		authURL:             authURLForToken(port, authToken),
		stats:               map[string]int{"success": 0, "error": 0, "pending": 0, "info": 0},
		inputCursor:         -1,
		inputMode:           true,
		transcriptOffset:    -1,
		historyIdx:          -1,
		mouseCapture:        false, // 默认关掉，让鼠标选中复制走系统层
		transcriptLineCache: make(map[string]turnLinesCacheEntry),
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

func injectInputCmd(text string, port int, token string) tea.Cmd {
	return func() tea.Msg {
		text = sanitizeInjectText(text)
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

func initPromptCmd(port int, token string) tea.Cmd {
	return func() tea.Msg {
		client := &http.Client{Timeout: 10 * time.Second}
		promptURL := fmt.Sprintf("http://127.0.0.1:%d/prompt", port)
		req, err := http.NewRequest(http.MethodGet, promptURL, nil)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("初始化请求创建失败: %v", err)}
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("获取初始化提示词失败: %v", err)}
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("获取初始化提示词失败 HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))}
		}

		promptText := strings.TrimSpace(string(body))
		if promptText == "" {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: "初始化提示词为空"}
		}

		payload, err := json.Marshal(map[string]string{"text": promptText})
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("初始化提示词编码失败: %v", err)}
		}

		injectURL := fmt.Sprintf("http://127.0.0.1:%d/inject", port)
		injectReq, err := http.NewRequest(http.MethodPost, injectURL, bytes.NewReader(payload))
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("发送初始化请求创建失败: %v", err)}
		}
		injectReq.Header.Set("Content-Type", "application/json")
		if token != "" {
			injectReq.Header.Set("Authorization", "Bearer "+token)
		}
		injectResp, err := client.Do(injectReq)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("发送初始化提示词失败: %v", err)}
		}
		defer injectResp.Body.Close()

		injectBody, _ := io.ReadAll(injectResp.Body)
		if injectResp.StatusCode < 200 || injectResp.StatusCode >= 300 {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("发送初始化提示词失败 HTTP %d: %s", injectResp.StatusCode, strings.TrimSpace(string(injectBody)))}
		}

		var decoded injectResponse
		if err := json.Unmarshal(injectBody, &decoded); err != nil {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: fmt.Sprintf("初始化发送响应解析失败: %v", err)}
		}
		if decoded.Clients == 0 {
			return LogMsg{Source: "system", ToolName: "INIT", Status: "error", Message: "未连接浏览器扩展，请刷新 AI 页面或重新配置插件"}
		}
		return LogMsg{Source: "system", ToolName: "INIT", Status: "success", Message: fmt.Sprintf("初始化提示词已发送到 %d 个浏览器页面", decoded.Clients)}
	}
}

func skillPromptCmd(rootDir, skillName string, port int, token string) tea.Cmd {
	return func() tea.Msg {
		info, ok := skillpkg.Get(rootDir, skillName)
		if !ok {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("skill %q 不存在", skillName)}
		}
		data, err := os.ReadFile(info.Location)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("读取 skill 失败: %v", err)}
		}
		text := formatSkillPrompt(info, string(data))
		payload, err := json.Marshal(map[string]string{"text": text})
		if err != nil {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("skill 编码失败: %v", err)}
		}

		client := &http.Client{Timeout: 10 * time.Second}
		injectURL := fmt.Sprintf("http://127.0.0.1:%d/inject", port)
		req, err := http.NewRequest(http.MethodPost, injectURL, bytes.NewReader(payload))
		if err != nil {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("发送 skill 请求创建失败: %v", err)}
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("发送 skill 失败: %v", err)}
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("发送 skill 失败 HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))}
		}
		var decoded injectResponse
		if err := json.Unmarshal(body, &decoded); err != nil {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: fmt.Sprintf("skill 发送响应解析失败: %v", err)}
		}
		if decoded.Clients == 0 {
			return LogMsg{Source: "system", ToolName: "SKILL", Status: "error", Message: "未连接浏览器扩展，请刷新 AI 页面或重新配置插件"}
		}
		return LogMsg{Source: "system", ToolName: "SKILL", Status: "success", Message: fmt.Sprintf("skill %q 已发送到 %d 个浏览器页面", info.Name, decoded.Clients)}
	}
}

func formatSkillPrompt(info skillpkg.Info, content string) string {
	return fmt.Sprintf("请加载并遵循这个 PierCode skill。\n\n<skill_content name=%q>\nIMPORTANT: All file paths referenced in this skill must use absolute paths. The skill directory is: %s\n\n%s\n</skill_content>",
		info.Name,
		info.Dir,
		strings.TrimSpace(content),
	)
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
			// Bracketed-paste safety: when the terminal sends a paste, bubbletea
			// flags KeyMsg.Paste=true. Treat the whole paste as literal text
			// regardless of its byte type — newlines inside should NOT trigger
			// submit, an embedded "/" should NOT open the slash picker. Without
			// this, pasting "ls\necho hi\n" runs as 3 separate submits.
			if msg.Paste {
				m.clearHistoryDraft()
				m.insertInput(string(msg.Runes))
				m.clampCommandSelection()
				return m, nil
			}
			switch msg.Type {
			case tea.KeyEnter:
				if msg.Alt {
					m.resetHistoryRecall()
					m.insertInput("\n")
					m.clampCommandSelection()
					return m, nil
				}
				// IME safety: only treat Enter as candidate-confirmation when
				// it arrives RIGHT AFTER a CJK character keypress (within
				// 80ms). A "cold" Enter pressed by an idle user always
				// submits, so this is invisible to non-IME workflows and
				// auto-tests that fire Enter directly. The 80ms window
				// matches typical IME confirm-then-Enter rhythm.
				if containsCJK(m.input) && !m.lastKeyRune.IsZero() &&
					time.Since(m.lastKeyRune) < 80*time.Millisecond {
					m.lastKeyRune = time.Time{}
					return m, nil
				}
				text := sanitizeInjectText(m.input)
				if text != "" {
					if strings.HasPrefix(text, "/") {
						return m.executeSlashCommand(text)
					}
					m.recordUserPrompt(text)
					m.input = ""
					m.inputCursor = 0
					m.inputMode = true
					m.clearHistoryDraft()
					return m, tea.Batch(tea.Println("piercode> "+text), injectInputCmd(text, m.port, m.token))
				}
				m.input = ""
				m.inputCursor = 0
				m.inputMode = true
				return m, nil
			case tea.KeyCtrlC:
				if strings.TrimSpace(m.input) == "" {
					return m, tea.Quit
				}
				m.input = ""
				m.inputCursor = 0
				m.commandIdx = 0
				m.clearHistoryDraft()
				return m, nil
			case tea.KeyEscape:
				// Layered escape — close the topmost overlay first instead of
				// nuking everything. Old behavior cleared the entire input on
				// every Esc, which destroyed long prompts with no undo.
				// Order: full view → slash suggestions → switch to browse mode
				// → finally clear input on a second press.
				if m.fullView {
					m.fullView = false
					m.fullOffset = 0
					return m, nil
				}
				if m.isSlashInput() {
					// Drop the leading "/" so the suggestion popup goes away,
					// but keep whatever else the user typed.
					trimmed := strings.TrimSpace(m.input)
					if strings.HasPrefix(trimmed, "/") {
						m.input = strings.TrimPrefix(m.input, "/")
						m.inputCursor = clampInt(m.inputCursor-1, 0, len([]rune(m.input)))
						m.commandIdx = 0
						return m, nil
					}
				}
				if strings.TrimSpace(m.input) != "" {
					// Has content but no overlay: switch to browse mode while
					// preserving the draft. A second Esc from browse mode
					// cycles back to input.
					m.inputMode = false
					return m, nil
				}
				m.inputMode = false
				m.resetHistoryRecall()
				return m, nil
			case tea.KeyCtrlJ:
				m.resetHistoryRecall()
				m.insertInput("\n")
				m.clampCommandSelection()
				return m, nil
			case tea.KeyCtrlT:
				m.fullView = !m.fullView
				m.fullOffset = 0
				return m, nil
			case tea.KeyCtrlD:
				m.detailMode = !m.detailMode
				return m, nil
			case tea.KeyTab:
				m.completeSlashInput()
				return m, nil
			case tea.KeyLeft:
				cursor := m.normalizedInputCursor()
				if cursor > 0 {
					m.inputCursor = cursor - 1
				}
				return m, nil
			case tea.KeyRight:
				cursor := m.normalizedInputCursor()
				if cursor < len([]rune(m.input)) {
					m.inputCursor = cursor + 1
				}
				return m, nil
			case tea.KeyHome:
				m.inputCursor = 0
				return m, nil
			case tea.KeyEnd:
				m.inputCursor = len([]rune(m.input))
				return m, nil
			case tea.KeyUp:
				if m.fullView && m.hasActiveFullLog() {
					if m.fullOffset > 0 {
						m.fullOffset--
					}
					return m, nil
				}
				if m.isSlashInput() {
					m.moveCommandSelection(-1)
					return m, nil
				}
				// Multi-line input: ↑ moves cursor up one visual line within
				// the input. Single-line: walks back through history. Earlier
				// code silently swallowed ↑ in multi-line, leaving no way to
				// reach earlier lines without Home/Backspace.
				if strings.Contains(m.input, "\n") {
					m.moveCursorByLine(-1)
					return m, nil
				}
				m.recallInputHistory(-1)
				return m, nil
			case tea.KeyDown:
				if m.fullView && m.hasActiveFullLog() {
					m.fullOffset++
					return m, nil
				}
				if m.isSlashInput() {
					m.moveCommandSelection(1)
					return m, nil
				}
				if strings.Contains(m.input, "\n") {
					m.moveCursorByLine(1)
					return m, nil
				}
				m.recallInputHistory(1)
				return m, nil
			case tea.KeyPgUp, tea.KeyCtrlUp:
				return m.handleScroll(-3), nil
			case tea.KeyPgDown, tea.KeyCtrlDown:
				return m.handleScroll(3), nil
			case tea.KeyCtrlU:
				m.clearHistoryDraft()
				m.input = ""
				m.inputCursor = 0
				m.commandIdx = 0
				return m, nil
			case tea.KeyCtrlW:
				m.resetHistoryRecall()
				m.input = trimLastWord(m.input)
				m.inputCursor = len([]rune(m.input))
				m.clampCommandSelection()
				return m, nil
			case tea.KeyBackspace:
				m.resetHistoryRecall()
				m.deleteInputBeforeCursor()
				m.clampCommandSelection()
				return m, nil
			case tea.KeyRunes:
				m.resetHistoryRecall()
				m.insertInput(slashRunesToAppend(m.input, string(msg.Runes)))
				m.clampCommandSelection()
				// Track last char keypress for IME timing heuristic.
				m.lastKeyRune = time.Now()
				return m, nil
			case tea.KeySpace:
				m.resetHistoryRecall()
				m.insertInput(" ")
				return m, nil
			}
			return m, nil
		}

		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "ctrl+t":
			m.fullView = !m.fullView
			m.fullOffset = 0
			return m, nil
		case "ctrl+d":
			m.detailMode = !m.detailMode
			return m, nil
		case "i":
			m.inputMode = true
			m.input = ""
			m.inputCursor = 0
			m.commandIdx = 0
			return m, nil
		case "/":
			m.inputMode = true
			m.input = "/"
			m.inputCursor = len([]rune(m.input))
			m.commandIdx = 0
			return m, nil
		case "up", "k":
			if m.fullView && m.hasActiveFullLog() {
				if m.fullOffset > 0 {
					m.fullOffset--
				}
				return m, nil
			}
			if !m.logsMode {
				return m.scrollTranscript(-1), nil
			}
			// logsMode: ↑ shows OLDER content. Earlier code did logOffset--
			// which actually trimmed displayed entries from the bottom — the
			// opposite of what the arrow direction implies. Now: scroll the
			// active marker up one entry and the renderer will show the
			// older entries naturally.
			if m.logOffset > 0 {
				m.logOffset--
				m.fullOffset = 0
			}
			return m, nil
		case "down", "j":
			if m.fullView && m.hasActiveFullLog() {
				m.fullOffset++
				return m, nil
			}
			if !m.logsMode {
				return m.scrollTranscript(1), nil
			}
			if m.logOffset < len(m.logs)-1 {
				m.logOffset++
				m.fullOffset = 0
			}
			return m, nil
		case "home", "g":
			if m.fullView && m.hasActiveFullLog() {
				m.fullOffset = 0
				return m, nil
			}
			if !m.logsMode {
				m.transcriptOffset = 0
				return m, nil
			}
			// logsMode home: jump to oldest entry. Setting logOffset=0 was
			// fine here — the bug was on ↑ direction, not on Home.
			m.logOffset = 0
			m.fullOffset = 0
			return m, nil
		case "end", "G":
			if m.fullView && m.hasActiveFullLog() {
				m.fullOffset = maxInt(0, len(logDisplayLines(m.logs[m.logOffset], maxInt(8, m.width-6), true, m.detailMode))-1)
				return m, nil
			}
			if !m.logsMode {
				m.transcriptOffset = -1
				return m, nil
			}
			if len(m.logs) > 0 {
				m.logOffset = len(m.logs) - 1
			}
			m.fullOffset = 0
			return m, nil
		}
		if msg.Type == tea.KeyRunes && len(msg.Runes) > 0 {
			m.inputMode = true
			m.input = normalizeSlashInput(string(msg.Runes))
			m.inputCursor = len([]rune(m.input))
			m.commandIdx = 0
		}
		return m, nil

	case tea.MouseMsg:
		switch msg.Type {
		case tea.MouseWheelUp:
			return m.handleScroll(-3), nil
		case tea.MouseWheelDown:
			return m.handleScroll(3), nil
		}
		return m, nil

	case LogMsg:
		if authURL := extractAuthURL(msg.Message); authURL != "" {
			m.authURL = authURL
			return m, nil
		}
		// Note: BROWSER count is now delivered through BrowserCountMsg below;
		// any legacy LogMsg with ToolName=="BROWSER" still flows into the
		// transcript as a plain notice but no longer drives the PAGE metric.
	if msg.Key != "" {
		for i := len(m.logs) - 1; i >= 0; i-- {
			if m.logs[i].Key == msg.Key {
				oldStatus := m.logs[i].Status
				m.logs[i].Time = time.Now()
				m.logs[i].Source = msg.Source
				m.logs[i].ToolName = msg.ToolName
				m.logs[i].Status = msg.Status
				m.logs[i].Message = msg.Message
				m.logs[i].FullMessage = msg.FullMessage
				m.logOffset = i
				if oldStatus != msg.Status {
					m.stats[oldStatus]--
					m.stats[msg.Status]++
				}
				m.applyLogToTranscript(m.logs[i])
				return m, nil
			}
		}
	}
		entry := LogEntry{
			Key: msg.Key, Time: time.Now(), Source: msg.Source, ToolName: msg.ToolName, Status: msg.Status, Message: msg.Message, FullMessage: msg.FullMessage,
		}
		m.logs = append(m.logs, entry)
		m.stats[msg.Status]++
		m.logOffset = len(m.logs) - 1
		m.applyLogToTranscript(entry)
		return m, nil

	case cwdChangedMsg:
		m.rootDir = msg.RootDir
		entry := LogEntry{
			Time: time.Now(), Source: "system", ToolName: "CWD", Status: "success", Message: "工作目录已切换: " + msg.RootDir,
		}
		m.logs = append(m.logs, entry)
		m.stats["success"]++
		m.logOffset = len(m.logs) - 1
		m.appendSystemNotice(entry.Status, entry.Message)
		return m, nil

	case StatusMsg:
		m.status = msg.Status
		return m, nil
	case BrowserCountMsg:
		m.browserClients = msg.Count
		return m, nil
	}
	return m, nil
}

func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "Initializing..."
	}

	width := maxInt(m.width, 20)
	hero := m.renderCompactHero(width)
	status := m.renderStatusStrip(width)
	auth := m.renderAuthURL(width)
	composer := m.renderComposer(width)
	logHeight := m.activityHeight(width)

	view := lipgloss.JoinVertical(lipgloss.Left,
		hero,
		m.renderRule(width),
		status,
		auth,
		m.renderActivity(width, logHeight),
		m.renderRule(width),
		composer,
	)

	return renderCanvas(view, width, m.height)
}

func (m Model) activityHeight(width int) int {
	if m.height == 0 {
		return 10
	}
	hero := m.renderCompactHero(width)
	status := m.renderStatusStrip(width)
	auth := m.renderAuthURL(width)
	composer := m.renderComposer(width)
	reservedHeight := lipgloss.Height(hero) + lipgloss.Height(status) + lipgloss.Height(auth) + lipgloss.Height(composer) + 4
	logHeight := m.height - reservedHeight
	return clampInt(logHeight, 3, maxInt(3, m.height-6))
}

func renderCanvas(view string, width, height int) string {
	lines := strings.Split(view, "\n")
	if len(lines) > height {
		lines = lines[:height]
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	for i, line := range lines {
		lines[i] = canvasStyle.Width(width).Render(pageStyle.Render(line))
	}
	return strings.Join(lines, "\n")
}

func (m Model) renderLogEntry(isActive bool, entry LogEntry) string {
	messageColor := logColor(entry)
	msgWidth := maxInt(8, m.width-6)
	prefix := lipgloss.NewStyle().Foreground(messageColor).Render(" ")
	if isActive {
		prefix = lipgloss.NewStyle().Foreground(messageColor).Render("▌")
	}

	lines := logDisplayLines(entry, msgWidth, m.fullView && isActive, m.detailMode && isActive)
	if len(lines) == 0 {
		lines = []string{""}
	}
	rendered := make([]string, 0, len(lines))
	for i, line := range lines {
		linePrefix := "  "
		if i == 0 {
			linePrefix = prefix + " "
		}
		rendered = append(rendered, linePrefix+logLineStyle(entry, line, i, messageColor).Render(line))
	}
	row := strings.Join(rendered, "\n")

	if isActive {
		return row
	}
	return row
}

func (m Model) hasActiveFullLog() bool {
	return m.logOffset >= 0 && m.logOffset < len(m.logs) && m.logs[m.logOffset].FullMessage != ""
}

func (m Model) handleScroll(delta int) Model {
	if delta == 0 {
		return m
	}
	if m.fullView && m.hasActiveFullLog() {
		m.fullOffset = maxInt(0, m.fullOffset+delta)
		return m
	}
	if !m.logsMode {
		return m.scrollTranscript(delta)
	}
	if len(m.logs) == 0 {
		return m
	}
	if m.logOffset < 0 || m.logOffset >= len(m.logs) {
		m.logOffset = len(m.logs) - 1
	}
	m.logOffset = clampInt(m.logOffset+delta, 0, len(m.logs)-1)
	m.fullOffset = 0
	return m
}

func (m Model) scrollTranscript(delta int) Model {
	maxOffset := m.transcriptMaxOffset()
	current := maxOffset
	if m.transcriptOffset >= 0 {
		current = clampInt(m.transcriptOffset, 0, maxOffset)
	}
	next := clampInt(current+delta, 0, maxOffset)
	if next >= maxOffset {
		m.transcriptOffset = -1
	} else {
		m.transcriptOffset = next
	}
	return m
}

func (m Model) transcriptMaxOffset() int {
	width := maxInt(m.width, 20)
	height := m.activityHeight(width)
	contentWidth := maxInt(8, width-4)
	lineCount := 1
	if len(m.turns) > 0 {
		lineCount = 0
		for _, turn := range m.turns {
			lineCount += len(m.renderTurnLines(turn, contentWidth))
		}
	}
	return maxInt(0, lineCount-height)
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
		lipgloss.PlaceHorizontal(width, lipgloss.Center, subtitleStyle.Render("PierCode local AI bridge · browser extension · sandboxed tools")),
		lipgloss.PlaceHorizontal(width, lipgloss.Center, subtitleStyle.Render("Type a message to send it to the active AI page")),
	)
	return strings.Join(lines, "\n")
}

func (m Model) renderCompactHero(width int) string {
	title := logoStyle.Render("PierCode")
	meta := subtitleStyle.Render(fmt.Sprintf("  local AI bridge  port %d", m.port))
	return lipgloss.NewStyle().Width(width).Padding(0, 1).Render(title + meta)
}

func (m Model) renderStatusStrip(width int) string {
	statusLabel, statusColor := m.statusLabel()
	dirWidth := clampInt(width-58, 8, 36)
	items := []string{
		m.metric("STATE", statusLabel, statusColor),
		m.metric("PORT", fmt.Sprintf("%d", m.port), colorCyan),
		m.metric("PAGE", fmt.Sprintf("%d", m.browserClients), browserClientsColor(m.browserClients)),
		m.metric("OK", fmt.Sprintf("%d", m.stats["success"]), colorSuccess),
		m.metric("ERR", fmt.Sprintf("%d", m.stats["error"]), colorError),
		m.metric("SENT", fmt.Sprintf("%d", m.stats["pending"]), colorWarning),
	}
	if m.detailMode {
		items = append(items, m.metric("VIEW", "DETAIL", colorAccent))
	}
	if m.logsMode {
		items = append(items, m.metric("MODE", "LOGS", colorWarning))
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

func browserClientsColor(count int) lipgloss.Color {
	if count > 0 {
		return colorSuccess
	}
	return colorMuted
}

func (m Model) renderAuthURL(width int) string {
	boxWidth := maxInt(12, width-4)
	instruction := "请在浏览器扩展中输入此 URL"
	if m.authURL == "" {
		content := lipgloss.JoinVertical(lipgloss.Left,
			lipgloss.NewStyle().Foreground(colorAccent).Render(strings.Join(wrapString(instruction, boxWidth), "\n")),
			subtitleStyle.Render("认证 URL 生成中..."),
		)
		return lipgloss.NewStyle().Width(width).Padding(0, 1).Render(content)
	}

	body := strings.Join(wrapString(m.authURL, boxWidth), "\n")
	content := lipgloss.JoinVertical(lipgloss.Left,
		lipgloss.NewStyle().Foreground(colorAccent).Render(strings.Join(wrapString(instruction, boxWidth), "\n")),
		lipgloss.NewStyle().Foreground(colorAccent).Render(body),
	)
	return lipgloss.NewStyle().Width(width).Padding(0, 1).Render(content)
}

func (m Model) renderLogs(width, height int) string {
	if m.fullView && m.hasActiveFullLog() {
		entry := m.logs[m.logOffset]
		msgWidth := maxInt(8, m.width-6)
		all := logDisplayLines(entry, msgWidth, true, m.detailMode)
		maxOffset := maxInt(0, len(all)-height)
		offset := clampInt(m.fullOffset, 0, maxOffset)
		lines := make([]string, 0, height)
		for i := offset; i < len(all) && len(lines) < height; i++ {
			prefix := "  "
			if i == 0 {
				prefix = lipgloss.NewStyle().Foreground(logColor(entry)).Render("▌") + " "
			}
			lines = append(lines, prefix+logLineStyle(entry, all[i], i, logColor(entry)).Render(all[i]))
		}
		if len(all) > height {
			hint := fmt.Sprintf("  %d-%d/%d  j/k 滚动  Ctrl+T 返回摘要", offset+1, minInt(offset+len(lines), len(all)), len(all))
			if len(lines) < height {
				lines = append(lines, subtitleStyle.Render(truncateString(hint, maxInt(8, width-4))))
			}
		}
		for len(lines) < height {
			lines = append(lines, "")
		}
		return lipgloss.NewStyle().Width(width).Height(height).Padding(0, 1).Render(strings.Join(lines, "\n"))
	}

	lines := make([]string, 0, height)
	if len(m.logs) == 0 {
		empty := "No activity yet. Paste the auth URL in the extension, then type here to send text to the browser."
		lines = append(lines, lipgloss.NewStyle().PaddingLeft(1).Render(subtitleStyle.Render(truncateString(empty, maxInt(10, width-4)))))
	} else {
		endIdx := len(m.logs) - 1
		if m.logOffset >= 0 && m.logOffset < len(m.logs) {
			endIdx = m.logOffset
		}
		for i := 0; i <= endIdx; i++ {
			for _, line := range strings.Split(m.renderLogEntry(i == m.logOffset, m.logs[i]), "\n") {
				lines = append(lines, line)
			}
		}
		if len(lines) > height {
			lines = lines[len(lines)-height:]
		}
	}
	for len(lines) < height {
		lines = append(lines, "")
	}

	return lipgloss.NewStyle().Width(width).Height(height).Padding(0, 1).Render(strings.Join(lines, "\n"))
}

func (m Model) renderActivity(width, height int) string {
	if m.logsMode {
		return m.renderLogs(width, height)
	}
	return m.renderTranscript(width, height)
}

func (m Model) renderComposer(width int) string {
	innerWidth := maxInt(12, width-4)
	if m.inputMode {
		label := lipgloss.NewStyle().Foreground(colorAccent).Render("▌") + " " +
			lipgloss.NewStyle().Foreground(colorText).Bold(true).Render("piercode>") + " "
		continuation := strings.Repeat(" ", len([]rune("▌ piercode> ")))
		inputLines := renderInputLinesWithCursor(m.input, m.normalizedInputCursor(), maxInt(8, innerWidth-len([]rune("▌ piercode> "))))
		parts := make([]string, 0, len(inputLines)+1)
		for i, line := range inputLines {
			prefix := continuation
			if i == 0 {
				prefix = label
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
		subtitleStyle.Render("Esc 浏览转录 · / 指令 · i 返回输入 · Ctrl+D 详情"),
	)
	return inputStyle.Width(width).Render(line)
}

func (m *Model) insertInput(text string) {
	if text == "" {
		return
	}
	runes := []rune(m.input)
	cursor := m.normalizedInputCursor()
	insert := []rune(text)
	next := make([]rune, 0, len(runes)+len(insert))
	next = append(next, runes[:cursor]...)
	next = append(next, insert...)
	next = append(next, runes[cursor:]...)
	m.input = string(next)
	m.inputCursor = cursor + len(insert)
}

func (m *Model) deleteInputBeforeCursor() {
	runes := []rune(m.input)
	cursor := m.normalizedInputCursor()
	if cursor == 0 {
		return
	}
	next := make([]rune, 0, len(runes)-1)
	next = append(next, runes[:cursor-1]...)
	next = append(next, runes[cursor:]...)
	m.input = string(next)
	m.inputCursor = cursor - 1
}

func (m Model) normalizedInputCursor() int {
	runes := []rune(m.input)
	if m.inputCursor < 0 {
		return len(runes)
	}
	return clampInt(m.inputCursor, 0, len(runes))
}

// moveCursorByLine shifts the input cursor up (-1) or down (+1) one logical
// line within m.input, preserving the column when possible. Used by ↑/↓ when
// the input contains newlines so multi-line composition is editable.
func (m *Model) moveCursorByLine(delta int) {
	runes := []rune(m.input)
	cursor := m.normalizedInputCursor()
	// Find current line bounds + column.
	lineStart := cursor
	for lineStart > 0 && runes[lineStart-1] != '\n' {
		lineStart--
	}
	col := cursor - lineStart

	if delta < 0 {
		// Move to previous line: scan back past the \n at lineStart-1, find
		// that line's start, and clamp col to its length.
		if lineStart == 0 {
			return // already on first line; let caller decide history fallback
		}
		prevEnd := lineStart - 1 // the \n char
		prevStart := prevEnd
		for prevStart > 0 && runes[prevStart-1] != '\n' {
			prevStart--
		}
		prevLen := prevEnd - prevStart
		newCol := col
		if newCol > prevLen {
			newCol = prevLen
		}
		m.inputCursor = prevStart + newCol
		return
	}

	// delta > 0: move to next line.
	lineEnd := cursor
	for lineEnd < len(runes) && runes[lineEnd] != '\n' {
		lineEnd++
	}
	if lineEnd >= len(runes) {
		return // already on last line
	}
	nextStart := lineEnd + 1
	nextEnd := nextStart
	for nextEnd < len(runes) && runes[nextEnd] != '\n' {
		nextEnd++
	}
	nextLen := nextEnd - nextStart
	newCol := col
	if newCol > nextLen {
		newCol = nextLen
	}
	m.inputCursor = nextStart + newCol
}

func renderInputLinesWithCursor(input string, cursor int, width int) []string {
	const marker = "\x00"
	runes := []rune(input)
	cursor = clampInt(cursor, 0, len(runes))
	display := string(runes[:cursor]) + marker + string(runes[cursor:])
	lines := wrapTextLines(display, width)
	if len(lines) == 0 {
		lines = []string{marker}
	}
	for i, line := range lines {
		lines[i] = strings.ReplaceAll(line, marker, cursorStyle.Render(" "))
	}
	return lines
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

func logLineStyle(entry LogEntry, line string, lineIndex int, fallback lipgloss.Color) lipgloss.Style {
	style := logMsgStyle.Foreground(fallback)
	if isFoldedSummaryLine(line) {
		return logMsgStyle.Foreground(colorMuted)
	}
	if entry.Source == "ai" && isCommandLog(entry) && lineIndex == 0 {
		return logMsgStyle.Foreground(logColor(entry)).Bold(true)
	}
	if entry.Source == "ai" && isCommandLine(line) {
		return logMsgStyle.Foreground(colorCyan).Bold(true)
	}
	if isDiffAddLine(line) {
		return logMsgStyle.Foreground(colorSuccess)
	}
	if isDiffDeleteLine(line) {
		return logMsgStyle.Foreground(colorError)
	}
	if isDiffHunkLine(line) || isCodeFenceLine(line) {
		return logMsgStyle.Foreground(colorMuted)
	}
	if entry.Source == "ai" && isOutputDetailLine(line) {
		return logMsgStyle.Foreground(colorText)
	}
	return style
}

func isCommandLog(entry LogEntry) bool {
	name := strings.ToLower(entry.ToolName)
	return strings.Contains(name, "exec") || strings.Contains(name, "cmd") || strings.Contains(entry.Message, "Ran ")
}

func isFoldedSummaryLine(line string) bool {
	return strings.Contains(line, "…") || strings.Contains(strings.ToLower(line), "omitted") || strings.Contains(line, "...")
}

func isOutputDetailLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return strings.HasPrefix(trimmed, "└") || strings.HasPrefix(trimmed, "|") || strings.HasPrefix(trimmed, ">")
}

func isCommandLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "> ")
}

func isDiffAddLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return strings.HasPrefix(trimmed, "+") && !strings.HasPrefix(trimmed, "+++")
}

func isDiffDeleteLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return strings.HasPrefix(trimmed, "-") && !strings.HasPrefix(trimmed, "---")
}

func isDiffHunkLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "@@")
}

func isCodeFenceLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "```")
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

func extractTrailingCount(message string) int {
	start := strings.LastIndex(message, "(")
	end := strings.LastIndex(message, ")")
	if start < 0 || end <= start+1 {
		return 0
	}
	var count int
	if _, err := fmt.Sscanf(message[start+1:end], "%d", &count); err != nil {
		return 0
	}
	return count
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

func sanitizeInjectText(input string) string {
	return strings.TrimLeftFunc(input, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || isInvisiblePrefixRune(r)
	})
}

func isInvisiblePrefixRune(r rune) bool {
	switch r {
	case '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2060', '\uFEFF', '\uFFFC', '\uFFFD', '\u25A1':
		return true
	default:
		return false
	}
}

func logDisplayLines(entry LogEntry, width int, fullView bool, detailMode bool) []string {
	message := entry.Message
	wrap := entry.Source != "ai"
	if fullView && entry.FullMessage != "" {
		message = entry.FullMessage
		wrap = true
	}
	// SECURITY: command output / AI text is untrusted; strip terminal escape
	// sequences before any wrapping or styling. Without this an `exec_cmd`
	// running e.g. `printf '\e[2J'` would clear the entire TUI from under us.
	message = stripANSI(message)
	if entry.Source == "ai" && isToolLog(entry) {
		return toolLogDisplayLines(entry, message, width, fullView, detailMode)
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

func isToolLog(entry LogEntry) bool {
	return strings.TrimSpace(entry.ToolName) != ""
}

func toolLogDisplayLines(entry LogEntry, message string, width int, fullView bool, detailMode bool) []string {
	tool := strings.TrimSpace(entry.ToolName)
	if tool == "" {
		tool = "tool"
	}

	header := strings.TrimSpace(fmt.Sprintf("%s  %s", tool, strings.ToUpper(entry.Status)))
	lines := []string{truncateString(header, width)}
	if detailMode {
		lines = append(lines, truncateString("status  "+entry.Status, width))
		if entry.FullMessage != "" && !fullView {
			lines = append(lines, truncateString("detail  Ctrl+T 查看完整输出", width))
		}
	}

	raw := strings.Split(strings.ReplaceAll(message, "\r\n", "\n"), "\n")
	if len(raw) == 0 {
		return lines
	}
	first := strings.TrimSpace(raw[0])
	bodyStart := 0
	if command, ok := commandFromSummary(first); ok {
		lines = append(lines, truncateString("> "+command, width))
		bodyStart = 1
	}

	for _, line := range raw[bodyStart:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		for _, wrapped := range wrapString(strings.TrimRight(line, "\r"), width) {
			lines = append(lines, wrapped)
		}
	}
	return lines
}

func commandFromSummary(line string) (string, bool) {
	const ran = "Ran "
	if !strings.HasPrefix(line, ran) {
		return "", false
	}
	command := strings.TrimSpace(strings.TrimPrefix(line, ran))
	return command, command != ""
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
	// Display-width aware: a CJK char counts as 2 columns. The earlier rune-
	// count implementation overflowed lines (50 中 = 100 cols passed through
	// when width=80 because 50 < 80) and pushed the status strip / dividers
	// into ragged alignment. See helpers.go.
	return wrapByDisplayWidth(s, width)
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
	// Display-width aware truncation. maxLen is interpreted as terminal
	// columns, not rune count, so CJK strings don't overflow the budget.
	return truncateToDisplayWidth(s, maxLen)
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
	Key         string
	Source      string
	ToolName    string
	Status      string
	Message     string
	FullMessage string
}

type StatusMsg struct {
	Status string
}

// BrowserCountMsg is the typed channel server uses to report how many
// extensions are currently connected. Earlier versions stuffed the count
// into a free-text BROWSER log message and re-parsed it on the TUI side
// with a regex of "(N)" — which silently turned "(retrying)" into 0.
// Use this instead.
type BrowserCountMsg struct {
	Count int
}
