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
	content := string(template)
	content = strings.ReplaceAll(content, "{{SYSTEM_INFO}}", BuildSystemInfo(rootDir))
	content = strings.ReplaceAll(content, "{{TOOLS}}", BuildToolsDoc(tools))
	return []byte(content)
}

func BuildSystemInfo(rootDir string) string {
	hostname, _ := os.Hostname()
	return fmt.Sprintf("- 操作系统: %s/%s\n- 工作目录: %s\n- 主机名: %s\n- 当前时间: %s",
		runtime.GOOS, runtime.GOARCH, rootDir, hostname,
		time.Now().Format("2006-01-02 15:04:05"))
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
	for i, t := range tools {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(fmt.Sprintf("- `%s`: %s", t.Name, firstLine(t.Description)))
	}
	sb.WriteString("\n\nCall format: when you actually execute a tool, output one visible `piercode-tool` fenced JSON block with fields `name`, `call_id`, and `args`. Do not output executable tool blocks for explanations or examples; non-executed examples must use a `text` fence.\n")
	return sb.String()
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
