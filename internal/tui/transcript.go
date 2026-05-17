package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

type TurnStatus string

const (
	turnPending TurnStatus = "pending"
	turnError   TurnStatus = "error"
)

type ToolRun struct {
	Key         string
	Name        string
	Status      string
	Message     string
	FullMessage string
	StartedAt   time.Time
	UpdatedAt   time.Time
}

type SystemNotice struct {
	Status  string
	Message string
	Time    time.Time
}

type Turn struct {
	ID            string
	StartedAt     time.Time
	UpdatedAt     time.Time
	UserKey       string
	UserText      string
	AssistantKey  string
	AssistantText string
	Status        TurnStatus
	Tools         []ToolRun
	Notices       []SystemNotice
}

func (m Model) renderTranscript(width, height int) string {
	if m.fullView && m.hasActiveFullLog() {
		return m.renderLogs(width, height)
	}

	contentWidth := maxInt(8, width-4)
	lines := make([]string, 0, height)
	if len(m.turns) == 0 {
		empty := "openlink> 直接输入消息发送到 AI 页面，/ 查看指令，Esc 后可滚动转录。"
		lines = append(lines, lipgloss.NewStyle().PaddingLeft(1).Render(subtitleStyle.Render(truncateString(empty, maxInt(10, width-4)))))
	} else {
		for _, turn := range m.turns {
			lines = append(lines, m.renderTurnLines(turn, contentWidth)...)
		}
	}

	if len(lines) > height {
		maxOffset := len(lines) - height
		offset := maxOffset
		if m.transcriptOffset >= 0 {
			offset = clampInt(m.transcriptOffset, 0, maxOffset)
		}
		lines = lines[offset : offset+height]
	} else {
		more := make([]string, 0, height)
		more = append(more, lines...)
		lines = more
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	return lipgloss.NewStyle().Width(width).Height(height).Padding(0, 1).Render(strings.Join(lines, "\n"))
}

func (m Model) renderTurnLines(turn Turn, width int) []string {
	lines := make([]string, 0, 4+len(turn.Tools)*4)
	if strings.TrimSpace(turn.UserText) != "" {
		prefix := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("openlink>")
		for i, line := range wrapTextLines(turn.UserText, maxInt(8, width-10)) {
			if i == 0 {
				lines = append(lines, prefix+" "+lipgloss.NewStyle().Foreground(colorUser).Render(line))
			} else {
				lines = append(lines, strings.Repeat(" ", len([]rune("openlink> ")))+lipgloss.NewStyle().Foreground(colorUser).Render(line))
			}
		}
	}

	for _, notice := range turn.Notices {
		style := subtitleStyle
		if notice.Status == "error" {
			style = lipgloss.NewStyle().Foreground(colorError)
		}
		for _, line := range wrapTextLines("system  "+notice.Message, width) {
			lines = append(lines, "  "+style.Render(line))
		}
	}

	if strings.TrimSpace(turn.AssistantText) != "" {
		lines = append(lines, lipgloss.NewStyle().Foreground(colorAI).Bold(true).Render("assistant"))
		lines = append(lines, renderMarkdownLines(turn.AssistantText, width-2, "  ")...)
	}

	for _, tool := range turn.Tools {
		entry := LogEntry{Source: "ai", ToolName: tool.Name, Status: tool.Status, Message: tool.Message, FullMessage: tool.FullMessage}
		for i, line := range logDisplayLines(entry, width-4, false, m.detailMode) {
			if i == 0 {
				lines = append(lines, "  "+lipgloss.NewStyle().Foreground(logColor(entry)).Bold(true).Render("tool "+line))
				continue
			}
			lines = append(lines, "    "+logLineStyle(entry, line, i, logColor(entry)).Render(line))
		}
	}

	if len(lines) > 0 {
		lines = append(lines, "")
	}
	return lines
}

func (m *Model) recordUserPrompt(text string) {
	wasFollowing := m.isFollowingTranscript()
	now := time.Now()
	m.turnSeq++
	turnID := fmt.Sprintf("turn-%d", m.turnSeq)
	m.turns = append(m.turns, Turn{
		ID:        turnID,
		StartedAt: now,
		UpdatedAt: now,
		UserText:  text,
		Status:    turnPending,
	})
	m.logs = append(m.logs, LogEntry{
		Time: now, Source: "user", ToolName: "INJECT", Status: "pending", Message: text,
	})
	m.stats["pending"]++
	m.logOffset = len(m.logs) - 1
	m.followTranscriptIfNeeded(wasFollowing)
	m.addInputHistory(text)
}

func (m *Model) addInputHistory(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if len(m.inputHistory) > 0 && m.inputHistory[len(m.inputHistory)-1] == text {
		return
	}
	m.inputHistory = append(m.inputHistory, text)
	if len(m.inputHistory) > 100 {
		m.inputHistory = m.inputHistory[len(m.inputHistory)-100:]
	}
}

func (m *Model) recallInputHistory(delta int) {
	if len(m.inputHistory) == 0 {
		return
	}
	if m.historyIdx < 0 {
		if delta < 0 {
			m.historyDraft = m.input
			m.historyDraftPos = m.normalizedInputCursor()
			m.historyIdx = len(m.inputHistory) - 1
		} else {
			return
		}
	} else {
		next := m.historyIdx + delta
		if next >= len(m.inputHistory) {
			m.input = m.historyDraft
			m.inputCursor = clampInt(m.historyDraftPos, 0, len([]rune(m.input)))
			m.resetHistoryRecall()
			return
		}
		m.historyIdx = clampInt(next, 0, len(m.inputHistory)-1)
	}
	m.input = m.inputHistory[m.historyIdx]
	m.inputCursor = len([]rune(m.input))
}

func (m *Model) resetHistoryRecall() {
	m.historyIdx = -1
	m.historyDraft = ""
	m.historyDraftPos = 0
}

func (m *Model) latestTurn() *Turn {
	if len(m.turns) == 0 {
		return nil
	}
	return &m.turns[len(m.turns)-1]
}

func (m *Model) ensureTurn() *Turn {
	if turn := m.latestTurn(); turn != nil {
		return turn
	}
	now := time.Now()
	m.turnSeq++
	m.turns = append(m.turns, Turn{
		ID:        fmt.Sprintf("turn-%d", m.turnSeq),
		StartedAt: now,
		UpdatedAt: now,
		Status:    turnPending,
	})
	return &m.turns[len(m.turns)-1]
}

func (m *Model) findTurnByUserKey(key string) *Turn {
	if key == "" {
		return nil
	}
	for i := range m.turns {
		if m.turns[i].UserKey == key {
			return &m.turns[i]
		}
	}
	return nil
}

func (m *Model) findTurnByAssistantKey(key string) *Turn {
	if key == "" {
		return nil
	}
	for i := range m.turns {
		if m.turns[i].AssistantKey == key {
			return &m.turns[i]
		}
	}
	return nil
}

func (m *Model) findTurnByToolKey(key string) (*Turn, *ToolRun) {
	if key == "" {
		return nil, nil
	}
	for i := range m.turns {
		for j := range m.turns[i].Tools {
			if m.turns[i].Tools[j].Key == key {
				return &m.turns[i], &m.turns[i].Tools[j]
			}
		}
	}
	return nil, nil
}

func (m *Model) isFollowingTranscript() bool {
	return m.transcriptOffset < 0
}

func (m *Model) followTranscriptIfNeeded(wasFollowing bool) {
	if wasFollowing {
		m.transcriptOffset = -1
	}
}

func (m *Model) appendSystemNotice(status, message string) {
	wasFollowing := m.isFollowingTranscript()
	turn := m.ensureTurn()
	now := time.Now()
	turn.Notices = append(turn.Notices, SystemNotice{Status: status, Message: message, Time: now})
	turn.UpdatedAt = now
	if status == "error" {
		turn.Status = turnError
	}
	m.followTranscriptIfNeeded(wasFollowing)
}

func (m *Model) applyLogToTranscript(entry LogEntry) {
	if entry.Source == "user" {
		text := strings.TrimSpace(entry.Message)
		if text == "" {
			return
		}
		if turn := m.findTurnByUserKey(entry.Key); turn != nil {
			return
		}
		if latest := m.latestTurn(); latest != nil && strings.TrimSpace(latest.UserText) == text && latest.UserKey == "" {
			latest.UserKey = entry.Key
			return
		}
		wasFollowing := m.isFollowingTranscript()
		now := time.Now()
		m.turnSeq++
		m.turns = append(m.turns, Turn{
			ID:        fmt.Sprintf("turn-%d", m.turnSeq),
			StartedAt: now,
			UpdatedAt: now,
			UserKey:   entry.Key,
			UserText:  text,
			Status:    turnPending,
		})
		m.followTranscriptIfNeeded(wasFollowing)
		return
	}
	if entry.Source == "ai" && strings.TrimSpace(entry.ToolName) == "" {
		wasFollowing := m.isFollowingTranscript()
		turn := m.findTurnByAssistantKey(entry.Key)
		if turn == nil {
			turn = m.ensureTurn()
			if entry.Key != "" {
				turn.AssistantKey = entry.Key
			}
		}
		turn.AssistantText = entry.Message
		turn.UpdatedAt = time.Now()
		if entry.Status == "error" {
			turn.Status = turnError
		}
		m.followTranscriptIfNeeded(wasFollowing)
		return
	}
	if entry.Source == "ai" && strings.TrimSpace(entry.ToolName) != "" {
		wasFollowing := m.isFollowingTranscript()
		now := time.Now()
		if turn, tool := m.findTurnByToolKey(entry.Key); tool != nil {
			tool.Status = entry.Status
			tool.Message = entry.Message
			tool.FullMessage = entry.FullMessage
			tool.UpdatedAt = now
			turn.UpdatedAt = now
			m.followTranscriptIfNeeded(wasFollowing)
			return
		}
		turn := m.ensureTurn()
		key := entry.Key
		if key == "" {
			key = fmt.Sprintf("%s-%d", entry.ToolName, len(turn.Tools)+1)
		}
		turn.Tools = append(turn.Tools, ToolRun{
			Key:         key,
			Name:        entry.ToolName,
			Status:      entry.Status,
			Message:     entry.Message,
			FullMessage: entry.FullMessage,
			StartedAt:   now,
			UpdatedAt:   now,
		})
		turn.UpdatedAt = now
		if entry.Status == "error" {
			turn.Status = turnError
		}
		m.followTranscriptIfNeeded(wasFollowing)
		return
	}
	if entry.Source == "system" && strings.TrimSpace(entry.Message) != "" {
		if strings.EqualFold(entry.ToolName, "BROWSER") || strings.EqualFold(entry.ToolName, "SYSTEM") {
			return
		}
		m.appendSystemNotice(entry.Status, entry.Message)
	}
}
