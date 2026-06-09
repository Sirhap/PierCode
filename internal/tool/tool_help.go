package tool

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

type ToolHelpTool struct {
	registry *Registry
}

func NewToolHelpTool(registry *Registry) *ToolHelpTool {
	return &ToolHelpTool{registry: registry}
}

func (t *ToolHelpTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }

func (t *ToolHelpTool) Name() string { return "tool_help" }

func (t *ToolHelpTool) Description() string {
	return "Read detailed PierCode tool documentation on demand. Use before first use of an unfamiliar or parameter-sensitive tool."
}

func (t *ToolHelpTool) Parameters() interface{} {
	return map[string]string{
		"tool":  "string (optional) - exact tool name to inspect, e.g. browser_click",
		"query": "string (optional) - filter tools by name or description when tool is omitted",
	}
}

func (t *ToolHelpTool) Validate(args map[string]interface{}) error {
	for key := range args {
		switch key {
		case "tool", "query":
		case "name":
			return fmt.Errorf("unknown parameter %q; use %q for exact tool docs or %q for search", key, "tool", "query")
		default:
			return fmt.Errorf("unknown parameter %q", key)
		}
	}
	if v, ok := args["tool"]; ok && v != nil {
		if _, ok := v.(string); !ok {
			return fmt.Errorf("tool must be a string")
		}
	}
	if v, ok := args["query"]; ok && v != nil {
		if _, ok := v.(string); !ok {
			return fmt.Errorf("query must be a string")
		}
	}
	return nil
}

func (t *ToolHelpTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	if t.registry == nil {
		result.Status = "error"
		result.Error = "tool registry is not available"
		return result
	}

	toolName := strings.TrimSpace(stringArg(ctx.Args, "tool"))
	if toolName != "" {
		info, ok := t.findTool(toolName)
		if !ok {
			result.Status = "error"
			result.Error = t.notFoundMessage(toolName)
			return result
		}
		result.Status = "success"
		result.Output = renderDetailedToolHelp(info)
		return result
	}

	query := strings.ToLower(strings.TrimSpace(stringArg(ctx.Args, "query")))
	tools := t.registry.List()
	sortToolInfos(tools)
	var rows []string
	for _, info := range tools {
		haystack := strings.ToLower(info.Name + " " + info.Description)
		if query != "" && !strings.Contains(haystack, query) {
			continue
		}
		tag := ""
		if info.ReadOnly {
			tag = " [read-only]"
		}
		rows = append(rows, fmt.Sprintf("- %s%s: %s", info.Name, tag, firstLine(info.Description)))
	}
	if len(rows) == 0 {
		result.Status = "success"
		result.Output = "No matching tools. Use tool_help with query omitted to list all tools."
		return result
	}
	result.Status = "success"
	result.Output = "Matching PierCode tools:\n" + strings.Join(rows, "\n") + "\n\nCall tool_help with {\"tool\":\"tool_name\"} for detailed parameters."
	return result
}

func (t *ToolHelpTool) findTool(name string) (ToolInfo, bool) {
	if tool, ok := t.registry.Get(name); ok {
		return InfoFor(tool), true
	}
	if tool, ok := t.registry.Get(strings.ToLower(name)); ok {
		return InfoFor(tool), true
	}
	for _, info := range t.registry.List() {
		if strings.EqualFold(info.Name, name) {
			return info, true
		}
	}
	return ToolInfo{}, false
}

// notFoundMessage builds an error that suggests near-name matches so the model
// can self-correct typos instead of giving up. Matching is bidirectional
// substring (covers "click" -> browser_click and "browser_clicker" -> browser_click)
// plus shared-prefix grouping, capped to a short list.
func (t *ToolHelpTool) notFoundMessage(name string) string {
	target := strings.ToLower(strings.TrimSpace(name))
	tools := t.registry.List()
	sortToolInfos(tools)

	var suggestions []string
	seen := map[string]bool{}
	add := func(n string) {
		if !seen[n] {
			seen[n] = true
			suggestions = append(suggestions, n)
		}
	}
	// Pass 1: substring either direction.
	for _, info := range tools {
		lower := strings.ToLower(info.Name)
		if strings.Contains(lower, target) || strings.Contains(target, lower) {
			add(info.Name)
		}
	}
	// Pass 2: shared leading segment (e.g. "browser_") when target has one.
	if prefix := namePrefix(target); prefix != "" {
		for _, info := range tools {
			if strings.HasPrefix(strings.ToLower(info.Name), prefix) {
				add(info.Name)
			}
		}
	}
	const maxSuggest = 8
	if len(suggestions) > maxSuggest {
		suggestions = suggestions[:maxSuggest]
	}

	if len(suggestions) == 0 {
		return fmt.Sprintf("tool %q not found. Call tool_help with no args to list all tools, or with {\"query\":\"...\"} to search.", name)
	}
	return fmt.Sprintf("tool %q not found. Did you mean: %s? Or call tool_help with {\"query\":\"...\"} to search.", name, strings.Join(suggestions, ", "))
}

// namePrefix returns the leading underscore-delimited segment plus separator,
// e.g. "browser_clik" -> "browser_". Empty if the name has no underscore.
func namePrefix(name string) string {
	if i := strings.IndexByte(name, '_'); i > 0 {
		return name[:i+1]
	}
	return ""
}

func renderDetailedToolHelp(info ToolInfo) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "### %s\n\n%s\n\n", info.Name, info.Description)
	if params, ok := info.Parameters.(map[string]string); ok && len(params) > 0 {
		sb.WriteString("Parameters:\n")
		keys := make([]string, 0, len(params))
		for key := range params {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			fmt.Fprintf(&sb, "- %s: %s\n", key, params[key])
		}
		sb.WriteString("\n")
	}
	if info.ReadOnly {
		sb.WriteString("Metadata:\n- readOnly: true\n\n")
	}
	sb.WriteString("Call format: when executing, output one visible `piercode-tool` fenced JSON block with `name`, `call_id`, and `args`. Do not output executable tool blocks as examples; use a `text` fence for non-executed examples.")
	return sb.String()
}

func sortToolInfos(tools []ToolInfo) {
	sort.Slice(tools, func(i, j int) bool {
		return tools[i].Name < tools[j].Name
	})
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
