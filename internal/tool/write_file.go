package tool

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type WriteFileTool struct {
	config *types.Config
}

func NewWriteFileTool(config *types.Config) *WriteFileTool {
	return &WriteFileTool{config: config}
}

func (t *WriteFileTool) Name() string {
	return "write_file"
}

func (t *WriteFileTool) Description() string {
	return `Writes content to a file, creating it or overwriting it.

Usage:
- When to use: creating a new file, or fully replacing one. For partial changes to an existing file, use ` + "`edit`" + ` instead — do not rewrite a whole file to change a few lines.
- ALWAYS prefer editing an existing file over overwriting it. NEVER create new files unless required.
- Read an existing file before overwriting it so you do not discard content you cannot see.
- Only use emojis if the user explicitly requests it.
- Use mode "append" to add to the end of a file; default overwrites.
- Prefer this over ` + "`echo >`" + ` / heredoc via exec_cmd.`
}

func (t *WriteFileTool) Parameters() interface{} {
	return map[string]string{
		"path":    "string (required) - file path to write",
		"content": "string (required) - content to write",
		"mode":    "string (optional) - 'append' or 'overwrite' (default)",
	}
}

func (t *WriteFileTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *WriteFileTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)
	content, _ := ctx.Args["content"].(string)
	mode, _ := ctx.Args["mode"].(string)

	safePath, err := ctx.ResolvePath(path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	if mode == "append" {
		if err := os.MkdirAll(filepath.Dir(safePath), 0755); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		f, err := os.OpenFile(safePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		defer f.Close()
		if _, err := f.WriteString(content); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	} else {
		// Snapshot the prior state before overwriting so `undo` can restore it.
		_ = snapshotPaths(ctx.EffectiveRootDir(), "write_file", safePath)
		if err := os.MkdirAll(filepath.Dir(safePath), 0755); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
		if err := os.WriteFile(safePath, []byte(content), 0644); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}

	result.Status = "success"
	result.Output = "写入成功"
	result.EndTime = time.Now()
	return result
}
