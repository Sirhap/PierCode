package executor

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/sirhap/piercode/internal/logsink"
	"github.com/sirhap/piercode/internal/prompt"
	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/types"
)

type Executor struct {
	config    *types.Config
	registry  *tool.Registry
	callCount atomic.Int64
	toolMu    sync.RWMutex
	// logger is read from Execute on every tool call (potentially many
	// goroutines) and written from SetLogger at startup or when the TUI
	// reconfigures. atomic.Pointer keeps the read path lock-free and
	// race-free without forcing every caller through a mutex.
	logger            atomic.Value // stores logsink.Sink
	tasks             *TaskManager
	broadcast         atomic.Pointer[func([]byte)]
	broadcastToClient atomic.Pointer[func(string, []byte) bool]
	browserMu         sync.RWMutex
	browser           tool.BrowserController
}

// SetLogger sets the event sink for real-time feedback. Safe to call
// concurrently with Execute.
func (e *Executor) SetLogger(logger logsink.Sink) {
	e.logger.Store(logger)
}

func (e *Executor) getLogger() logsink.Sink {
	v := e.logger.Load()
	if v == nil {
		return nil
	}
	s, _ := v.(logsink.Sink)
	return s
}

// SetBroadcaster wires a WS-broadcast callback so tools like `question` can
// push events to every connected client. Safe to call concurrently with
// Execute; passing nil disables broadcasting.
func (e *Executor) SetBroadcaster(fn func([]byte)) {
	if fn == nil {
		e.broadcast.Store(nil)
		return
	}
	e.broadcast.Store(&fn)
}

func (e *Executor) SetClientBroadcaster(fn func(string, []byte) bool) {
	if fn == nil {
		e.broadcastToClient.Store(nil)
		return
	}
	e.broadcastToClient.Store(&fn)
}

func (e *Executor) SetBrowserController(controller tool.BrowserController) {
	e.browserMu.Lock()
	e.browser = controller
	e.browserMu.Unlock()
}

// Tasks returns the background task manager owned by this executor.
func (e *Executor) Tasks() *TaskManager {
	return e.tasks
}

func New(config *types.Config) *Executor {
	e := &Executor{
		config:   config,
		registry: tool.NewRegistry(),
		tasks:    NewTaskManager(),
	}
	e.registry.Register(tool.NewExecCmdTool(config))
	e.registry.Register(tool.NewListDirTool(config))
	e.registry.Register(tool.NewReadFileTool(config))
	e.registry.Register(tool.NewWriteFileTool(config))
	e.registry.Register(tool.NewGlobTool(config))
	e.registry.Register(tool.NewGrepTool(config))
	e.registry.Register(tool.NewEditTool(config))
	e.registry.Register(tool.NewWebFetchTool())
	e.registry.Register(tool.NewQuestionTool())
	e.registry.Register(tool.NewSkillTool(config))
	e.registry.Register(tool.NewTodoWriteTool(config))
	e.registry.Register(tool.NewTodoReadTool(config))
	e.registry.Register(tool.NewTaskListTool())
	e.registry.Register(tool.NewTaskOutputTool())
	e.registry.Register(tool.NewTaskStopTool())
	e.registry.Register(tool.NewSendStdinTool())
	e.registry.Register(tool.NewBrowserTabsTool())
	e.registry.Register(tool.NewBrowserNewTabTool())
	e.registry.Register(tool.NewBrowserUseTabTool())
	e.registry.Register(tool.NewBrowserNavigateTool())
	e.registry.Register(tool.NewBrowserSnapshotTool())
	e.registry.Register(tool.NewBrowserClickTool())
	e.registry.Register(tool.NewBrowserTypeTool())
	e.registry.Register(tool.NewBrowserScreenshotTool())
	e.registry.Register(tool.NewBrowserWaitTool())
	e.registry.Register(tool.NewBrowserWaitForFunctionTool())
	e.registry.Register(tool.NewBrowserHoverTool())
	e.registry.Register(tool.NewBrowserScrollTool())
	e.registry.Register(tool.NewBrowserEvaluateTool())
	e.registry.Register(tool.NewBrowserGetContentTool())
	e.registry.Register(tool.NewBrowserSelectTool())
	e.registry.Register(tool.NewBrowserGoBackTool())
	e.registry.Register(tool.NewBrowserGoForwardTool())
	e.registry.Register(tool.NewBrowserReloadTool())
	e.registry.Register(tool.NewBrowserFocusTool())
	e.registry.Register(tool.NewBrowserPressKeyTool())
	e.registry.Register(tool.NewBrowserDragTool())
	e.registry.Register(tool.NewBrowserPDFTool())
	e.registry.Register(tool.NewBrowserUploadTool())
	e.registry.Register(tool.NewBrowserHandleDialogTool())
	e.registry.Register(tool.NewBrowserFindTool())
	e.registry.Register(tool.NewBrowserZoomTool())
	e.registry.Register(tool.NewBrowserResizeTool())
	e.registry.Register(tool.NewBrowserFormInputTool())
	e.registry.Register(tool.NewBrowserConsoleTool())
	e.registry.Register(tool.NewBrowserNetworkTool())
	e.registry.Register(tool.NewBrowserCookiesTool())
	return e
}

