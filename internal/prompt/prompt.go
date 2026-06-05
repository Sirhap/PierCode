package prompt

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func Render(template []byte, rootDir string, tools []tool.ToolInfo) []byte {
	content := renderBody(template, tools)
	content = strings.ReplaceAll(content, "{{SYSTEM_INFO}}", BuildSystemInfo(rootDir))
	return []byte(content)
}

// renderBody substitutes the cacheable placeholders (currently {{TOOLS}}) and
// intentionally leaves {{SYSTEM_INFO}} in place so the caller can stamp the
// volatile timestamp after a cache lookup.
func renderBody(template []byte, tools []tool.ToolInfo) string {
	return strings.ReplaceAll(string(template), "{{TOOLS}}", BuildToolsDoc(tools))
}

func BuildSystemInfo(rootDir string) string {
	hostname, _ := os.Hostname()
	return fmt.Sprintf("- 操作系统: %s/%s\n- 工作目录: %s\n- 主机名: %s\n- 当前时间: %s",
		runtime.GOOS, runtime.GOARCH, rootDir, hostname,
		time.Now().Format("2006-01-02 15:04"))
}

func BuildToolsDoc(tools []tool.ToolInfo) string {
	if len(tools) == 0 {
		return "（无可用工具）"
	}
	sort.Slice(tools, func(i, j int) bool {
		return tools[i].Name < tools[j].Name
	})
	var sb strings.Builder
	sb.WriteString("This is a compact route index, not full API documentation. Before first use of an unfamiliar or parameter-sensitive tool, call `tool_help` with the exact tool name to read detailed parameters.\n\n")
	sb.WriteString("Available operations:\n")

	// Collapse the large browser_* family into one category pointer instead of
	// listing ~40 individual lines that are irrelevant to non-browser tasks. The
	// model expands the family on demand via `tool_help` (query/tool both work).
	// Below the threshold, keep them inline — collapsing 1-2 saves nothing.
	const browserCollapseThreshold = 3
	var browserCount int
	for _, t := range tools {
		if strings.HasPrefix(t.Name, "browser_") {
			browserCount++
		}
	}
	collapseBrowser := browserCount >= browserCollapseThreshold

	first := true
	for _, t := range tools {
		if collapseBrowser && strings.HasPrefix(t.Name, "browser_") {
			continue
		}
		if !first {
			sb.WriteString("\n")
		}
		first = false
		sb.WriteString(fmt.Sprintf("- `%s`: %s", t.Name, firstLine(t.Description)))
	}
	if collapseBrowser {
		if !first {
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "- `browser_*` (%d tools): page automation — tabs, navigation, snapshot, click, type, screenshot, wait, etc. Call `tool_help` with {\"query\":\"browser\"} to list them, or {\"tool\":\"browser_click\"} for one tool's parameters.", browserCount)
	}
		sb.WriteString("\n\nTool-call JSON must have exactly these top-level fields: `name`, `call_id`, and `args`. Do not use `tool`, `operation`, `action`, `id`, `parameters`, or `input` as top-level fields.\n")
		sb.WriteString("\nCommon minimum argument schemas: `list_dir` uses {\"path\":\".\"}; `read_file` uses {\"path\":\"README.md\"}; `glob` uses {\"pattern\":\"**/*.go\"}; `grep` uses {\"path\":\".\",\"pattern\":\"regex\"}; `tool_help` uses {\"name\":\"list_dir\"}; `skill` uses {\"name\":\"piercode-tool-protocol\"}. Never call `list_dir`, `read_file`, `glob`, or `grep` with empty `args`.\n")
		sb.WriteString("\nCall format: when you actually execute a tool, output one visible `piercode-tool` fenced JSON block with fields `name`, `call_id`, and `args`. Do not output executable tool blocks for explanations or examples; non-executed examples must use a `text` fence.\n")
	return sb.String()
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
