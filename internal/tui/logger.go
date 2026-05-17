package tui

import (
	"fmt"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
)

// Logger 用于将后端事件发送到 TUI
type Logger struct {
	program      *tea.Program
	mu           sync.Mutex
	printedByKey map[string]string

	taskMu  sync.Mutex
	taskBuf map[string]*strings.Builder
}

func NewLogger(program *tea.Program) *Logger {
	return &Logger{
		program:      program,
		printedByKey: make(map[string]string),
		taskBuf:      make(map[string]*strings.Builder),
	}
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
		if source == "ai" && strings.TrimSpace(toolName) != "" {
			l.program.Println(formatTranscriptToolLine(toolName, status, message))
		}
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
		l.printAssistantDelta(key, firstNonEmpty(fullMessage, message))
	}
}

func (l *Logger) LogUserPrompt(key, message string) {
	if l.program != nil {
		l.program.Send(LogMsg{
			Key:     key,
			Source:  "user",
			Status:  "pending",
			Message: message,
		})
		l.program.Println("piercode> " + strings.TrimSpace(message))
	}
}

func (l *Logger) printAssistantDelta(key, text string) {
	text = strings.TrimRight(text, "\n")
	if strings.TrimSpace(text) == "" {
		return
	}
	if key == "" {
		key = "assistant"
	}

	l.mu.Lock()
	last := l.printedByKey[key]
	if last == text {
		l.mu.Unlock()
		return
	}
	l.printedByKey[key] = text
	l.mu.Unlock()

	delta := assistantPrintDelta(last, text)
	if strings.TrimSpace(delta) == "" {
		return
	}
	prefix := "assistant> "
	if last != "" && strings.HasPrefix(text, last) {
		prefix = ""
	}
	l.program.Println(prefix + delta)
}

func assistantPrintDelta(last, text string) string {
	if strings.HasPrefix(text, last) {
		return strings.TrimLeft(text[len(last):], "\n")
	}
	if last != "" {
		return "[updated]\n" + text
	}
	return text
}

func formatTranscriptToolLine(toolName, status, message string) string {
	line := singleLine(message)
	if line == "" {
		line = status
	}
	return fmt.Sprintf("tool[%s] %s: %s", toolName, status, line)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// LogStatus 更新服务状态
func (l *Logger) LogStatus(status string) {
	if l.program != nil {
		l.program.Send(StatusMsg{Status: status})
	}
}

// LogTaskStream forwards a stdout/stderr chunk from a background exec_cmd
// task into the TUI transcript. Chunks are accumulated per task_id and the
// LogMsg uses that accumulated text so the model's findTurnByToolKey can
// keep updating a single ToolRun in place.
//
// Send is performed under taskMu together with the append so two concurrent
// streams (stdout + stderr from the same task) can't deliver LogMsgs whose
// FullMessage values cross over and leave the UI showing a stale prefix.
func (l *Logger) LogTaskStream(taskID, callID, stream, text string) {
	if l.program == nil || strings.TrimSpace(text) == "" {
		return
	}
	l.taskMu.Lock()
	defer l.taskMu.Unlock()

	buf, ok := l.taskBuf[taskID]
	if !ok {
		buf = &strings.Builder{}
		l.taskBuf[taskID] = buf
	}
	buf.WriteString(text)
	full := buf.String()

	short := singleLine(full)
	if short == "" {
		short = "(running…)"
	}

	key := "bg-task:" + taskID
	l.program.Send(LogMsg{
		Key:         key,
		Source:      "system",
		ToolName:    "exec_cmd",
		Status:      "running",
		Message:     "Background " + taskID + " (" + stream + "): " + truncateRunesForLog(short, 120),
		FullMessage: full,
	})
}

// LogTaskDone marks a background task as finished in the transcript and
// drops its buffered output. status mirrors executor.TaskStatus.
//
// The Send happens under taskMu so it is strictly ordered after every
// LogTaskStream Send for the same task (both helpers serialize through the
// same mutex), preventing a late-arriving stream LogMsg from overwriting the
// done status.
func (l *Logger) LogTaskDone(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
	if l.program == nil {
		return
	}
	l.taskMu.Lock()
	defer l.taskMu.Unlock()

	full := ""
	if buf, ok := l.taskBuf[taskID]; ok {
		full = buf.String()
		delete(l.taskBuf, taskID)
	}

	summary := fmt.Sprintf("Background %s finished (status=%s, exit=%d, %.1fs)",
		taskID, status, exitCode, float64(durationMs)/1000.0)
	if errMsg != "" {
		summary += " — " + truncateRunesForLog(errMsg, 80)
	}
	tuiStatus := "success"
	if status != "done" || exitCode != 0 {
		tuiStatus = "error"
	}
	key := "bg-task:" + taskID
	l.program.Send(LogMsg{
		Key:         key,
		Source:      "system",
		ToolName:    "exec_cmd",
		Status:      tuiStatus,
		Message:     summary,
		FullMessage: summary + "\n\n" + full,
	})
}

func truncateRunesForLog(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	if max <= 1 {
		return string(r[:max])
	}
	return string(r[:max-1]) + "…"
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
