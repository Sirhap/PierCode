package prompt

import (
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/prompts"
)

func TestProfileRegistryFallsBackToDefault(t *testing.T) {
	registry := NewProfileRegistry([]byte("system\n{{TOOLS}}"))
	profile := registry.Select("unknown-adapter")

	if profile.ID != DefaultProfileID {
		t.Fatalf("expected default profile for unknown adapter, got %q", profile.ID)
	}

	rendered := string(profile.Render("C:/repo", []tool.ToolInfo{{
		Name:        "read_file",
		Description: "read a file",
	}}, nil))
	if !strings.Contains(rendered, "read_file") {
		t.Fatalf("expected default prompt to render all tools, got %q", rendered)
	}
}

func TestProfileCanAppendWithoutReplacingDefaultPrompt(t *testing.T) {
	profile := Profile{
		ID:           "qwen",
		Prompt:       []byte("base {{TOOLS}}"),
		PromptAppend: []byte("append {{TOOLS}}"),
	}

	rendered := string(profile.Render("C:/repo", []tool.ToolInfo{{
		Name:        "grep",
		Description: "search files",
	}}, nil))
	if !strings.Contains(rendered, "base") || !strings.Contains(rendered, "append") {
		t.Fatalf("expected base and append prompt content, got %q", rendered)
	}
	if strings.Count(rendered, "grep") < 2 {
		t.Fatalf("expected placeholders in base and append to render tools, got %q", rendered)
	}
}

func TestProfilePromptOverridesDefaultWhenRegistered(t *testing.T) {
	registry := NewProfileRegistry([]byte("default {{TOOLS}}"))
	registry.Register(Profile{
		ID:     "locked",
		Prompt: []byte("override {{TOOLS}}"),
	})

	rendered := string(registry.Select("locked").Render("C:/repo", []tool.ToolInfo{{
		Name:        "read_file",
		Description: "read",
	}}, nil))
	if strings.Contains(rendered, "default") {
		t.Fatalf("expected override prompt to replace default, got %q", rendered)
	}
	if !strings.Contains(rendered, "override") || !strings.Contains(rendered, "read_file") {
		t.Fatalf("expected override prompt to render, got %q", rendered)
	}
}

func TestRenderedToolDocsDoNotIncludeExecutableToolFenceExamples(t *testing.T) {
	rendered := string(Render([]byte("{{TOOLS}}"), "C:/repo", []tool.ToolInfo{{
		Name:        "browser_snapshot",
		Description: "snapshot page",
		Parameters:  map[string]string{"tabId": "optional tab id"},
	}}))

	if strings.Contains(rendered, "```piercode-tool") || strings.Contains(rendered, "```tool") {
		t.Fatalf("rendered tool docs must not include executable tool-call examples, got %q", rendered)
	}
	if !strings.Contains(rendered, "browser_snapshot") || !strings.Contains(rendered, "name") || !strings.Contains(rendered, "call_id") || !strings.Contains(rendered, "args") {
		t.Fatalf("rendered tool docs should still describe the protocol fields, got %q", rendered)
	}
	if !strings.Contains(rendered, "`text` fence") {
		t.Fatalf("rendered tool docs should direct non-executed examples to text fences, got %q", rendered)
	}
}

func TestRenderedToolDocsAreCompactRouteIndex(t *testing.T) {
	rendered := string(Render([]byte("{{TOOLS}}"), "C:/repo", []tool.ToolInfo{{
		Name:        "browser_snapshot",
		Description: "snapshot page",
		Parameters:  map[string]string{"tabId": "optional tab id"},
	}}))

	if !strings.Contains(rendered, "compact route index") || !strings.Contains(rendered, "tool_help") {
		t.Fatalf("rendered tool docs should route detailed docs through tool_help, got %q", rendered)
	}
	if strings.Contains(rendered, "optional tab id") {
		t.Fatalf("rendered tool docs should not inline detailed parameter docs, got %q", rendered)
	}
}

