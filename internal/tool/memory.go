package tool

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/memory"
	"github.com/sirhap/piercode/internal/types"
)

type MemoryReadTool struct{ config *types.Config }
type MemoryWriteTool struct{ config *types.Config }
type MemoryForgetTool struct{ config *types.Config }

func NewMemoryReadTool(config *types.Config) *MemoryReadTool { return &MemoryReadTool{config: config} }
func NewMemoryWriteTool(config *types.Config) *MemoryWriteTool {
	return &MemoryWriteTool{config: config}
}
func NewMemoryForgetTool(config *types.Config) *MemoryForgetTool {
	return &MemoryForgetTool{config: config}
}

func (t *MemoryReadTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
func (t *MemoryReadTool) Name() string           { return "memory_read" }
func (t *MemoryReadTool) Description() string {
	return "Read PierCode project or global memory. Project memory is <workspace>/.piercode/memory.md; global memory is ~/.piercode/memory.md."
}
func (t *MemoryReadTool) Parameters() interface{} {
	return map[string]string{"scope": "string (optional) - project, global, or all (default: all)"}
}
func (t *MemoryReadTool) Validate(args map[string]interface{}) error {
	return validateOptionalMemoryScope(args, true)
}
func (t *MemoryReadTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	scope := strings.ToLower(strings.TrimSpace(stringArg(ctx.Args, "scope")))
	if scope == "" {
		scope = "all"
	}
	var outputs []string
	for _, s := range memoryScopes(scope) {
		path, err := memory.ResolveMemoryPath(ctx.EffectiveRootDir(), s)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				outputs = append(outputs, fmt.Sprintf("## %s memory\n(empty: %s does not exist)", s, path))
				continue
			}
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		body := strings.TrimRight(string(data), "\n")
		if strings.TrimSpace(body) == "" {
			body = "(empty)"
		}
		outputs = append(outputs, fmt.Sprintf("## %s memory\nPath: %s\n\n%s", s, path, body))
	}
	result.Status = "success"
	result.Output = strings.Join(outputs, "\n\n")
	return result
}

func (t *MemoryWriteTool) Name() string { return "memory_write" }
func (t *MemoryWriteTool) Description() string {
	return `Write PierCode project or global memory.

Use project memory for repository-specific conventions, decisions, and user preferences. Use global memory for durable preferences that should apply across projects. Prefer append for adding notes; overwrite only when intentionally replacing the whole memory file.`
}
func (t *MemoryWriteTool) Parameters() interface{} {
	return map[string]string{
		"scope":   "string (optional) - project or global (default: project)",
		"content": "string (required) - memory text to write",
		"mode":    "string (optional) - append or overwrite (default: append)",
	}
}
func (t *MemoryWriteTool) Validate(args map[string]interface{}) error {
	if err := validateOptionalMemoryScope(args, false); err != nil {
		return err
	}
	content, ok := args["content"].(string)
	if !ok || strings.TrimSpace(content) == "" {
		return errors.New("content is required")
	}
	if v, ok := args["mode"]; ok && v != nil {
		mode, ok := v.(string)
		if !ok {
			return errors.New("mode must be a string")
		}
		mode = strings.ToLower(strings.TrimSpace(mode))
		if mode != "" && mode != "append" && mode != "overwrite" {
			return errors.New("mode must be append or overwrite")
		}
	}
	return nil
}
func (t *MemoryWriteTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	scope := strings.TrimSpace(stringArg(ctx.Args, "scope"))
	content := stringArg(ctx.Args, "content")
	mode := strings.ToLower(strings.TrimSpace(stringArg(ctx.Args, "mode")))
	if mode == "" {
		mode = "append"
	}
	path, err := memory.ResolveMemoryPath(ctx.EffectiveRootDir(), scope)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	if mode == "overwrite" {
		payload := ensureTrailingNewline(content)
		if len(payload) > memory.MemoryMaxBytes {
			result.Status = "error"
			result.Error = fmt.Sprintf("memory content exceeds %d bytes (%d); trim it before writing", memory.MemoryMaxBytes, len(payload))
			return result
		}
		_ = snapshotPaths(ctx.EffectiveRootDir(), "memory_write", path)
		if err := os.WriteFile(path, []byte(payload), 0644); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	} else {
		payload := ensureTrailingNewline(content)
		addBytes := len(payload)
		if needsSeparator(path) {
			addBytes++
		}
		if err := memory.CheckAppendSize(path, addBytes); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		defer f.Close()
		if needsSeparator(path) {
			if _, err := f.WriteString("\n"); err != nil {
				result.Status = "error"
				result.Error = err.Error()
				return result
			}
		}
		if _, err := f.WriteString(payload); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}
	result.Status = "success"
	result.Output = fmt.Sprintf("已写入 %s memory: %s", normalizedMemoryScope(scope), path)
	return result
}

func (t *MemoryForgetTool) Name() string { return "memory_forget" }
func (t *MemoryForgetTool) Description() string {
	return "Remove PierCode project or global memory by deleting the selected memory file."
}
func (t *MemoryForgetTool) Parameters() interface{} {
	return map[string]string{"scope": "string (optional) - project or global (default: project)"}
}
func (t *MemoryForgetTool) Validate(args map[string]interface{}) error {
	return validateOptionalMemoryScope(args, false)
}
func (t *MemoryForgetTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	scope := strings.TrimSpace(stringArg(ctx.Args, "scope"))
	path, err := memory.ResolveMemoryPath(ctx.EffectiveRootDir(), scope)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	_ = snapshotPaths(ctx.EffectiveRootDir(), "memory_forget", path)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = fmt.Sprintf("已删除 %s memory: %s", normalizedMemoryScope(scope), path)
	return result
}

func validateOptionalMemoryScope(args map[string]interface{}, allowAll bool) error {
	if v, ok := args["scope"]; ok && v != nil {
		scope, ok := v.(string)
		if !ok {
			return errors.New("scope must be a string")
		}
		scope = strings.ToLower(strings.TrimSpace(scope))
		if scope == "" || scope == "project" || scope == "global" || allowAll && scope == "all" {
			return nil
		}
		if allowAll {
			return errors.New("scope must be project, global, or all")
		}
		return errors.New("scope must be project or global")
	}
	return nil
}

func memoryScopes(scope string) []string {
	if scope == "global" || scope == "project" {
		return []string{scope}
	}
	return []string{"global", "project"}
}

func normalizedMemoryScope(scope string) string {
	scope = strings.ToLower(strings.TrimSpace(scope))
	if scope == "global" {
		return "global"
	}
	return "project"
}

func ensureTrailingNewline(s string) string {
	if strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}

func needsSeparator(path string) bool {
	data, err := os.ReadFile(path)
	return err == nil && len(data) > 0 && !strings.HasSuffix(string(data), "\n")
}
