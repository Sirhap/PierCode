package prompt

import (
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
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
