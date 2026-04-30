package tool

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"time"
	"unicode/utf8"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
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

func getShell() (string, string) {
	if runtime.GOOS == "windows" {
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return comspec, "/C"
	}
	return "sh", "-c"
}

// decodeGBK 将 GBK 编码的字节转换为 UTF-8 字符串
func decodeGBK(data []byte) string {
	reader := transform.NewReader(bytes.NewReader(data), simplifiedchinese.GBK.NewDecoder())
	decoded, err := io.ReadAll(reader)
	if err != nil {
		// 解码失败时回退到原始字符串
		return string(data)
	}
	return string(decoded)
}

func decodeCommandOutput(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	if runtime.GOOS == "windows" {
		return decodeGBK(data)
	}
	return string(data)
}

func (t *ExecCmdTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}

	cmd, _ := ctx.Args["command"].(string)
	if cmd == "" {
		cmd, _ = ctx.Args["cmd"].(string)
	}

	parentCtx := ctx.Context
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	execCtx, cancel := context.WithTimeout(parentCtx, time.Duration(t.config.Timeout)*time.Second)
	defer cancel()

	shell, flag := getShell()
	proc := exec.CommandContext(execCtx, shell, flag, cmd)
	proc.Dir = t.config.GetRootDir()
	output, err := proc.CombinedOutput()
	result.EndTime = time.Now()

	if execCtx.Err() == context.DeadlineExceeded {
		result.Status = "error"
		result.Error = "execution timeout"
		return result
	}

	outputStr, _ := Truncate(decodeCommandOutput(output))

	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		result.Output = outputStr
		return result
	}

	result.Status = "success"
	if outputStr == "" {
		outputStr = "empty"
	}
	result.Output = fmt.Sprintf("command: %s\n\n%s", cmd, outputStr)
	return result
}