// Streamer is the callback signature used to forward live stdout/stderr
// chunks from a streaming tool execution (currently only exec_cmd).
type Streamer func(stream, text string)

// Execute keeps the legacy signature — no live streamer, no background task
// runner. Callers that want streaming should use ExecuteWithStream.
func (e *Executor) Execute(ctx context.Context, req *types.ToolRequest) *types.ToolResponse {
	return e.ExecuteWithStream(ctx, req, nil)
}

// ExecuteWithStream runs a tool with an optional live-output callback. The
// streamer, if non-nil, receives stdout/stderr chunks for streaming-capable
// tools (currently exec_cmd) and is silently ignored for the rest.
func (e *Executor) ExecuteWithStream(ctx context.Context, req *types.ToolRequest, streamer Streamer) *types.ToolResponse {
	log.Printf("[Executor] 执行工具: %s\n", req.Name)

	t, exists := e.registry.Get(req.Name)
	if !exists {
		t, exists = e.registry.Get(strings.ToLower(req.Name))
	}
	if !exists {
		invalid := &tool.InvalidTool{}
		args := copyToolArgs(req.Args, 1)
		args["tool"] = req.Name
		msg := invalid.Execute(&tool.Context{Context: ctx, Args: args, Config: e.config}).Error
		if logger := e.getLogger(); logger != nil {
			logger.LogToolCall(req.Name, "error", "Tool not found")
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	if err := t.Validate(req.Args); err != nil {
		msg := fmt.Sprintf("validation failed: %s", err)
		if logger := e.getLogger(); logger != nil {
			logger.LogToolCall(req.Name, "error", msg)
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	// Always copy Args before handing them to tools. A caller that retries or
	// logs the same ToolRequest should not observe tool-local mutations such
	// as injected call_id values or invalid-tool metadata.
	toolArgs := copyToolArgs(req.Args, 1)
	if req.CallID != "" {
		if _, present := toolArgs["call_id"]; !present {
			toolArgs["call_id"] = req.CallID
		}
	}

	// Snapshot RootDir at request entry so the entire tool call sees a single
	// consistent value. Without this, a concurrent /cwd could swap the global
	// RootDir between e.g. SafePath() and the actual write — the path resolves
	// against root A but writes land under root B.
	rootSnapshot := e.config.GetRootDir()
	toolCtx := &tool.Context{
		Context:    ctx,
		Args:       toolArgs,
		Config:     e.config,
		RootDir:    rootSnapshot,
		TaskRunner: e.tasks,
	}
	e.browserMu.RLock()
	toolCtx.Browser = e.browser
	e.browserMu.RUnlock()
	if streamer != nil {
		toolCtx.Streamer = func(stream, text string) { streamer(stream, text) }
	}
	if bp := e.broadcast.Load(); bp != nil {
		toolCtx.Broadcast = *bp
	}
	if bp := e.broadcastToClient.Load(); bp != nil {
		toolCtx.BroadcastToClient = *bp
	}
	toolCtx.SourceClientID = req.SourceClientID

	unlock := e.lockForTool(req.Name)
	result := t.Execute(toolCtx)
	unlock()

	resp := &types.ToolResponse{
		Name:       req.Name,
		CallID:     req.CallID,
		Status:     result.Status,
		Output:     result.Output,
		Error:      result.Error,
		StopStream: result.StopStream,
	}
	if result.Status == "error" && result.Output == "" {
		resp.Output = result.Error
	}

	// TUI Log: End
	if logger := e.getLogger(); logger != nil {
		logger.LogToolCallFull(req.Name, resp.Status, summarizeToolLog(req, resp), fullToolLog(req, resp))
	}

	// Fix 4: append operating reminders; re-inject full prompt every 20 calls.
	// SECURITY: 之前会优先从 <rootDir>/prompts/init_prompt.txt 读取——但该
	// 路径在 sandbox 内，AI 用 write_file 即可改写，从而永久篡改自己的系统
	// 提示词。改为只信任二进制内嵌的 DefaultPrompt（prompts/prompts.go 通过
	// //go:embed 提供）。
	n := e.callCount.Add(1)
	e.appendPromptGuidance(resp, n, req.Profile)

	return resp
}

const (
	fullPromptReinjectEvery = 20
	taskCheckpointEvery     = 5
)

const operatingReminder = "\n\n[系统提示] 继续以 PierCode 身份执行：工具调用必须使用可见的 `piercode-tool` fenced JSON；所有文件操作保持在当前工作目录/sandbox 内；需要更细规则时加载匹配的 `piercode-*` skill；完成前用测试或明确证据验证。"

const taskCheckpointReminder = "\n\n[任务状态快照提示] 如果当前任务已跨多步或上下文变长，请在下一次回复中简短保留：目标、已完成事项、已改文件、验证结果、下一步/阻塞；必要时用 `todo_write`/`todo_read` 同步待办。"

func (e *Executor) appendPromptGuidance(resp *types.ToolResponse, n int64, profileID string) {
	if n%fullPromptReinjectEvery == 0 {
		rootDir := e.config.GetRootDir()
		profile := prompt.DefaultProfileRegistry(e.config.DefaultPrompt).Select(profileID)
		if len(profile.Prompt) > 0 {
			rendered := profile.Render(rootDir, e.ListTools(), skill.LoadInfos(rootDir))
			resp.Output += "\n\n[系统重新注入提示词]\n" + string(rendered)
		} else {
			resp.Output += operatingReminder
		}
	} else {
		resp.Output += operatingReminder
	}
	if n%taskCheckpointEvery == 0 {
		resp.Output += taskCheckpointReminder
	}
}

func (e *Executor) ListTools() []tool.ToolInfo {
	all := e.registry.List()
	// When the operator hasn't opted in to shell access, hide exec_cmd from
	// the rendered prompt and /tools listing entirely. Otherwise the AI sees
	// it documented, tries it, gets a "exec_cmd is disabled" error, and
	// burns a turn — and the same prompt will trick it again on the next
	// task. Treat absent ≡ unavailable so the AI plans around it from the
	// start (e.g. asks the user to run a command, or uses other tools).
	if e.config != nil && !e.config.AllowShell {
		filtered := all[:0]
		for _, t := range all {
			if strings.EqualFold(t.Name, "exec_cmd") {
				continue
			}
			filtered = append(filtered, t)
		}
		return filtered
	}
	return all
}

func (e *Executor) lockForTool(name string) func() {
	if isReadOnlyTool(name) {
		e.toolMu.RLock()
		return e.toolMu.RUnlock
	}
	e.toolMu.Lock()
	return e.toolMu.Unlock
}

func isReadOnlyTool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "read_file", "list_dir", "glob", "grep", "web_fetch", "skill", "question",
		"todo_read", "task_list", "task_output", "browser_tabs", "browser_snapshot",
		"browser_screenshot", "browser_wait", "browser_wait_for_function", "browser_get_content",
		"browser_pdf", "browser_cookies", "browser_console", "browser_network",
		"browser_find":
		return true
	default:
		return false
	}
}

func summarizeToolLog(req *types.ToolRequest, resp *types.ToolResponse) string {
	const toolPreviewLines = 50
	if resp.Status == "error" {
		if strings.EqualFold(req.Name, "exec_cmd") && strings.TrimSpace(resp.Output) != "" {
			args := req.Args
			if args == nil {
				args = map[string]interface{}{}
			}
			command := argString(args, "command")
			if command == "" {
				command = argString(args, "cmd")
			}
			summary := "Ran " + command
			if msg := strings.TrimSpace(resp.Error); msg != "" {
				summary += " (" + truncateRunes(msg, 80) + ")"
			}
			return summary + outputPreview(resp.Output, toolPreviewLines)
		}
		msg := strings.TrimSpace(resp.Error)
		if msg == "" {
			msg = strings.TrimSpace(resp.Output)
		}
		return fmt.Sprintf("Failed %s: %s", req.Name, truncateRunes(msg, 140))
	}

	args := req.Args
	if args == nil {
		args = map[string]interface{}{}
	}

	switch strings.ToLower(req.Name) {
	case "exec_cmd":
		command := argString(args, "command")
		if command == "" {
			command = argString(args, "cmd")
		}
		return "Ran " + command + outputPreview(resp.Output, toolPreviewLines)
	case "edit":
		path := argString(args, "path")
		oldText := argString(args, "old_string")
		newText := argString(args, "new_string")
		header := fmt.Sprintf("Edited %s (+%d -%d)", path, countLogicalLines(newText), countLogicalLines(oldText))
		return header + editPreview(oldText, newText)
	case "write_file":
		path := argString(args, "path")
		content := argString(args, "content")
		return fmt.Sprintf("Wrote %s (%d lines, %d bytes)", path, countLogicalLines(content), len([]byte(content)))
	case "read_file":
		return "Read " + argString(args, "path") + outputPreview(resp.Output, toolPreviewLines)
	case "list_dir":
		return "Listed " + argString(args, "path") + outputPreview(resp.Output, toolPreviewLines)
	case "grep":
		label := argString(args, "pattern")
		if path := argString(args, "path"); path != "" {
			label += " in " + path
		}
		return "Searched " + label + outputPreview(resp.Output, toolPreviewLines)
	case "glob":
		label := argString(args, "pattern")
		if path := argString(args, "path"); path != "" {
			label += " in " + path
		}
		return "Matched " + label + outputPreview(resp.Output, toolPreviewLines)
	default:
		return strings.TrimSpace(req.Name) + outputPreview(resp.Output, toolPreviewLines)
	}
}

func argString(args map[string]interface{}, key string) string {
	if value, ok := args[key].(string); ok {
		return value
	}
	return ""
}

func outputPreview(output string, maxLines int) string {
	output = strings.TrimSpace(stripCommandEcho(output))
	if output == "" || strings.EqualFold(output, "empty") {
		return ""
	}
	lines := compactLines(output)
	if len(lines) == 0 {
		return ""
	}
	limit := maxLines
	if limit > len(lines) {
		limit = len(lines)
	}
	var b strings.Builder
	for i := 0; i < limit; i++ {
		prefix := " └ "
		if i > 0 {
			prefix = "   "
		}
		b.WriteString("\n")
		b.WriteString(prefix)
		b.WriteString(truncateRunes(lines[i], 120))
	}
	if hidden := len(lines) - limit; hidden > 0 {
		b.WriteString(fmt.Sprintf("\n   … +%d lines (Ctrl+T 查看完整)", hidden))
	}
	return b.String()
}

func fullToolLog(req *types.ToolRequest, resp *types.ToolResponse) string {
	args := req.Args
	if args == nil {
		args = map[string]interface{}{}
	}

	var b strings.Builder
	switch strings.ToLower(req.Name) {
	case "exec_cmd":
		command := argString(args, "command")
		if command == "" {
			command = argString(args, "cmd")
		}
		b.WriteString("Ran ")
		b.WriteString(command)
		appendFullOutput(&b, resp)
	case "edit":
		b.WriteString("Edited ")
		b.WriteString(argString(args, "path"))
		if oldText := argString(args, "old_string"); oldText != "" {
			b.WriteString("\n--- old\n")
			b.WriteString(oldText)
		}
		if newText := argString(args, "new_string"); newText != "" {
			b.WriteString("\n+++ new\n")
			b.WriteString(newText)
		}
		appendFullOutput(&b, resp)
	case "write_file":
		b.WriteString("Wrote ")
		b.WriteString(argString(args, "path"))
		if content := argString(args, "content"); content != "" {
			b.WriteString("\n")
			b.WriteString(content)
		}
		appendFullOutput(&b, resp)
	case "read_file":
		b.WriteString("Read ")
		b.WriteString(argString(args, "path"))
		appendFullOutput(&b, resp)
	case "list_dir":
		b.WriteString("Listed ")
		b.WriteString(argString(args, "path"))
		appendFullOutput(&b, resp)
	case "grep":
		b.WriteString("Searched ")
		b.WriteString(argString(args, "pattern"))
		if path := argString(args, "path"); path != "" {
			b.WriteString(" in ")
			b.WriteString(path)
		}
		appendFullOutput(&b, resp)
	case "glob":
		b.WriteString("Matched ")
		b.WriteString(argString(args, "pattern"))
		if path := argString(args, "path"); path != "" {
			b.WriteString(" in ")
			b.WriteString(path)
		}
		appendFullOutput(&b, resp)
	default:
		b.WriteString(strings.TrimSpace(req.Name))
		appendFullOutput(&b, resp)
	}
	return strings.TrimSpace(b.String())
}

func copyToolArgs(args map[string]interface{}, extra int) map[string]interface{} {
	copied := make(map[string]interface{}, len(args)+extra)
	for k, v := range args {
		copied[k] = v
	}
	return copied
}

func appendFullOutput(b *strings.Builder, resp *types.ToolResponse) {
	output := strings.TrimSpace(stripCommandEcho(resp.Output))
	if output != "" && !strings.EqualFold(output, "empty") {
		b.WriteString("\n")
		b.WriteString(output)
	}
	if resp.Error != "" && !strings.Contains(output, resp.Error) {
		b.WriteString("\n")
		b.WriteString(resp.Error)
	}
}

func stripCommandEcho(output string) string {
	if strings.HasPrefix(output, "command: ") {
		if idx := strings.Index(output, "\n\n"); idx >= 0 {
			return output[idx+2:]
		}
	}
	return output
}

func compactLines(output string) []string {
	raw := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func editPreview(oldText, newText string) string {
	oldLines := compactLines(oldText)
	newLines := compactLines(newText)

	var b strings.Builder
	for _, line := range firstN(oldLines, 3) {
		b.WriteString("\n   - ")
		b.WriteString(truncateRunes(line, 110))
	}
	for _, line := range firstN(newLines, 3) {
		b.WriteString("\n   + ")
		b.WriteString(truncateRunes(line, 110))
	}
	hidden := hiddenPreviewLines(oldLines, 3) + hiddenPreviewLines(newLines, 3)
	if hidden > 0 {
		b.WriteString(fmt.Sprintf("\n   … +%d lines (Ctrl+T 查看完整)", hidden))
	}
	return b.String()
}

func hiddenPreviewLines(lines []string, shown int) int {
	if len(lines) <= shown {
		return 0
	}
	return len(lines) - shown
}

func firstN(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[:n]
}

func countLogicalLines(s string) int {
	if s == "" {
		return 0
	}
	return len(strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n"))
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "…"
}
