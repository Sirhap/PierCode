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

func (m Model) renderTranscript(width int) string {
	if m.fullView && m.hasActiveFullLog() {
		return m.renderLogs(width)
	}
	if m.fullView {
		if text, ok := m.latestToolResponsePromptText(); ok {
			return m.renderFullToolResponsePrompt(width, text)
		}
	}

	contentWidth := maxInt(8, width-4)
	lines := make([]string, 0)
	if len(m.turns) == 0 {
		empty := "piercode> 直接输入消息发送到 AI 页面，/ 查看指令，Esc 后可滚动转录。"
		lines = append(lines, lipgloss.NewStyle().PaddingLeft(1).Render(subtitleStyle.Render(truncateString(empty, maxInt(10, width-4)))))
	} else {
		for _, turn := range m.turns {
			lines = append(lines, m.renderTurnLines(turn, contentWidth)...)
		}
	}

	if m.transcriptOffset >= 0 {
		lines = constrainToHeight(lines, m.activityHeight(width), m.transcriptOffset)
	}

	return lipgloss.NewStyle().Width(width).Padding(0, 1).Render(strings.Join(lines, "\n"))
}

func (m *Model) renderTurnLines(turn Turn, width int) []string {
	// Cache key: (turnID, UpdatedAt unix nanos, width, detailMode). Any time
	// content / layout / view-options change we recompute; otherwise we serve
	// from the cache. Without this, transcriptMaxOffset / scrollTranscript /
	// View all walk every turn through markdown + wrap on every keypress,
	// which made PgUp/PgDn visibly stutter once a session had ~50 turns.
	if m.transcriptLineCache != nil {
		if cached, ok := m.transcriptLineCache[turn.ID]; ok &&
			cached.width == width &&
			cached.detailMode == m.detailMode &&
			cached.updatedAt.Equal(turn.UpdatedAt) {
			return cached.lines
		}
	}
	lines := m.computeTurnLines(turn, width)
	if m.transcriptLineCache != nil {
		m.transcriptLineCache[turn.ID] = turnLinesCacheEntry{
			updatedAt:  turn.UpdatedAt,
			width:      width,
			detailMode: m.detailMode,
			lines:      lines,
		}
	}
	return lines
}

