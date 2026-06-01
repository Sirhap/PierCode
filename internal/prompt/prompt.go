package prompt

import (
	"fmt"
	"os"
	"runtime"
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
	var sb strings.Builder
	for i, t := range tools {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(fmt.Sprintf("### %s\n\n%s\n\n", t.Name, t.Description))
		if params, ok := t.Parameters.(map[string]string); ok && len(params) > 0 {
			sb.WriteString("参数：\n")
			for k, v := range params {
				sb.WriteString(fmt.Sprintf("- %s: %s\n", k, v))
			}
			sb.WriteString("\n")
		}

		sb.WriteString("调用格式：在确实要执行该工具时，输出一个 `piercode-tool` fenced JSON block，字段为 `name`、`call_id`、`args`。不要为说明或示例输出可执行工具块；如需列举非执行示例，使用 `text` fence。\n")
	}
	return sb.String()
}
