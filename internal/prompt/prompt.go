package prompt

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/tool"
)

func Render(template []byte, rootDir string, tools []tool.ToolInfo) []byte {
	content := renderBody(template, tools)
	content = strings.ReplaceAll(content, "{{SYSTEM_INFO}}", BuildSystemInfo(rootDir, "", nil))
	content = strings.ReplaceAll(content, projectRulesPlaceholder, BuildProjectRules(rootDir))
	return []byte(content)
}

// projectRulesPlaceholder is replaced with the workspace's own agent rules file
// (CLAUDE.md or AGENTS.md at RootDir) so a repo can steer the model's behavior.
// Like {{SYSTEM_INFO}} it carries content that lives on disk and can change, so
// it is substituted AFTER any render cache lookup rather than baked into the
// cached body. When neither file exists it renders empty (no leftover token).
const projectRulesPlaceholder = "{{PROJECT_RULES}}"

// projectRulesFiles lists the workspace rule files to look for, in priority
// order. CLAUDE.md wins over AGENTS.md when both are present (matches the
// convention that a Claude-specific file is the more intentional choice).
var projectRulesFiles = []string{"CLAUDE.md", "AGENTS.md"}

// projectRulesMaxBytes caps how much of the rule file is injected so an
// oversized CLAUDE.md cannot blow up the prompt. The first ~8KB is plenty for
// project conventions; anything longer is truncated with a marker.
const projectRulesMaxBytes = 8 * 1024

// BuildProjectRules reads the workspace's agent-rules file (CLAUDE.md, then
// AGENTS.md) from RootDir and returns it wrapped for injection, or "" when none
// exists. SECURITY: the file is read only via security.SafePath against rootDir
// (relative name, symlink-resolved, must stay inside the sandbox), so this can
// never read outside the validated workspace.
func BuildProjectRules(rootDir string) string {
	if strings.TrimSpace(rootDir) == "" {
		return ""
	}
	for _, name := range projectRulesFiles {
		safePath, err := security.SafePath(rootDir, name)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(safePath)
		if err != nil {
			continue
		}
		body := string(raw)
		truncated := false
		if len(body) > projectRulesMaxBytes {
			body = body[:projectRulesMaxBytes]
			truncated = true
		}
		body = strings.TrimRight(body, "\n")
		if strings.TrimSpace(body) == "" {
			continue
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "## 项目规则 (%s)\n\n这是本仓库自带的 AI 行为约定，优先级高于通用指南；与之冲突时以此为准。\n\n%s", name, body)
		if truncated {
			sb.WriteString("\n\n…（项目规则已截断，仅注入前 8KB）")
		}
		return sb.String()
	}
	return ""
}

// renderBody substitutes the cacheable placeholders (currently {{TOOLS}}) and
// intentionally leaves {{SYSTEM_INFO}} in place so the caller can stamp the
// volatile timestamp after a cache lookup.
func renderBody(template []byte, tools []tool.ToolInfo) string {
	return strings.ReplaceAll(string(template), "{{TOOLS}}", BuildToolsDoc(tools))
}

func BuildSystemInfo(rootDir, permissionMode string, additionalAllowedDirs []string) string {
	hostname, _ := os.Hostname()
	var sb strings.Builder
	fmt.Fprintf(&sb, "- 操作系统: %s/%s\n- 工作目录: %s\n- 主机名: %s\n- 当前时间: %s",
		runtime.GOOS, runtime.GOARCH, rootDir, hostname,
		time.Now().Format("2006-01-02 15:04"))
	sb.WriteString("\n")
	sb.WriteString(buildSandboxInfo(rootDir, permissionMode, additionalAllowedDirs))
	return sb.String()
}

// buildSandboxInfo describes the runtime file-access boundary so the model knows
// the actual allowed roots instead of assuming the strictest single-root case.
// The server enforces the real boundary; this only tells the model where it can
// reach so it attempts in-bounds paths instead of self-refusing.
func buildSandboxInfo(rootDir, permissionMode string, additionalAllowedDirs []string) string {
	switch permissionMode {
	case "unrestricted":
		return "- 文件权限: unrestricted —— 文件操作不受 workspace 限制，可读写任意绝对路径。无需自我预判越界，直接发起操作。"
	case "auto":
		parent := filepath.Dir(rootDir)
		base := fmt.Sprintf("- 文件权限: auto —— 允许工作目录及其父目录 (%s) 下的文件操作。", parent)
		if len(additionalAllowedDirs) > 0 {
			base += " 额外允许目录: " + strings.Join(additionalAllowedDirs, "、") + "。"
		}
		base += " 是否越界由服务端裁决，不要自我预判——目标在允许范围内就直接操作。"
		return base
	default:
		base := "- 文件权限: default —— 文件操作限工作目录。"
		if len(additionalAllowedDirs) > 0 {
			base += " 额外允许目录: " + strings.Join(additionalAllowedDirs, "、") + "（这些目录可正常读写）。"
		}
		base += " 是否越界由服务端裁决，不要自我预判——不确定时直接发起操作，服务端会放行或返回错误。"
		return base
	}
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
	sb.WriteString("\nCommon minimum argument schemas: `list_dir` uses {\"path\":\".\"}; `read_file` uses {\"path\":\"README.md\"}; `glob` uses {\"pattern\":\"**/*.go\"}; `grep` uses {\"path\":\".\",\"pattern\":\"regex\"}; `tool_help` uses {\"tool\":\"list_dir\"}; `skill` uses {\"skill\":\"piercode-tool-protocol\"}. Never call `list_dir`, `read_file`, `glob`, or `grep` with empty `args`.\n")
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
