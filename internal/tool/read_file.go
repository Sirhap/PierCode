package tool

import (
	"errors"
	"os"
	"time"

	"github.com/afumu/ground-link/internal/security"
	"github.com/afumu/ground-link/internal/types"
)

type ReadFileTool struct {
	config *types.Config
}

func NewReadFileTool(config *types.Config) *ReadFileTool {
	return &ReadFileTool{config: config}
}

func (t *ReadFileTool) Name() string {
	return "read_file"
}

func (t *ReadFileTool) Description() string {
	return "Read file contents"
}

func (t *ReadFileTool) Parameters() interface{} {
	return map[string]string{
		"path": "string (required) - file path to read",
	}
}

func (t *ReadFileTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *ReadFileTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)

	safePath, err := security.SafePath(ctx.Config.RootDir, path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	content, err := os.ReadFile(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	result.Output = string(content)
	if result.Output == "" {
		result.Output = "empty"
	}
	result.EndTime = time.Now()
	return result
}
