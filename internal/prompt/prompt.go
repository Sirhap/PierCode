package prompt

import (
	"encoding/json"
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

		exampleArgs := buildExampleArgs(t)
		callID := fmt.Sprintf("%s%d", string(rune('a'+i%26)), 10000+i*17)
		exampleJSON, _ := json.Marshal(map[string]interface{}{
			"name":    t.Name,
			"call_id": callID,
			"args":    exampleArgs,
		})
		sb.WriteString(fmt.Sprintf("```piercode-tool\n%s\n```\n", string(exampleJSON)))
	}
	return sb.String()
}

func buildExampleArgs(t tool.ToolInfo) map[string]interface{} {
	args := make(map[string]interface{})
	if params, ok := t.Parameters.(map[string]string); ok {
		for k := range params {
			args[k] = exampleValue(t.Name, k)
		}
	}
	return args
}

func exampleValue(toolName, paramName string) interface{} {
	switch paramName {
	case "command":
		return "ls -la"
	case "path":
		switch toolName {
		case "write_file":
			return "out.txt"
		case "read_file":
			return "main.go"
		case "edit":
			return "main.go"
		default:
			return "."
		}
	case "pattern":
		return "**/*.go"
	case "include":
		return "*.go"
	case "content":
		return "hello"
	case "mode":
		return "overwrite"
	case "old_string":
		return "Hello"
	case "new_string":
		return "Hi"
	case "replace_all":
		return false
	case "url":
		return "https://example.com"
	case "format":
		return "text"
	case "question":
		return "请选择操作"
	case "options":
		return []string{"继续", "取消"}
	case "skill":
		return "deploy"
	case "offset":
		return 1
	case "limit":
		return 200
	case "todos":
		return []map[string]string{{"content": "修复登录 bug", "status": "pending", "priority": "high"}}
	default:
		return "..."
	}
}
