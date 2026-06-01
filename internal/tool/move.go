package tool

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/types"
)

// MoveTool renames or moves a file or directory within the sandbox. Both source
// and destination are validated against the workspace root, so neither can
// escape it. The destination's parent directory is created if needed.
type MoveTool struct {
	config *types.Config
}

func NewMoveTool(config *types.Config) *MoveTool {
	return &MoveTool{config: config}
}

func (t *MoveTool) Name() string { return "move" }

func (t *MoveTool) Description() string {
	return "Move or rename a file/directory within the sandbox. Fails if the destination exists unless overwrite=true."
}

func (t *MoveTool) Parameters() interface{} {
	return map[string]string{
		"from":      "string (required) - source path",
		"to":        "string (required) - destination path",
		"overwrite": "bool (optional, default false) - replace destination if it already exists",
	}
}

func (t *MoveTool) Validate(args map[string]interface{}) error {
	if p, ok := args["from"].(string); !ok || p == "" {
		return errors.New("from is required")
	}
	if p, ok := args["to"].(string); !ok || p == "" {
		return errors.New("to is required")
	}
	return nil
}

func (t *MoveTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	from, _ := ctx.Args["from"].(string)
	to, _ := ctx.Args["to"].(string)
	overwrite, _ := ctx.Args["overwrite"].(bool)
	rootDir := ctx.EffectiveRootDir()

	// Source must already exist, so resolve it with the existing-path validator.
	srcAbs, err := resolveMovePath(rootDir, from)
	if err != nil {
		result.Status = "error"
		result.Error = fmt.Sprintf("from: %s", err.Error())
		return result
	}
	if _, err := os.Lstat(srcAbs); err != nil {
		result.Status = "error"
		result.Error = fmt.Sprintf("from: %s", err.Error())
		return result
	}

	dstAbs, err := resolveMovePath(rootDir, to)
	if err != nil {
		result.Status = "error"
		result.Error = fmt.Sprintf("to: %s", err.Error())
		return result
	}

	if _, err := os.Lstat(dstAbs); err == nil {
		if !overwrite {
			result.Status = "error"
			result.Error = fmt.Sprintf("destination already exists: %s (set overwrite=true to replace)", to)
			return result
		}
	}

	if err := os.MkdirAll(filepath.Dir(dstAbs), 0755); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	if err := os.Rename(srcAbs, dstAbs); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	result.Output = fmt.Sprintf("已移动 %s → %s", from, to)
	return result
}

// resolveMovePath validates a (possibly absolute or relative) path against the
// sandbox. The destination may not exist yet, so SafePath's parent-resolving
// behavior is what we rely on for relative paths.
func resolveMovePath(rootDir, path string) (string, error) {
	if filepath.IsAbs(path) {
		return resolveAbsPath(path, rootDir)
	}
	return security.SafePath(rootDir, path)
}