func TestProfileRegistryCanFilterToolsAndSkills(t *testing.T) {
	registry := NewProfileRegistry([]byte("default {{TOOLS}}"))
	registry.Register(Profile{
		ID:         "claude",
		Prompt:     []byte("custom {{TOOLS}}"),
		ToolNames:  []string{"read_file"},
		SkillNames: []string{"debug"},
	})

	profile := registry.Select(" CLAUDE ")
	tools := []tool.ToolInfo{
		{Name: "read_file", Description: "read"},
		{Name: "write_file", Description: "write"},
	}
	skills := []skill.Info{
		{Name: "debug", Description: "debugging"},
		{Name: "deploy", Description: "deployment"},
	}

	rendered := string(profile.Render("C:/repo", tools, skills))
	if !strings.Contains(rendered, "custom") {
		t.Fatalf("expected custom prompt, got %q", rendered)
	}
	if !strings.Contains(rendered, "read_file") || strings.Contains(rendered, "write_file") {
		t.Fatalf("expected only read_file to be rendered, got %q", rendered)
	}
	if !strings.Contains(rendered, "debugging") || strings.Contains(rendered, "deployment") {
		t.Fatalf("expected only debug skill to be rendered, got %q", rendered)
	}
}

func TestSkillsSubstituteAtPlaceholderWhenPresent(t *testing.T) {
	profile := Profile{
		ID:     "default",
		Prompt: []byte("guidance\n{{SKILLS}}\ntail"),
	}
	skills := []skill.Info{
		{Name: "debug", Description: "debugging"},
		{Name: "deploy", Description: "deployment"},
	}

	rendered := string(profile.Render("C:/repo", nil, skills))
	if strings.Contains(rendered, skillsPlaceholder) {
		t.Fatalf("placeholder must be substituted, got %q", rendered)
	}
	if strings.Contains(rendered, "## 当前可用 Skills") {
		t.Fatalf("placeholder mode should not add the append-only heading, got %q", rendered)
	}
	// List sits between the guidance and the tail, not at the very end.
	gi := strings.Index(rendered, "guidance")
	di := strings.Index(rendered, "debugging")
	ti := strings.Index(rendered, "tail")
	if !(gi < di && di < ti) {
		t.Fatalf("skills list should render at the placeholder position, got %q", rendered)
	}
}

func TestSkillsAppendAtEndWhenNoPlaceholder(t *testing.T) {
	profile := Profile{
		ID:     "default",
		Prompt: []byte("body without placeholder"),
	}
	skills := []skill.Info{{Name: "debug", Description: "debugging"}}

	rendered := string(profile.Render("C:/repo", nil, skills))
	if !strings.Contains(rendered, "## 当前可用 Skills") || !strings.Contains(rendered, "debugging") {
		t.Fatalf("expected skills appended at end for templates without placeholder, got %q", rendered)
	}
}

func TestEmbeddedDefaultPromptSubstitutesSkillsPlaceholder(t *testing.T) {
	registry := DefaultProfileRegistry(prompts.DefaultPrompt)
	rendered := string(registry.Select("").Render("C:/repo", nil, []skill.Info{
		{Name: "piercode-debug", Description: "diagnose runtime failures"},
	}))
	if strings.Contains(rendered, skillsPlaceholder) {
		t.Fatalf("embedded prompt left an unsubstituted {{SKILLS}} placeholder")
	}
	if !strings.Contains(rendered, "piercode-debug") {
		t.Fatalf("embedded prompt should render the injected skills, got tail %q", tail(rendered))
	}
}

func tail(s string) string {
	if len(s) > 400 {
		return s[len(s)-400:]
	}
	return s
}

func TestProfileEmptyFiltersExposeNothing(t *testing.T) {
	profile := Profile{
		ID:         "locked",
		Prompt:     []byte("{{TOOLS}}"),
		ToolNames:  []string{},
		SkillNames: []string{},
	}

	if got := profile.FilterTools([]tool.ToolInfo{{Name: "read_file"}}); len(got) != 0 {
		t.Fatalf("expected no tools, got %#v", got)
	}
	if got := profile.FilterSkills([]skill.Info{{Name: "debug"}}); len(got) != 0 {
		t.Fatalf("expected no skills, got %#v", got)
	}
}
