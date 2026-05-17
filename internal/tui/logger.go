package tui

import (
	"fmt"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Cap on accumulated bytes for one background task's stdout/stderr buffer.
// Past this point we keep the head + drop the middle + always retain a tail
// window so the user still sees the most recent output. 256KB matches the
// executor-side cap so the TUI doesn't fall out of sync with /tasks output.
const taskBufCap = 256 * 1024

// taskBufStaleAfter is the safety net for tasks that never send a Done event
// (executor crash, panic, kill -9). The reaper drops their buffers so a long
// running server doesn't leak megabytes of stdout indefinitely.
const taskBufStaleAfter = 30 * time.Minute

// Logger 用于将后端事件发送到 TUI
type Logger struct {
	program      *tea.Program
	mu           sync.Mutex
	printedByKey map[string]string

	taskMu     sync.Mutex
	taskBuf    map[string]*taskBuffer
	reaperOnce sync.Once
	reaperStop chan struct{}
}

// taskBuffer wraps a builder + last-touch timestamp so the reaper can decide
// when a task buffer is stale.
type taskBuffer struct {
	buf       strings.Builder
	updatedAt time.Time
}

func NewLogger(program *tea.Program) *Logger {
	return &Logger{
		program:      program,
		printedByKey: make(map[string]string),
		taskBuf:      make(map[string]*taskBuffer),
		reaperStop:   make(chan struct{}),
	}
}

// Close stops the background reaper goroutine. Safe to call multiple times.
// Optional — for tests or graceful shutdown; the reaper will also exit when
// the process does.
func (l *Logger) Close() {
	l.reaperOnce.Do(func() {
		close(l.reaperStop)
	})
}

func (l *Logger) startReaperOnce() {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-l.reaperStop:
				return
			case <-ticker.C:
				l.reapStaleTaskBuffers(time.Now())
			}
		}
	}()
}

func (l *Logger) reapStaleTaskBuffers(now time.Time) {
	l.taskMu.Lock()
	defer l.taskMu.Unlock()
	for id, b := range l.taskBuf {
		if now.Sub(b.updatedAt) >= taskBufStaleAfter {
			delete(l.taskBuf, id)
		}
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
		// SECURITY/UX: route everything through the model's transcript via
		// LogMsg. We used to also `program.Println(...)` for ai-tool calls,
		// which doubled every event on screen (once as a tool card in the
		// transcript and once as a raw line above it). The transcript path
		// is the canonical view; the model decides how to render it.
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

// LogBrowserCount reports how many browser extensions are currently connected.
// Replaces the older pattern of stuffing the count into a free-text "BROWSER"
// log message that the TUI re-parsed with a `(N)` regex. The structured form
// avoids parsing-induced bugs such as treating `(retrying)` as 0.
func (l *Logger) LogBrowserCount(count int) {
	if l.program != nil {
		l.program.Send(BrowserCountMsg{Count: count})
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
//
// Buffer size is capped at taskBufCap; once exceeded we keep the most recent
// tail to avoid unbounded growth from `tail -f` style commands. Without this
// a long-running task would keep extending the buffer + ship the entire
// blob through every LogMsg, freezing the UI on each render.
func (l *Logger) LogTaskStream(taskID, callID, stream, text string) {
	if l.program == nil || strings.TrimSpace(text) == "" {
		return
	}
	l.reaperOnce.Do(l.startReaperOnce)

	l.taskMu.Lock()
	defer l.taskMu.Unlock()

	tb, ok := l.taskBuf[taskID]
	if !ok {
		tb = &taskBuffer{}
		l.taskBuf[taskID] = tb
	}
	tb.updatedAt = time.Now()
	tb.buf.WriteString(text)

	// Trim once we cross the cap. We slice on bytes; UTF-8 boundary is fine
	// because we drop a chunk that's well past the visible window.
	full := tb.buf.String()
	if len(full) > taskBufCap {
		// Keep the last taskBufCap bytes; prepend a marker so the user knows.
		const marker = "…[earlier output truncated]\n"
		full = marker + full[len(full)-taskBufCap+len(marker):]
		tb.buf.Reset()
		tb.buf.WriteString(full)
	}

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
	if tb, ok := l.taskBuf[taskID]; ok {
		full = tb.buf.String()
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
