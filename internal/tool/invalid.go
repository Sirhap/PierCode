package tool

import "fmt"

type InvalidTool struct{}

func (t *InvalidTool) Name() string                               { return "invalid" }
func (t *InvalidTool) Description() string                        { return "Catches unknown tool calls" }
func (t *InvalidTool) Parameters() interface{}                    { return nil }
func (t *InvalidTool) Validate(args map[string]interface{}) error { return nil }
func (t *InvalidTool) Execute(ctx *Context) *Result {
	toolName, _ := ctx.Args["tool"].(string)
	return &Result{
		Status: "error",
		Error:  fmt.Sprintf("Unknown tool: '%s'. Run tool_help to list all tools, or tool_help with {\"query\": \"...\"} to search by keyword.", toolName),
	}
}
