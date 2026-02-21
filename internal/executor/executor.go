package executor

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/afumu/openlink/internal/tool"
	"github.com/afumu/openlink/internal/types"
)

type Executor struct {
	config    *types.Config
	registry  *tool.Registry
	callCount atomic.Int64
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
		return &types.ToolResponse{
			Status: "error",
			Error:  invalid.Execute(&tool.Context{Args: args, Config: e.config}).Error,
		}
	}

	if err := t.Validate(req.Args); err != nil {
		return &types.ToolResponse{
			Status: "error",
			Error:  fmt.Sprintf("validation failed: %s", err),
		}
	}

	result := t.Execute(&tool.Context{
		Args:   req.Args,
		Config: e.config,
	})

	resp := &types.ToolResponse{
		Status:     result.Status,
		Output:     result.Output,
		Error:      result.Error,
		StopStream: result.StopStream,
	}

	// Fix 4: append identity reminder; re-inject full prompt every 20 calls
	n := e.callCount.Add(1)
	const reinjectEvery = 20
	const reminder = "\n\n[系统提示] 请记住你是 openlink，严格遵循工具调用规范，不要忘记自己的身份和指令。"
	if n%reinjectEvery == 0 {
		if data, err := os.ReadFile(filepath.Join(e.config.RootDir, "init_prompt.txt")); err == nil {
			resp.Output += "\n\n[系统重新注入提示词]\n" + string(data)
		}
	} else {
		resp.Output += reminder
	}

	return resp
}

func (e *Executor) ListTools() []tool.ToolInfo {
	return e.registry.List()
}
