package prompt

import (
	"bytes"
	"strings"

	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/prompts"
)

const skillsPlaceholder = "{{SKILLS}}"

const DefaultProfileID = "default"

// Profile describes the prompt/tool/skill surface exposed to one AI adapter.
// Nil ToolNames or SkillNames means "inherit all currently available items";
// an empty non-nil slice means "expose none".
type Profile struct {
	ID string
	// Prompt nil means inherit the default prompt. A non-nil Prompt replaces
	// the default prompt for this profile, including an intentionally empty
	// prompt in tests or future locked-down profiles.
	Prompt       []byte
	PromptAppend []byte
	ToolNames    []string
	SkillNames   []string
	// ContextHandoff, when non-empty, is appended to every AI-originated tool
	// result for this profile (e.g. Qwen's context-packet migration prompt).
	// Empty means the profile declares no per-call handoff guidance. Keeping it
	// on the profile lets new adapters opt in by registration instead of adding
	// a hardcoded platform check in the executor.
	ContextHandoff string
}

type ProfileRegistry struct {
	defaultPrompt []byte
	profiles      map[string]Profile
}

func NewProfileRegistry(defaultPrompt []byte) *ProfileRegistry {
	return &ProfileRegistry{
		defaultPrompt: defaultPrompt,
		profiles:      map[string]Profile{},
	}
}

func DefaultProfileRegistry(defaultPrompt []byte) *ProfileRegistry {
	// Keep adapter-specific profiles centralized here. Profiles should use
	// trusted embedded prompt bytes, not files from the writable workspace.
	registry := NewProfileRegistry(defaultPrompt)
	registry.Register(Profile{
		ID:             "qwen",
		PromptAppend:   prompts.QwenPromptAppend,
		ContextHandoff: qwenContextPacketReminder,
	})
	return registry
}

func (r *ProfileRegistry) Register(profile Profile) {
	id := normalizeProfileID(profile.ID)
	if id == "" {
		return
	}
	profile.ID = id
	r.profiles[id] = profile
}

func (r *ProfileRegistry) Select(rawID string) Profile {
	id := normalizeProfileID(rawID)
	if id == "" {
		return r.defaultProfile()
	}
	if profile, ok := r.profiles[id]; ok {
		if profile.ID == "" {
			profile.ID = id
		}
		if profile.Prompt == nil {
			profile.Prompt = r.defaultPrompt
		}
		return profile
	}
	return r.defaultProfile()
}

func (r *ProfileRegistry) defaultProfile() Profile {
	return Profile{
		ID:     DefaultProfileID,
		Prompt: r.defaultPrompt,
	}
}

func (p Profile) Render(rootDir string, tools []tool.ToolInfo, skills []skill.Info) []byte {
	filteredTools := p.FilterTools(tools)
	content := Render(p.Prompt, rootDir, filteredTools)
	content = AppendSkillsDoc(content, p.FilterSkills(skills))
	if len(p.PromptAppend) > 0 {
		content = append(content, []byte("\n\n")...)
		content = append(content, Render(p.PromptAppend, rootDir, filteredTools)...)
	}
	return content
}

func (p Profile) FilterTools(tools []tool.ToolInfo) []tool.ToolInfo {
	allowed := allowedNameSet(p.ToolNames)
	if allowed == nil {
		return tools
	}
	filtered := make([]tool.ToolInfo, 0, len(tools))
	for _, item := range tools {
		if _, ok := allowed[strings.ToLower(item.Name)]; ok {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func (p Profile) FilterSkills(skills []skill.Info) []skill.Info {
	allowed := allowedNameSet(p.SkillNames)
	if allowed == nil {
		return skills
	}
	filtered := make([]skill.Info, 0, len(skills))
	for _, item := range skills {
		if _, ok := allowed[strings.ToLower(item.Name)]; ok {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

// AppendSkillsDoc injects the dynamic skills list. If the template contains the
// {{SKILLS}} placeholder, the list is substituted in place so it sits next to
// the Skills guidance. Otherwise it is appended at the end (back-compat for
// templates without the placeholder).
func AppendSkillsDoc(content []byte, skills []skill.Info) []byte {
	if bytes.Contains(content, []byte(skillsPlaceholder)) {
		return bytes.ReplaceAll(content, []byte(skillsPlaceholder), []byte(buildSkillsList(skills)))
	}
	if len(skills) == 0 {
		return content
	}
	return append(content, []byte("\n\n## 当前可用 Skills\n\n"+buildSkillsList(skills))...)
}

func buildSkillsList(skills []skill.Info) string {
	if len(skills) == 0 {
		return "（当前会话没有可用 skills。）"
	}
	var sb strings.Builder
	for i, sk := range skills {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("- **")
		sb.WriteString(sk.Name)
		sb.WriteString("**: ")
		sb.WriteString(sk.Description)
	}
	return sb.String()
}

func allowedNameSet(names []string) map[string]struct{} {
	if names == nil {
		return nil
	}
	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		normalized := strings.ToLower(strings.TrimSpace(name))
		if normalized == "" {
			continue
		}
		allowed[normalized] = struct{}{}
	}
	return allowed
}

func normalizeProfileID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}
