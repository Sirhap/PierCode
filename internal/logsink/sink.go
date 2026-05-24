// Package logsink defines the event sink interface used by the server and
// executor to report tool calls, AI responses, and background task progress.
//
// Previously the TUI package owned this as a concrete type coupled to
// bubbletea. This package decouples the contract so the server can run
// headless (MCP mode) while the TUI can still provide a rich implementation.
package logsink

// Sink is the interface the server and executor use to emit structured events.
type Sink interface {
	LogToolCall(toolName, status, message string)
	LogToolCallFull(toolName, status, message, fullMessage string)
	LogToolCallWithSource(source, toolName, status, message string)
	LogAIResponse(key, message, fullMessage string)
	LogUserPrompt(key, message string)
	LogBrowserStatus(count int, providers map[string]int)
	LogTaskStream(taskID, callID, stream, text string)
	LogTaskDone(taskID, callID string, exitCode int, status, errMsg string, durationMs int64)
}

// NopSink is a Sink that does nothing. Used when no TUI or external logger
// is attached (headless / MCP mode).
type NopSink struct{}

func (NopSink) LogToolCall(string, string, string)                     {}
func (NopSink) LogToolCallFull(string, string, string, string)         {}
func (NopSink) LogToolCallWithSource(string, string, string, string)   {}
func (NopSink) LogAIResponse(string, string, string)                   {}
func (NopSink) LogUserPrompt(string, string)                           {}
func (NopSink) LogBrowserStatus(int, map[string]int)                   {}
func (NopSink) LogTaskStream(string, string, string, string)           {}
func (NopSink) LogTaskDone(string, string, int, string, string, int64) {}
