package executor

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/afumu/openlink/internal/prompt"
	"github.com/afumu/openlink/internal/tool"
	"github.com/afumu/openlink/internal/tui"
	"github.com/afumu/openlink/internal/types"
)

type Executor struct {
	config    *types.Config
	registry  *tool.Registry
	callCount atomic.Int64
	logger    *tui.Logger // Optional TUI logger
}

// SetLogger sets the TUI logger for real-time feedback
func (e *Executor) SetLogger(logger *tui.Logger) {
	e.logger = logger
}

func New(config *types.Config) *Executor {
	e := &Executor{
		config:   config,
		registry: tool.NewRegistry(),
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
	return e
}

func (e *Executor) Execute(ctx context.Context, req *types.ToolRequest) *types.ToolResponse {
	log.Printf("[Executor] 执行工具: %s\n", req.Name)

	t, exists := e.registry.Get(req.Name)
	if !exists {
		t, exists = e.registry.Get(strings.ToLower(req.Name))
	}
	if !exists {
		invalid := &tool.InvalidTool{}
		args := req.Args
		if args == nil {
			args = map[string]interface{}{}
		}
		args["tool"] = req.Name
		msg := invalid.Execute(&tool.Context{Context: ctx, Args: args, Config: e.config}).Error
		if e.logger != nil {
			e.logger.LogToolCall(req.Name, "error", "Tool not found")
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	if err := t.Validate(req.Args); err != nil {
		msg := fmt.Sprintf("validation failed: %s", err)
		if e.logger != nil {
			e.logger.LogToolCall(req.Name, "error", msg)
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	result := t.Execute(&tool.Context{
		Context: ctx,
		Args:    req.Args,
		Config:  e.config,
	})

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
	if e.logger != nil {
		e.logger.LogToolCallFull(req.Name, resp.Status, summarizeToolLog(req, resp), fullToolLog(req, resp))
	}

	// Fix 4: append identity reminder; re-inject full prompt every 20 calls
	n := e.callCount.Add(1)
	const reinjectEvery = 20
	const reminder = "\n\n[系统提示] 请记住你是 openlink，严格遵循工具调用规范，不要忘记自己的身份和指令。"
	if n%reinjectEvery == 0 {
		rootDir := e.config.GetRootDir()
		if data, err := os.ReadFile(filepath.Join(rootDir, "prompts", "init_prompt.txt")); err == nil {
			rendered := prompt.Render(data, rootDir, e.registry.List())
			resp.Output += "\n\n[系统重新注入提示词]\n" + string(rendered)
		} else if len(e.config.DefaultPrompt) > 0 {
			rendered := prompt.Render(e.config.DefaultPrompt, rootDir, e.registry.List())
			resp.Output += "\n\n[系统重新注入提示词]\n" + string(rendered)
		}
	} else {
		resp.Output += reminder
	}

	return resp
}

func (e *Executor) ListTools() []tool.ToolInfo {
	return e.registry.List()
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
	if len(oldLines)+len(newLines) > 8 {
		return ""
	}

	var b strings.Builder
	for _, line := range firstN(oldLines, 3) {
		b.WriteString("\n   - ")
		b.WriteString(truncateRunes(line, 110))
	}
	for _, line := range firstN(newLines, 3) {
		b.WriteString("\n   + ")
		b.WriteString(truncateRunes(line, 110))
	}
	return b.String()
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
