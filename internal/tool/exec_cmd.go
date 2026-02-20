package tool

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"

	"github.com/afumu/ground-link/internal/security"
	"github.com/afumu/ground-link/internal/types"
)

type ExecCmdTool struct {
	config *types.Config
}

func NewExecCmdTool(config *types.Config) *ExecCmdTool {
	return &ExecCmdTool{config: config}
}

func (t *ExecCmdTool) Name() string {
	return "exec_cmd"
}

func (t *ExecCmdTool) Description() string {
	return "Execute shell command in sandbox"
}

func (t *ExecCmdTool) Parameters() interface{} {
	return map[string]string{
		"command": "string (required) - shell command to execute",
	}
}

func (t *ExecCmdTool) Validate(args map[string]interface{}) error {
	cmd, ok := args["command"].(string)
	if !ok {
		cmd, ok = args["cmd"].(string)
	}
	if !ok || cmd == "" {
		return errors.New("command is required")
	}
	if security.IsDangerousCommand(cmd) {
		return errors.New("dangerous command blocked")
	}
	return nil
}

func (t *ExecCmdTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}

	cmd, _ := ctx.Args["command"].(string)
	if cmd == "" {
		cmd, _ = ctx.Args["cmd"].(string)
	}

	execCtx, cancel := context.WithTimeout(
		context.Background(),
		time.Duration(t.config.Timeout)*time.Second,
	)
	defer cancel()

	proc := exec.CommandContext(execCtx, "sh", "-c", cmd)
	proc.Dir = t.config.RootDir
	output, err := proc.CombinedOutput()
	result.EndTime = time.Now()

	if execCtx.Err() == context.DeadlineExceeded {
		result.Status = "error"
		result.Error = "execution timeout"
		return result
	}

	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		result.Output = string(output)
		return result
	}

	result.Status = "success"
	outputStr := string(output)
	if outputStr == "" {
		outputStr = "empty"
	}
	result.Output = fmt.Sprintf("命令: %s\n\n%s", cmd, outputStr)
	return result
}
