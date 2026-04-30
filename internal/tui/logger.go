package tui

import (
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
)

// Logger 用于将后端事件发送到 TUI
type Logger struct {
	program *tea.Program
}

func NewLogger(program *tea.Program) *Logger {
	return &Logger{program: program}
}

// LogToolCall 记录工具调用 (默认为 AI 来源)
func (l *Logger) LogToolCall(toolName, status, message string) {
	l.LogToolCallWithSource("ai", toolName, status, message)
}

func (l *Logger) LogToolCallFull(toolName, status, message, fullMessage string) {
	l.LogToolCallWithSourceFull("ai", toolName, status, message, fullMessage)
}

// LogToolCallWithSource 记录带有明确来源的工具调用
func (l *Logger) LogToolCallWithSource(source, toolName, status, message string) {
	l.LogToolCallWithSourceFull(source, toolName, status, message, "")
}

func (l *Logger) LogToolCallWithSourceFull(source, toolName, status, message, fullMessage string) {
	if l.program != nil {
		l.program.Send(LogMsg{
			Source:      source,
			ToolName:    toolName,
			Status:      status,
			Message:     message,
			FullMessage: fullMessage,
		})
	}
}

func (l *Logger) LogAIResponse(key, message, fullMessage string) {
	if l.program != nil {
		l.program.Send(LogMsg{
			Key:         key,
			Source:      "ai",
			Status:      "info",
			Message:     message,
			FullMessage: fullMessage,
		})
	}
}

// LogStatus 更新服务状态
func (l *Logger) LogStatus(status string) {
	if l.program != nil {
		l.program.Send(StatusMsg{Status: status})
	}
}

// Print 兼容标准 fmt.Print，用于调试 (系统来源)
func (l *Logger) Print(args ...interface{}) {
	msg := fmt.Sprint(args...)
	l.LogToolCallWithSource("system", "SYSTEM", "info", msg)
}

// Printf 兼容标准 fmt.Printf (系统来源)
func (l *Logger) Printf(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	l.LogToolCallWithSource("system", "SYSTEM", "info", msg)
}
