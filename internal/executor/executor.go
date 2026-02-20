package executor

import (
	"context"
	"fmt"
	"log"

	"github.com/afumu/ground-link/internal/tool"
	"github.com/afumu/ground-link/internal/types"
)

type Executor struct {
	config   *types.Config
	registry *tool.Registry
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
	return e
}

func (e *Executor) Execute(ctx context.Context, req *types.ToolRequest) *types.ToolResponse {
	log.Printf("[Executor] 执行工具: %s\n", req.Name)

	t, exists := e.registry.Get(req.Name)
	if !exists {
		return &types.ToolResponse{
			Status: "error",
			Error:  fmt.Sprintf("unknown tool: %s", req.Name),
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

	return &types.ToolResponse{
		Status: result.Status,
		Output: result.Output,
		Error:  result.Error,
	}
}

func (e *Executor) ListTools() []tool.ToolInfo {
	return e.registry.List()
}
