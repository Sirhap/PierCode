package tool

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afumu/openlink/internal/skill"
	"github.com/afumu/openlink/internal/types"
)

type SkillTool struct {
	config *types.Config
}

func NewSkillTool(config *types.Config) *SkillTool {
	return &SkillTool{config: config}
}

func (t *SkillTool) Name() string { return "skill" }
func (t *SkillTool) Description() string {
	infos := skill.LoadInfos(t.config.RootDir)
	if len(infos) == 0 {
		return "Load a specialized skill from skills directories"
	}
	var sb strings.Builder
	sb.WriteString("Load a specialized skill from skills directories\n<available_skills>")
	for _, s := range infos {
		fmt.Fprintf(&sb, "\n  <skill><name>%s</name><description>%s</description><location>file://%s</location></skill>",
			s.Name, s.Description, s.Location)
	}
	sb.WriteString("\n</available_skills>")
	return sb.String()
}
func (t *SkillTool) Parameters() interface{} {
	return map[string]string{
		"skill": "string (optional) - skill name to load; omit to list available skills",
	}
}
func (t *SkillTool) Validate(args map[string]interface{}) error { return nil }

func (t *SkillTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	skillName, _ := ctx.Args["skill"].(string)

	if skillName == "" {
		infos := skill.LoadInfos(ctx.Config.RootDir)
		if len(infos) == 0 {
			result.Status = "success"
			result.Output = "没有找到可用的 skills"
			result.EndTime = time.Now()
			return result
		}
		var names []string
		for _, s := range infos {
			names = append(names, s.Name)
		}
		result.Status = "success"
		result.Output = "可用 skills: " + strings.Join(names, ", ")
		result.EndTime = time.Now()
		return result
	}

	info, ok := skill.Get(ctx.Config.RootDir, skillName)
	if !ok {
		result.Status = "error"
		result.Error = fmt.Sprintf("skill %q not found", skillName)
		return result
	}

	data, err := os.ReadFile(info.Location)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	// list sibling files (up to 10, excluding SKILL.md)
	var siblings []string
	if entries, e := os.ReadDir(info.Dir); e == nil {
		for _, entry := range entries {
			if !entry.IsDir() && !strings.EqualFold(entry.Name(), "skill.md") {
				siblings = append(siblings, entry.Name())
				if len(siblings) == 10 {
					break
				}
			}
		}
	}

	var siblingPaths []string
	for _, name := range siblings {
		siblingPaths = append(siblingPaths, filepath.Join(info.Dir, name))
	}

	var out strings.Builder
	fmt.Fprintf(&out, "<skill_content name=%q>\n", skillName)
	fmt.Fprintf(&out, "IMPORTANT: All file paths referenced in this skill must use absolute paths. The skill directory is: %s\n", info.Dir)
	if len(siblingPaths) > 0 {
		fmt.Fprintf(&out, "Available files in skill directory (use these absolute paths directly):\n")
		for _, p := range siblingPaths {
			fmt.Fprintf(&out, "  - %s\n", p)
		}
	}
	out.WriteString("\n")
	out.Write(data)
	out.WriteString("\n</skill_content>")

	result.Status = "success"
	result.Output = out.String()
	result.EndTime = time.Now()
	return result
}
