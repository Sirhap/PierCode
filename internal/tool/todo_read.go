package tool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/afumu/openlink/internal/types"
)

// TodoReadTool returns the current contents of <rootDir>/.todos.json in the
// same checklist format TodoWriteTool prints after writing. Lets the AI
// re-load its plan after a context reset without parsing raw JSON.
type TodoReadTool struct {
	config *types.Config
}

func NewTodoReadTool(config *types.Config) *TodoReadTool {
	return &TodoReadTool{config: config}
}

func (t *TodoReadTool) Name() string        { return "todo_read" }
func (t *TodoReadTool) Description() string { return "Read the current todo list from .todos.json" }
func (t *TodoReadTool) Parameters() interface{} {
	return map[string]string{}
}

func (t *TodoReadTool) Validate(args map[string]interface{}) error { return nil }

func (t *TodoReadTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	p := filepath.Join(ctx.EffectiveRootDir(), ".todos.json")
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			result.Status = "success"
			result.Output = "暂无任务（.todos.json 不存在）"
			return result
		}
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	var todos interface{}
	if err := json.Unmarshal(data, &todos); err != nil {
		result.Status = "error"
		result.Error = "todos.json 解析失败: " + err.Error()
		return result
	}

	items, _ := todos.([]interface{})
	result.Status = "success"
	result.Output = fmt.Sprintf("当前有 %d 个任务：\n\n%s", len(items), formatTodoChecklist(items))
	return result
}