func (m *Model) computeTurnLines(turn Turn, width int) []string {
	lines := make([]string, 0, 4+len(turn.Tools)*4)
	if strings.TrimSpace(turn.UserText) != "" {
		prefix := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("piercode>")
		for i, line := range renderUserTextLines(turn.UserText, maxInt(8, width-10)) {
			if i == 0 {
				lines = append(lines, prefix+" "+lipgloss.NewStyle().Foreground(colorUser).Render(line))
			} else {
				lines = append(lines, strings.Repeat(" ", len([]rune("piercode> ")))+lipgloss.NewStyle().Foreground(colorUser).Render(line))
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

type toolResponsePromptSummary struct {
	Name   string
	CallID string
	Lines  int
}

func renderUserTextLines(text string, width int) []string {
	if summaries, ok := summarizeToolResponsePrompt(text); ok {
		lines := make([]string, 0, len(summaries))
		for _, summary := range summaries {
			label := fmt.Sprintf("工具响应 %s", summary.Name)
			if summary.CallID != "" {
				label += " #" + summary.CallID
			}
			if summary.Lines > 0 {
				label += fmt.Sprintf(" … +%d lines", summary.Lines)
			} else {
				label += " …"
			}
			lines = append(lines, truncateString(label, width))
		}
		return lines
	}
	return wrapTextLines(text, width)
}

func summarizeToolResponsePrompt(text string) ([]toolResponsePromptSummary, bool) {
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	summaries := make([]toolResponsePromptSummary, 0)
	current := -1
	for _, line := range raw {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || isSystemReminderLine(trimmed) {
			continue
		}
		if name, callID, ok := parseToolResponseHeading(trimmed); ok {
			summaries = append(summaries, toolResponsePromptSummary{Name: name, CallID: callID})
			current = len(summaries) - 1
			continue
		}
		if current < 0 {
			return nil, false
		}
		summaries[current].Lines++
	}
	return summaries, len(summaries) > 0
}

func parseToolResponseHeading(line string) (string, string, bool) {
	const prefix = "### "
	if !strings.HasPrefix(line, prefix) {
		return "", "", false
	}
	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(line, prefix)))
	if len(fields) < 2 || !strings.HasPrefix(fields[1], "#") {
		return "", "", false
	}
	name := strings.TrimSpace(fields[0])
	callID := strings.TrimPrefix(strings.TrimSpace(fields[1]), "#")
	if name == "" || callID == "" {
		return "", "", false
	}
	return name, callID, true
}

func isSystemReminderLine(line string) bool {
	return strings.HasPrefix(line, "[系统提示]")
}

func (m Model) latestToolResponsePromptText() (string, bool) {
	for i := len(m.turns) - 1; i >= 0; i-- {
		text := m.turns[i].UserText
		if _, ok := summarizeToolResponsePrompt(text); ok {
			return text, true
		}
	}
	return "", false
}

func (m Model) hasFullToolResponsePrompt() bool {
	_, ok := m.latestToolResponsePromptText()
	return ok
}

func (m Model) fullToolResponsePromptLineCount(width int) int {
	text, ok := m.latestToolResponsePromptText()
	if !ok {
		return 0
	}
	return len(wrapTextLines(stripANSI(text), maxInt(8, width-4)))
}

func (m Model) renderFullToolResponsePrompt(width int, text string) string {
	height := m.activityHeight(width)
	msgWidth := maxInt(8, width-4)
	all := wrapTextLines(stripANSI(text), msgWidth)
	offset := clampInt(m.fullOffset, 0, len(all))
	lines := make([]string, 0, len(all)-offset+1)
	for i := offset; i < len(all); i++ {
		prefix := "  "
		if i == 0 {
			prefix = lipgloss.NewStyle().Foreground(colorUser).Render("▌") + " "
		}
		lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorUser).Render(all[i]))
	}
	if len(all) > 0 {
		lines = append(lines, subtitleStyle.Render(truncateString(fmt.Sprintf("  %d-%d/%d  j/k 滚动  Ctrl+T 返回摘要", offset+1, len(all), len(all)), msgWidth)))
	}
	lines = constrainToHeight(lines, height, -1)
	return lipgloss.NewStyle().Width(width).Padding(0, 1).Render(strings.Join(lines, "\n"))
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
			// Returning past the most recent history item: restore the
			// original draft the user was composing before they pressed ↑.
			// Keep historyDraft populated so a subsequent ↑ can re-enter
			// history without losing the draft again — bash/zsh behavior.
			m.input = m.historyDraft
			m.inputCursor = clampInt(m.historyDraftPos, 0, len([]rune(m.input)))
			m.historyIdx = -1
			return
		}
		m.historyIdx = clampInt(next, 0, len(m.inputHistory)-1)
	}
	m.input = m.inputHistory[m.historyIdx]
	m.inputCursor = len([]rune(m.input))
}

func (m *Model) resetHistoryRecall() {
	// Don't drop the draft on every keystroke — only when the user actively
	// abandons history navigation (Ctrl+C / Ctrl+U / submit). Editing the
	// recalled item is fine; the draft we want to keep is the *original*
	// content typed before history navigation started.
	m.historyIdx = -1
}

// clearHistoryDraft drops the saved draft. Called on submit / explicit clear.
func (m *Model) clearHistoryDraft() {
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
	if isRenderableToolLog(entry) {
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
		if strings.EqualFold(entry.ToolName, "SYSTEM") {
			return
		}
		m.appendSystemNotice(entry.Status, entry.Message)
	}
}
