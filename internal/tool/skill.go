package tool

import (
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

func (t *SkillTool) Name() string        { return "skill" }
func (t *SkillTool) Description() string { return "Load a skill file from skills directories" }
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

	content, err := skill.FindSkill(ctx.Config.RootDir, skillName)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	result.Output = content
	result.EndTime = time.Now()
	return result
}
